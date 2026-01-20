import memoryManager, { registerMemoryPoolCleanup } from '../utils/memoryManager.js';
import { generateToolCallId } from '../utils/idGenerator.js';
import { setSignature, shouldCacheSignature, isImageModel } from '../utils/thoughtSignatureCache.js';
import { getOriginalToolName } from '../utils/toolNameCache.js';
import { hasGroundingData, extractGroundingData } from '../utils/webSearchGrounding.js';
import config from '../config/config.js';

// 预编译的常量（避免重复创建字符串）
const DATA_PREFIX = 'data: ';
const DATA_PREFIX_LEN = DATA_PREFIX.length;

// 高效的行分割器（零拷贝，避免 split 创建新数组）
// 使用对象池复用 LineBuffer 实例
class LineBuffer {
  constructor() {
    this.buffer = '';
    this.lines = [];
  }
  
  // 追加数据并返回完整的行
  append(chunk) {
    this.buffer += chunk;
    this.lines.length = 0; // 重用数组
    
    let start = 0;
    let end;
    while ((end = this.buffer.indexOf('\n', start)) !== -1) {
      this.lines.push(this.buffer.slice(start, end));
      start = end + 1;
    }
    
    // 保留未完成的部分
    this.buffer = start < this.buffer.length ? this.buffer.slice(start) : '';
    return this.lines;
  }
  
  clear() {
    this.buffer = '';
    this.lines.length = 0;
  }
}

// LineBuffer 对象池
const lineBufferPool = [];
const getLineBuffer = () => {
  const buffer = lineBufferPool.pop();
  if (buffer) {
    buffer.clear();
    return buffer;
  }
  return new LineBuffer();
};
const releaseLineBuffer = (buffer) => {
  const maxSize = memoryManager.getPoolSizes().lineBuffer;
  if (lineBufferPool.length < maxSize) {
    buffer.clear();
    lineBufferPool.push(buffer);
  }
};

// toolCall 对象池
const toolCallPool = [];
const getToolCallObject = () => toolCallPool.pop() || { id: '', type: 'function', function: { name: '', arguments: '' } };
const releaseToolCallObject = (obj) => {
  const maxSize = memoryManager.getPoolSizes().toolCall;
  if (toolCallPool.length < maxSize) toolCallPool.push(obj);
};

// 注册内存清理回调（供外部统一调用）
function registerStreamMemoryCleanup() {
  registerMemoryPoolCleanup(toolCallPool, () => memoryManager.getPoolSizes().toolCall);
  registerMemoryPoolCleanup(lineBufferPool, () => memoryManager.getPoolSizes().lineBuffer);
}

// 转换 functionCall 为 OpenAI 格式（使用对象池）
// 会尝试将安全工具名还原为原始工具名
function convertToToolCall(functionCall, sessionId, model) {
  const toolCall = getToolCallObject();
  toolCall.id = functionCall.id || generateToolCallId();
  let name = functionCall.name;
  if (model) {
    const original = getOriginalToolName(model, functionCall.name);
    if (original) name = original;
  }
  toolCall.function.name = name;
  toolCall.function.arguments = JSON.stringify(functionCall.args);
  return toolCall;
}

