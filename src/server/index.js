import express from 'express';
import { generateAssistantResponse, generateAssistantResponseNoStream, getAvailableModels, closeRequester } from '../api/client.js';
import { generateRequestBody } from '../utils/utils.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';

const app = express();

// 工具函数：生成响应元数据
const createResponseMeta = () => ({
  id: `chatcmpl-${Date.now()}`,
  created: Math.floor(Date.now() / 1000)
});

// 工具函数：设置流式响应头
const setStreamHeaders = (res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
};

// 工具函数：构建流式数据块
const createStreamChunk = (id, created, model, delta, finish_reason = null) => ({
  id,
  object: 'chat.completion.chunk',
  created,
  model,
  choices: [{ index: 0, delta, finish_reason }]
});

// 工具函数：写入流式数据
const writeStreamData = (res, data) => {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

// 工具函数：结束流式响应
const endStream = (res, id, created, model, finish_reason) => {
  writeStreamData(res, createStreamChunk(id, created, model, {}, finish_reason));
  res.write('data: [DONE]\n\n');
  res.end();
};

app.use(express.json({ limit: config.security.maxRequestSize }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `请求体过大，最大支持 ${config.security.maxRequestSize}` });
  }
  next(err);
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.request(req.method, req.path, res.statusCode, Date.now() - start);
  });
  next();
});

app.use((req, res, next) => {
  if (req.path.startsWith('/v1/')) {
    const apiKey = config.security?.apiKey;
    if (apiKey) {
      const authHeader = req.headers.authorization;
      const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
      if (providedKey !== apiKey) {
        logger.warn(`API Key 验证失败: ${req.method} ${req.path}`);
        return res.status(401).json({ error: 'Invalid API Key' });
      }
    }
  }
  next();
});

app.get('/v1/models', async (req, res) => {
  try {
    const models = await getAvailableModels();
    res.json(models);
  } catch (error) {
    logger.error('获取模型列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/v1/chat/completions', async (req, res) => {
  const { messages, model, stream = true, tools, ...params} = req.body;
  try {
    if (!messages) {
      return res.status(400).json({ error: 'messages is required' });
    }
    
    const isImageModel = model.includes('-image');
    const requestBody = await generateRequestBody(messages, model, params, tools);
    if (isImageModel) {
      requestBody.request.generationConfig={
        candidateCount: 1,
        // imageConfig:{
        //   aspectRatio: "1:1"
        // }
      }
      requestBody.requestType="image_gen";
      //delete requestBody.request.systemInstruction;
      delete requestBody.request.tools;
      delete requestBody.request.toolConfig;
    }
    //console.log(JSON.stringify(requestBody,null,2))
    
    const { id, created } = createResponseMeta();
    
    if (stream && !isImageModel) {
      setStreamHeaders(res);
      let hasToolCall = false;
      
      await generateAssistantResponse(requestBody, (data) => {
        const delta = data.type === 'tool_calls' 
          ? { tool_calls: data.tool_calls } 
          : { content: data.content };
        if (data.type === 'tool_calls') hasToolCall = true;
        writeStreamData(res, createStreamChunk(id, created, model, delta));
      });
      
      endStream(res, id, created, model, hasToolCall ? 'tool_calls' : 'stop');
    } else if (stream && isImageModel) {
      setStreamHeaders(res);
      const { content } = await generateAssistantResponseNoStream(requestBody);
      writeStreamData(res, createStreamChunk(id, created, model, { content }));
      endStream(res, id, created, model, 'stop');
    } else {
      const { content, toolCalls } = await generateAssistantResponseNoStream(requestBody);
      const message = { role: 'assistant', content };
      if (toolCalls.length > 0) message.tool_calls = toolCalls;
      
      res.json({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
        }]
      });
    }
  } catch (error) {
    logger.error('生成响应失败:', error.message);
    if (!res.headersSent) {
      const { id, created } = createResponseMeta();
      const errorContent = `错误: ${error.message}`;
      
      if (stream) {
        setStreamHeaders(res);
        writeStreamData(res, createStreamChunk(id, created, model, { content: errorContent }));
        endStream(res, id, created, model, 'stop');
      } else {
        res.json({
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: errorContent },
            finish_reason: 'stop'
          }]
        });
      }
    }
  }
});

const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(`服务器已启动: ${config.server.host}:${config.server.port}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`端口 ${config.server.port} 已被占用`);
    process.exit(1);
  } else if (error.code === 'EACCES') {
    logger.error(`端口 ${config.server.port} 无权限访问`);
    process.exit(1);
  } else {
    logger.error('服务器启动失败:', error.message);
    process.exit(1);
  }
});

const shutdown = () => {
  logger.info('正在关闭服务器...');
  closeRequester();
  server.close(() => {
    logger.info('服务器已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
