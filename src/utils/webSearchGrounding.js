/**
 * Web Search Grounding 模块
 * 处理 Gemini googleSearch 工具返回的 grounding 数据，转换为 Claude 格式
 *
 * @author wangqiupei
 */

/**
 * 生成 server_tool_use ID
 * 格式：srvtoolu_随机字符串
 * @returns {string}
 */
export function makeSrvToolUseId() {
  return `srvtoolu_${Math.random().toString(36).slice(2, 26)}`;
}

/**
 * 将内容编码为 base64 格式的加密内容
 * 用于 encrypted_content 和 encrypted_index 字段
 * @param {Object} payload - 要编码的对象
 * @returns {string}
 */
function stableEncryptedContent(payload) {
  try {
    const json = JSON.stringify(payload);
    return Buffer.from(json, 'utf8').toString('base64');
  } catch {
    return '';
  }
}

/**
 * 将 Gemini groundingChunks 转换为 Claude web_search_result 格式
 * @param {Array} groundingChunks - Gemini 返回的 grounding chunks
 * @returns {Array} Claude 格式的搜索结果数组
 */
export function toWebSearchResults(groundingChunks = []) {
  return (groundingChunks || [])
    .map((chunk) => {
      const web = chunk?.web || {};
      const url = typeof web.uri === 'string' ? web.uri : '';
      const title = typeof web.title === 'string' ? web.title : (typeof web.domain === 'string' ? web.domain : '');
      return {
        type: 'web_search_result',
        title,
        url,
        encrypted_content: stableEncryptedContent({ url, title }),
        page_age: null,
      };
    })
    .filter((r) => r.url || r.title);
}

/**
 * 检查是否为 Vertex AI grounding 重定向 URL
 * @param {string} url - 要检查的 URL
 * @returns {boolean}
 */
function isVertexGroundingRedirectUrl(url) {
  return typeof url === 'string' && url.startsWith('https://vertexaisearch.cloud.google.com/grounding-api-redirect/');
}

/**
 * 解包 Google 重定向 URL，提取真实目标地址
 * @param {string} url - Google 重定向 URL
 * @returns {string} 真实目标 URL
 */
function unwrapGoogleRedirectUrl(url) {
  if (typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) return url;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!(host === 'google.com' || host.endsWith('.google.com'))) return url;
    if (!u.pathname.endsWith('/url')) return url;
    const target = u.searchParams.get('q') || u.searchParams.get('url') || '';
    if (!target) return url;
    try {
      return decodeURIComponent(target);
    } catch {
      return target;
    }
  } catch {
    return url;
  }
}

/**
 * 获取 URL 的最终重定向地址
 * 支持多次重定向跟踪（最多 5 次）
 * @param {string} url - 初始 URL
 * @param {number} timeoutMs - 超时时间（毫秒）
 * @returns {Promise<string>} 最终 URL
 */
