// 测试思维签名相关逻辑：当无签名时不应创建 thought part
import { generateRequestBody } from '../src/utils/converters/openai.js';
import { generateClaudeRequestBody } from '../src/utils/converters/claude.js';
import { generateGeminiRequestBody } from '../src/utils/converters/gemini.js';
import config from '../src/config/config.js';

// 保存原始配置
const originalUseCachedSignature = config.useCachedSignature;
const originalUseFallbackSignature = config.useFallbackSignature;

// 模拟 token 对象
const mockToken = {
  sessionId: 'test-session-no-signature',
  projectId: 'test-project',
};

console.log('\n=== 测试场景：无签名时不应创建 thought part ===\n');

// 测试 1: OpenAI 格式转换（无签名）
console.log('测试 1: OpenAI 格式转换（无签名）');
config.useCachedSignature = false;
config.useFallbackSignature = false;

const openaiMessages = [
  {
    role: 'user',
    content: 'Hello'
  },
  {
    role: 'assistant',
    content: 'Hi there!',
    reasoning_content: 'This is some reasoning'
  }
];

const openaiResult = generateRequestBody(openaiMessages, 'claude-sonnet-4-5', {}, [], mockToken);
const openaiContents = openaiResult.request.contents;

console.log('OpenAI 转换结果:');
console.log(JSON.stringify(openaiContents, null, 2));

// 验证：第二条消息（model role）不应包含 thought part
const modelMessage = openaiContents.find(m => m.role === 'model');
const hasThoughtPart = modelMessage?.parts?.some(p => p.thought === true);
console.log(`✓ Model message 不应包含 thought part: ${!hasThoughtPart ? '✓ PASS' : '✗ FAIL'}`);

// 测试 2: Claude 格式转换（无签名）
console.log('\n测试 2: Claude 格式转换（无签名）');

const claudeMessages = [
  {
    role: 'user',
    content: 'Hello'
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        text: 'Some thinking'
      },
      {
        type: 'text',
        text: 'Response text'
      }
    ]
  }
];

const claudeResult = generateClaudeRequestBody(claudeMessages, 'claude-sonnet-4-5', {}, [], '', mockToken);
const claudeContents = claudeResult.request.contents;

console.log('Claude 转换结果:');
console.log(JSON.stringify(claudeContents, null, 2));

const claudeModelMessage = claudeContents.find(m => m.role === 'model');
const claudeHasThoughtPart = claudeModelMessage?.parts?.some(p => p.thought === true);
console.log(`✓ Model message 不应包含 thought part: ${!claudeHasThoughtPart ? '✓ PASS' : '✗ FAIL'}`);

// 测试 3: Gemini 格式转换（无签名）
console.log('\n测试 3: Gemini 格式转换（无签名）');

const geminiBody = {
  contents: [
    {
      role: 'user',
      parts: [{ text: 'Hello' }]
    },
    {
      role: 'model',
      parts: [{ text: 'Response' }]
    }
  ]
};

const geminiResult = generateGeminiRequestBody(geminiBody, 'claude-sonnet-4-5', mockToken);
const geminiContents = geminiResult.request.contents;

console.log('Gemini 转换结果:');
console.log(JSON.stringify(geminiContents, null, 2));

const geminiModelMessage = geminiContents.find(m => m.role === 'model');
const geminiHasThoughtPart = geminiModelMessage?.parts?.some(p => p.thought === true);
console.log(`✓ Model message 不应包含 thought part: ${!geminiHasThoughtPart ? '✓ PASS' : '✗ FAIL'}`);

// 测试 4: 验证有签名时仍能正常工作（使用思考模型）
console.log('\n测试 4: 验证有签名时仍能正常工作（启用兜底签名 + 思考模型）');
config.useFallbackSignature = true;

// 使用明确的思考模型
const thinkingModelName = 'claude-opus-4-5-thinking';
const openaiResultWithSig = generateRequestBody(openaiMessages, thinkingModelName, {}, [], mockToken);
const openaiContentsWithSig = openaiResultWithSig.request.contents;

console.log('OpenAI 转换结果（有签名）:');
console.log(JSON.stringify(openaiContentsWithSig, null, 2));

const modelMessageWithSig = openaiContentsWithSig.find(m => m.role === 'model');
const hasThoughtPartWithSig = modelMessageWithSig?.parts?.some(p => p.thought === true && p.thoughtSignature);
console.log(`✓ Model message 应包含带签名的 thought part: ${hasThoughtPartWithSig ? '✓ PASS' : '✗ FAIL (expected behavior for non-thinking models)'}`);

// 测试 5: 使用 Gemini 直接验证有签名的情况
console.log('\n测试 5: Gemini 格式有签名测试（启用兜底签名）');
const geminiBodyWithThinking = {
  contents: [
    {
      role: 'user',
      parts: [{ text: 'Hello' }]
    },
    {
      role: 'model',
      parts: [{ text: 'Response' }]
    }
  ]
};

const geminiResultWithSig = generateGeminiRequestBody(geminiBodyWithThinking, thinkingModelName, mockToken);
const geminiContentsWithSig = geminiResultWithSig.request.contents;

console.log('Gemini 转换结果（有签名）:');
console.log(JSON.stringify(geminiContentsWithSig, null, 2));

const geminiModelMessageWithSig = geminiContentsWithSig.find(m => m.role === 'model');
const geminiHasThoughtPartWithSig = geminiModelMessageWithSig?.parts?.some(p => p.thought === true && p.thoughtSignature);
console.log(`✓ Model message 应包含带签名的 thought part: ${geminiHasThoughtPartWithSig ? '✓ PASS' : '✗ FAIL'}`);

// 恢复原始配置
config.useCachedSignature = originalUseCachedSignature;
config.useFallbackSignature = originalUseFallbackSignature;

console.log('\n=== 测试完成 ===\n');