// 解析并发送流式响应片段（会修改 state 并触发 callback）
// 支持 DeepSeek 格式：思维链内容通过 reasoning_content 字段输出
// 同时透传 thoughtSignature，方便客户端后续复用
// 签名和思考内容绑定存储：收集完整思考内容后和签名一起缓存
// 支持 Web Search：检测 grounding 数据并进入 Web Search 模式
function parseAndEmitStreamChunk(line, state, callback) {
  if (!line.startsWith(DATA_PREFIX)) return;

  try {
    const data = JSON.parse(line.slice(DATA_PREFIX_LEN));
    const candidate = data.response?.candidates?.[0];
    const parts = candidate?.content?.parts;

    // 检测 Web Search grounding 数据
    if (hasGroundingData(candidate)) {
      // 进入 Web Search 模式
      if (!state.webSearchMode) {
        state.webSearchMode = true;
        state.webSearch = {
          toolUseId: null,
          query: '',
          results: [],
          supports: [],
          bufferedTextParts: []
        };
      }

      // 提取 grounding 数据（通常在最后一个 chunk 才完整出现）
      const groundingData = extractGroundingData(candidate);
      if (groundingData.query) {
        state.webSearch.query = groundingData.query;
      }
      if (groundingData.results && groundingData.results.length > 0) {
        state.webSearch.results = groundingData.results;
      }
      if (groundingData.supports && groundingData.supports.length > 0) {
        state.webSearch.supports = groundingData.supports;
      }
    }

    if (parts) {
      for (const part of parts) {
        if (part.thoughtSignature) {
          // Gemini 等模型可能只在 functionCall part 上给出 thoughtSignature；
          // 将其视为本轮"最新签名"，用于后续 functionCall 兜底与下次请求缓存。
          if (part.thoughtSignature !== state.reasoningSignature) {
            state.reasoningSignature = part.thoughtSignature;
            // 延迟缓存：等收集完思考内容后再缓存
          }
        }

        if (part.thought === true) {
          // 累积思考内容
          if (part.text) {
            state.reasoningContent = (state.reasoningContent || '') + part.text;
          }

          if (part.thoughtSignature) {
            state.reasoningSignature = part.thoughtSignature;
            // 延迟到流结束时缓存，确保收集到完整的思考内容
          }
          callback({
            type: 'reasoning',
            reasoning_content: part.text || '',
            thoughtSignature: part.thoughtSignature || state.reasoningSignature || null
          });
        } else if (part.text !== undefined) {
          // Web Search 模式：缓冲非 thinking 文本，在结束时统一输出
          if (state.webSearchMode) {
            state.webSearch.bufferedTextParts.push(part.text);
          } else {
            callback({ type: 'text', content: part.text });
          }
        } else if (part.functionCall) {
          const toolCall = convertToToolCall(part.functionCall, state.sessionId, state.model);
          const sig = part.thoughtSignature || state.reasoningSignature || null;
          if (sig) {
            toolCall.thoughtSignature = sig;
            // 标记有工具调用
            state.hasToolCalls = true;
          }
          state.toolCalls.push(toolCall);
        }
      }
    }

    if (candidate?.finishReason) {
      // 流结束时，判断是否应该缓存签名
      const hasTools = state.hasToolCalls || state.toolCalls.length > 0;
      const isImage = isImageModel(state.model);

      // 注意：GeminiCLI 不使用 sessionId，但签名缓存仍然应该工作
      // sessionId 参数在 thoughtSignatureCache.js 中已不再用于缓存 key
      if (state.model && state.reasoningSignature) {
        if (shouldCacheSignature({ hasTools, isImageModel: isImage })) {
          const content = state.reasoningContent || ' ';
          setSignature(state.sessionId, state.model, state.reasoningSignature, content, { hasTools, isImageModel: isImage });
        }
      }

      // Web Search 模式：发送 grounding 数据事件
      if (state.webSearchMode && state.webSearch) {
        callback({
          type: 'web_search',
          webSearch: state.webSearch
        });
        // 重置 Web Search 状态
        state.webSearchMode = false;
        state.webSearch = null;
      }

      if (state.toolCalls.length > 0) {
        callback({ type: 'tool_calls', tool_calls: state.toolCalls });
        state.toolCalls = [];
      }
      const usage = data.response?.usageMetadata;
      if (usage) {
        callback({
          type: 'usage',
          usage: {
            prompt_tokens: usage.promptTokenCount || 0,
            completion_tokens: usage.candidatesTokenCount || 0,
            total_tokens: usage.totalTokenCount || 0
          }
        });
      }
      // 清空累积的思考内容和状态
      state.reasoningContent = '';
      state.hasToolCalls = false;
    }
  } catch {
    // 忽略 JSON 解析错误
  }
}

export {
  getLineBuffer,
  releaseLineBuffer,
  parseAndEmitStreamChunk,
  convertToToolCall,
  registerStreamMemoryCleanup,
  releaseToolCallObject
};