async function fetchFinalUrl(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = isVertexGroundingRedirectUrl(url)
      ? {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        }
      : undefined;

    const getNextLocation = async (currentUrl, method) => {
      try {
        const res = await fetch(currentUrl, {
          method,
          redirect: 'manual',
          signal: controller.signal,
          headers,
        });
        const status = Number(res?.status) || 0;
        const location = String(res?.headers?.get?.('location') || '').trim();
        try {
          if (res?.body?.cancel) await res.body.cancel();
        } catch { /* ignore */ }
        try {
          if (res?.body?.destroy) res.body.destroy();
        } catch { /* ignore */ }
        if (status >= 300 && status < 400 && location) {
          const resolved = new URL(location, currentUrl).toString();
          return unwrapGoogleRedirectUrl(resolved);
        }
      } catch {
        // ignore
      }
      return '';
    };

    let current = url;
    for (let i = 0; i < 5; i++) {
      const next = (await getNextLocation(current, 'HEAD')) || (await getNextLocation(current, 'GET'));
      if (!next || next === current) break;
      current = next;
    }

    return current;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Vertex 重定向 URL 缓存，避免重复解析
const resolvedRedirectUrlCache = new Map();

/**
 * 解析 Vertex AI grounding 重定向 URL 为真实 URL
 * 带缓存机制，避免重复请求
 * @param {string} url - Vertex 重定向 URL
 * @returns {Promise<string>} 真实 URL
 */
async function resolveVertexGroundingRedirectUrl(url) {
  if (!isVertexGroundingRedirectUrl(url)) return url;
  const cached = resolvedRedirectUrlCache.get(url);
  if (typeof cached === 'string') return cached;
  if (cached && typeof cached.then === 'function') return cached;

  const promise = (async () => {
    const finalUrl = await fetchFinalUrl(url, 5000);
    return finalUrl;
  })();

  resolvedRedirectUrlCache.set(url, promise);
  try {
    const finalUrl = await promise;
    resolvedRedirectUrlCache.set(url, finalUrl);
    // 缓存大小限制，超过 2000 条时清空
    if (resolvedRedirectUrlCache.size > 2000) resolvedRedirectUrlCache.clear();
    return finalUrl;
  } catch {
    resolvedRedirectUrlCache.delete(url);
    return url;
  }
}

/**
 * 批量解析 Web Search 结果中的重定向 URL
 * @param {Object} webSearch - 包含 results 数组的对象
 */
export async function resolveWebSearchRedirectUrls(webSearch) {
  const results = Array.isArray(webSearch?.results) ? webSearch.results : [];
  if (results.length === 0) return;

  // 并行解析所有重定向 URL
  await Promise.all(
    results.map(async (result) => {
      if (!result || typeof result.url !== 'string' || !result.url) return;
      if (!isVertexGroundingRedirectUrl(result.url)) return;
      const finalUrl = await resolveVertexGroundingRedirectUrl(result.url);
      if (finalUrl && finalUrl !== result.url) {
        result.url = finalUrl;
        result.encrypted_content = stableEncryptedContent({ url: result.url, title: result.title });
      }
    })
  );
}

/**
 * 从 groundingSupport 构建 citations 引用
 * @param {Array} results - 搜索结果数组
 * @param {Object} support - grounding support 对象
 * @returns {Array} citations 数组
 */
export function buildCitationsFromSupport(results, support) {
  const cited_text = support?.segment?.text;
  if (typeof cited_text !== 'string' || cited_text.length === 0) return [];

  const indices = Array.isArray(support?.groundingChunkIndices) ? support.groundingChunkIndices : [];
  const citations = [];
  for (const idx of indices) {
    if (typeof idx !== 'number') continue;
    const result = results[idx];
    if (!result) continue;
    citations.push({
      type: 'web_search_result_location',
      cited_text,
      url: result.url,
      title: result.title,
      encrypted_index: stableEncryptedContent({ url: result.url, title: result.title, cited_text }),
    });
  }
  return citations;
}

/**
 * 构建非流式 Web Search 响应消息
 * 将 Gemini grounding 响应转换为 Claude 格式
 * @param {Object} rawJSON - Gemini 原始响应
 * @param {Object} options - 选项（包含 overrideModel 等）
 * @param {Function} toClaudeUsage - usage 转换函数
 * @returns {Promise<Object>} Claude 格式的响应消息
 */
export async function buildNonStreamingWebSearchMessage(rawJSON, options, toClaudeUsage) {
  const candidate = rawJSON?.candidates?.[0] || {};
  const parts = candidate?.content?.parts || [];
  const groundingMetadata = candidate?.groundingMetadata || {};

  // 提取搜索查询
  const query =
    Array.isArray(groundingMetadata.webSearchQueries) && typeof groundingMetadata.webSearchQueries[0] === 'string'
      ? groundingMetadata.webSearchQueries[0]
      : '';

  // 提取搜索结果
  const groundingChunks = Array.isArray(candidate.groundingChunks) ? candidate.groundingChunks : groundingMetadata.groundingChunks;
  const results = toWebSearchResults(Array.isArray(groundingChunks) ? groundingChunks : []);

  // 提取引用支持
  const groundingSupports = Array.isArray(candidate.groundingSupports) ? candidate.groundingSupports : groundingMetadata.groundingSupports;
  const supports = Array.isArray(groundingSupports) ? groundingSupports : [];

  // 解析重定向 URL
  await resolveWebSearchRedirectUrls({ results });

  // 分离 thinking 和普通文本
  const thinkingText = parts
    .filter((p) => p?.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');

  const answerText = parts
    .filter((p) => !p?.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');

  const toolUseId = makeSrvToolUseId();

  // 构建 content 数组
  const content = [];

  // 添加 thinking 块（如果有）
  if (thinkingText) {
    content.push({ type: 'thinking', thinking: thinkingText });
  }

  // 添加 server_tool_use 块
  content.push({
    type: 'server_tool_use',
    id: toolUseId,
    name: 'web_search',
    input: { query },
  });

  // 添加 web_search_tool_result 块
  content.push({
    type: 'web_search_tool_result',
    tool_use_id: toolUseId,
    content: results,
  });

  // 添加 citations 块（每个 support 生成一个）
  for (const support of supports) {
    const citations = buildCitationsFromSupport(results, support);
    if (!citations.length) continue;
    content.push({ type: 'text', text: '', citations });
  }

  // 添加最终回答文本
  if (answerText) {
    content.push({ type: 'text', text: answerText });
  }

  // 确定停止原因
  const finish = candidate?.finishReason;
  const stopReason = finish === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';

  // 转换 usage
  const usage = typeof toClaudeUsage === 'function' ? toClaudeUsage(rawJSON.usageMetadata || {}) : undefined;

  return {
    id: rawJSON.responseId || '',
    type: 'message',
    role: 'assistant',
    model: options?.overrideModel || rawJSON.modelVersion || '',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usage ? { ...usage, server_tool_use: { web_search_requests: 1 } } : { server_tool_use: { web_search_requests: 1 } },
  };
}

/**
 * 流式模式下发送 Web Search 相关的事件块
 * @param {Object} state - 流式状态对象
 * @param {Function} emitEvent - 发送事件的函数
 */
export function emitWebSearchBlocks(state, emitEvent) {
  if (!state || !emitEvent) return;

  const toolUseId = state.webSearch.toolUseId || makeSrvToolUseId();
  state.webSearch.toolUseId = toolUseId;

  // 发送 server_tool_use 块
  emitEvent('content_block_start', {
    type: 'content_block_start',
    index: state.contentIndex,
    content_block: {
      type: 'server_tool_use',
      id: toolUseId,
      name: 'web_search',
      input: {},
    },
  });

  const query = typeof state.webSearch.query === 'string' ? state.webSearch.query : '';
  emitEvent('content_block_delta', {
    type: 'content_block_delta',
    index: state.contentIndex,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) },
  });
  emitEvent('content_block_stop', {
    type: 'content_block_stop',
    index: state.contentIndex,
  });
  state.contentIndex++;

  // 发送 web_search_tool_result 块
  emitEvent('content_block_start', {
    type: 'content_block_start',
    index: state.contentIndex,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: toolUseId,
      content: Array.isArray(state.webSearch.results) ? state.webSearch.results : [],
    },
  });
  emitEvent('content_block_stop', {
    type: 'content_block_stop',
    index: state.contentIndex,
  });
  state.contentIndex++;

  // 发送 citations 块
  const results = Array.isArray(state.webSearch.results) ? state.webSearch.results : [];
  const supports = Array.isArray(state.webSearch.supports) ? state.webSearch.supports : [];
  for (const support of supports) {
    const citations = buildCitationsFromSupport(results, support);
    if (!citations.length) continue;
    emitEvent('content_block_start', {
      type: 'content_block_start',
      index: state.contentIndex,
      content_block: { type: 'text', text: '', citations: [] },
    });
    for (const citation of citations) {
      emitEvent('content_block_delta', {
        type: 'content_block_delta',
        index: state.contentIndex,
        delta: { type: 'citations_delta', citation },
      });
    }
    emitEvent('content_block_stop', {
      type: 'content_block_stop',
      index: state.contentIndex,
    });
    state.contentIndex++;
  }

  // 发送缓冲的文本内容
  emitEvent('content_block_start', {
    type: 'content_block_start',
    index: state.contentIndex,
    content_block: { type: 'text', text: '' },
  });
  for (const text of state.webSearch.bufferedTextParts) {
    if (!text) continue;
    emitEvent('content_block_delta', {
      type: 'content_block_delta',
      index: state.contentIndex,
      delta: { type: 'text_delta', text },
    });
  }
  emitEvent('content_block_stop', {
    type: 'content_block_stop',
    index: state.contentIndex,
  });
  state.contentIndex++;
}

