import express from 'express';
import { generateToken, authMiddleware } from '../auth/jwt.js';
import tokenManager from '../auth/token_manager.js';
import config, { getConfigJson, saveConfigJson } from '../config/config.js';
import logger from '../utils/logger.js';
import { generateProjectId } from '../utils/idGenerator.js';
import { parseEnvFile, updateEnvFile } from '../utils/envParser.js';
import { reloadConfig } from '../utils/configReloader.js';
import { OAUTH_CONFIG } from '../constants/oauth.js';
import { deepMerge } from '../utils/deepMerge.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '../../.env');

const router = express.Router();

// 登录接口
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  
  if (username === config.admin.username && password === config.admin.password) {
    const token = generateToken({ username, role: 'admin' });
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, message: '用户名或密码错误' });
  }
});

// Token管理API - 需要JWT认证
router.get('/tokens', authMiddleware, (req, res) => {
  const tokens = tokenManager.getTokenList();
  res.json({ success: true, data: tokens });
});

router.post('/tokens', authMiddleware, (req, res) => {
  const { access_token, refresh_token, expires_in, timestamp, enable, projectId } = req.body;
  if (!access_token || !refresh_token) {
    return res.status(400).json({ success: false, message: 'access_token和refresh_token必填' });
  }
  const tokenData = { access_token, refresh_token, expires_in };
  if (timestamp) tokenData.timestamp = timestamp;
  if (enable !== undefined) tokenData.enable = enable;
  if (projectId) tokenData.projectId = projectId;
  
  const result = tokenManager.addToken(tokenData);
  res.json(result);
});

router.put('/tokens/:refreshToken', authMiddleware, (req, res) => {
  const { refreshToken } = req.params;
  const updates = req.body;
  const result = tokenManager.updateToken(refreshToken, updates);
  res.json(result);
});

router.delete('/tokens/:refreshToken', authMiddleware, (req, res) => {
  const { refreshToken } = req.params;
  const result = tokenManager.deleteToken(refreshToken);
  res.json(result);
});

router.post('/tokens/reload', authMiddleware, async (req, res) => {
  try {
    await tokenManager.reload();
    res.json({ success: true, message: 'Token已热重载' });
  } catch (error) {
    logger.error('热重载失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/oauth/exchange', authMiddleware, async (req, res) => {
  const { code, port } = req.body;
  if (!code || !port) {
    return res.status(400).json({ success: false, message: 'code和port必填' });
  }
  
  try {
    const postData = new URLSearchParams({
      code,
      client_id: OAUTH_CONFIG.CLIENT_ID,
      client_secret: OAUTH_CONFIG.CLIENT_SECRET,
      redirect_uri: `http://localhost:${port}/oauth-callback`,
      grant_type: 'authorization_code'
    });
    
    const response = await fetch(OAUTH_CONFIG.TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: postData.toString()
    });
    
    const tokenData = await response.json();
    
    if (!tokenData.access_token) {
      return res.status(400).json({ success: false, message: 'Token交换失败' });
    }
    
    const account = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      timestamp: Date.now(),
      enable: true
    };
    
    if (config.skipProjectIdFetch) {
      account.projectId = generateProjectId();
      logger.info('使用随机生成的projectId: ' + account.projectId);
    } else {
      try {
        const projectId = await tokenManager.fetchProjectId(account);
        if (projectId === undefined) {
          return res.status(400).json({ success: false, message: '该账号无资格使用（无法获取projectId）' });
        }
        account.projectId = projectId;
        logger.info('账号验证通过，projectId: ' + projectId);
      } catch (error) {
        logger.error('验证账号资格失败:', error.message);
        return res.status(500).json({ success: false, message: '验证账号资格失败: ' + error.message });
      }
    }
    
    res.json({ success: true, data: account });
  } catch (error) {
    logger.error('Token交换失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取配置
router.get('/config', authMiddleware, (req, res) => {
  try {
    const envData = parseEnvFile(envPath);
    const jsonData = getConfigJson();
    res.json({ success: true, data: { env: envData, json: jsonData } });
  } catch (error) {
    logger.error('读取配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新配置
router.put('/config', authMiddleware, (req, res) => {
  try {
    const { env: envUpdates, json: jsonUpdates } = req.body;
    
    if (envUpdates) {
      updateEnvFile(envPath, envUpdates);
    }
    
    if (jsonUpdates) {
      const currentConfig = getConfigJson();
      const mergedConfig = deepMerge(currentConfig, jsonUpdates);
      saveConfigJson(mergedConfig);
    }
    
    dotenv.config({ override: true });
    reloadConfig();
    
    logger.info('配置已更新并热重载');
    res.json({ success: true, message: '配置已保存并生效（端口/HOST修改需重启）' });
  } catch (error) {
    logger.error('更新配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;