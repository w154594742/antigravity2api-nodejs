/**
 * Claude/Anthropic 响应格式化工具
 */

import { makeSrvToolUseId, buildCitationsFromSupport } from '../../utils/webSearchGrounding.js';

/**
 * 创建 Claude 非流式响应
 * @param {string} id
 * @param {string} model
 * @param {string|null} content
 * @param {string|null} reasoning
 * @param {string|null} reasoningSignature
 * @param {Array|null} toolCalls
 * @param {string} stopReason
 * @param {Object|null} usage
 * @param {{passSignatureToClient?: boolean, webSearchData?: Object}} options
 * @returns {Object}
 */
export const createClaudeResponse = (
  id,
  model,
  content,
  reasoning,
  reasoningSignature,
  toolCalls,
  stopReason,
  usage,
  options = {}
) => {
  const passSignatureToClient = options.passSignatureToClient === true;
  const webSearchData = options.webSearchData || null;

  const contentBlocks = [];

  // 添加 thinking 块
  if (reasoning) {
    const thinkingBlock = {
      type: 'thinking',
      thinking: reasoning
    };
    if (reasoningSignature && passSignatureToClient) {
      thinkingBlock.signature = reasoningSignature;
    }
    contentBlocks.push(thinkingBlock);
  }

  // Web Search 响应：添加 server_tool_use、web_search_tool_result 和 citations 块
  if (webSearchData) {
    const toolUseId = makeSrvToolUseId();

    // server_tool_use 块
    contentBlocks.push({
      type: 'server_tool_use',
      id: toolUseId,
      name: 'web_search',
      input: { query: webSearchData.query || '' }
    });

    // web_search_tool_result 块
    contentBlocks.push({
      type: 'web_search_tool_result',
      tool_use_id: toolUseId,
      content: Array.isArray(webSearchData.results) ? webSearchData.results : []
    });

    // citations 块
    const results = Array.isArray(webSearchData.results) ? webSearchData.results : [];
    const supports = Array.isArray(webSearchData.supports) ? webSearchData.supports : [];
    for (const support of supports) {
      const citations = buildCitationsFromSupport(results, support);
      if (!citations.length) continue;
      contentBlocks.push({
        type: 'text',
        text: '',
        citations
      });
    }
  }

  // 添加文本内容块
  if (content) {
    contentBlocks.push({
      type: 'text',
      text: content
    });
  }

  // 添加工具调用块
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      try {
        const inputObj = JSON.parse(tc.function.arguments);
        const toolBlock = {
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: inputObj
        };
        if (tc.thoughtSignature && passSignatureToClient) {
          toolBlock.signature = tc.thoughtSignature;
        }
        contentBlocks.push(toolBlock);
      } catch {
        contentBlocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: {}
        });
      }
    }
  }

  // 构建 usage 对象
  const usageObj = usage
    ? {
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0
      }
    : { input_tokens: 0, output_tokens: 0 };

  // Web Search 响应需要添加 server_tool_use 统计
  if (webSearchData) {
    usageObj.server_tool_use = { web_search_requests: 1 };
  }

  return {
    id,
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usageObj
  };
};