/**
 * 检查响应是否包含 Web Search grounding 数据
 * 注意：仅检查属性存在是不够的，必须检查是否有实际内容
 * 否则当配置了 googleSearch 工具但 Gemini 未执行搜索时，
 * 可能返回空的 groundingMetadata 对象导致误判
 * @param {Object} candidate - Gemini 响应的 candidate 对象
 * @returns {boolean}
 */
export function hasGroundingData(candidate) {
  if (!candidate) return false;

  const meta = candidate.groundingMetadata;
  const chunks = candidate.groundingChunks;
  const supports = candidate.groundingSupports;

  // 检查 groundingMetadata 是否有实际内容
  if (meta && typeof meta === 'object') {
    // 有搜索查询表示确实执行了搜索
    if (Array.isArray(meta.webSearchQueries) && meta.webSearchQueries.length > 0) return true;
    // 有搜索结果块
    if (Array.isArray(meta.groundingChunks) && meta.groundingChunks.length > 0) return true;
    // 有引用支持
    if (Array.isArray(meta.groundingSupports) && meta.groundingSupports.length > 0) return true;
  }

  // 检查顶层 grounding 数组（某些响应格式可能直接放在 candidate 下）
  if (Array.isArray(chunks) && chunks.length > 0) return true;
  if (Array.isArray(supports) && supports.length > 0) return true;

  return false;
}

/**
 * 从 candidate 中提取 grounding 相关数据
 * @param {Object} candidate - Gemini 响应的 candidate 对象
 * @returns {Object} 包含 query, results, supports 的对象
 */
export function extractGroundingData(candidate) {
  const groundingMetadata = candidate?.groundingMetadata || {};

  // 提取搜索查询
  const webSearchQueries = groundingMetadata?.webSearchQueries;
  const query = Array.isArray(webSearchQueries) && typeof webSearchQueries[0] === 'string'
    ? webSearchQueries[0]
    : '';

  // 提取搜索结果
  const groundingChunks = Array.isArray(candidate?.groundingChunks)
    ? candidate.groundingChunks
    : groundingMetadata?.groundingChunks;
  const results = toWebSearchResults(Array.isArray(groundingChunks) ? groundingChunks : []);

  // 提取引用支持
  const groundingSupports = Array.isArray(candidate?.groundingSupports)
    ? candidate.groundingSupports
    : groundingMetadata?.groundingSupports;
  const supports = Array.isArray(groundingSupports) ? groundingSupports : [];

  return { query, results, supports };
}
