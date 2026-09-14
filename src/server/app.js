import express from 'express';
import cors from 'cors';
import path from 'path';
import { config } from '../config.js';
import { modelsRouter } from './routes/models.js';
import { chatRouter } from './routes/chat.js';
import { subagentRouter } from './routes/subagent.js';
import { tokensRouter } from './routes/tokens.js';
import { logsRouter } from './routes/logs.js';
import { statsRouter } from './routes/stats.js';
import { authRouter } from './routes/auth.js';
import { apiKeysRouter } from './routes/apiKeys.js';
import { authManager } from './authManager.js';
import { apiKeysManager } from './apiKeysManager.js';
import { logger } from './logger.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Request logger for API calls
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/logs') && !req.path.startsWith('/api/stats') && !req.path.endsWith('.css') && !req.path.endsWith('.js') && !req.path.endsWith('.ico')) {
      logger.addLog('request', `${req.method} ${req.path}`);
    }
    next();
  });

  // Serve static UI assets from public/
  const publicDir = path.resolve(config.projectRoot, 'public');
  app.use(express.static(publicDir));

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Register public auth APIs
  app.use(authRouter);

  // Protected dashboard APIs (requires dashboard authentication)
  app.use(['/api/tokens', '/v1/tokens'], authManager.requireDashboardAuth);
  app.use('/api/logs', authManager.requireDashboardAuth);
  app.use(['/api/stats', '/v1/stats'], authManager.requireDashboardAuth);
  app.use(['/api/keys', '/v1/api-keys'], authManager.requireDashboardAuth);

  // Register dashboard APIs
  app.use(tokensRouter);
  app.use(logsRouter);
  app.use(statsRouter);
  app.use(apiKeysRouter);

  // Client API key validation middleware for OpenAI endpoints
  const validateApiKeyMiddleware = (req, res, next) => {
    // If no custom API keys are defined, allow requests for backward compatibility
    if (!apiKeysManager.hasKeys()) {
      return next();
    }

    // Allow requests originating from authenticated Web Studio dashboard session
    const dashToken = authManager.extractToken(req);
    if (dashToken && authManager.isValidSession(dashToken)) {
      return next();
    }

    let clientKey = '';
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      clientKey = authHeader.slice(7).trim();
    } else if (req.headers['x-api-key']) {
      clientKey = String(req.headers['x-api-key']).trim();
    }

    const validation = apiKeysManager.validateKey(clientKey);
    if (validation.valid) {
      req.apiKey = validation.key;
      return next();
    }

    return res.status(401).json({
      error: {
        message: validation.reason || 'Incorrect or disabled API key provided.',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_api_key',
      },
    });
  };

  // Register OpenAI-compatible and subagent routes
  app.use(validateApiKeyMiddleware);
  app.use(modelsRouter);
  app.use(chatRouter);
  app.use(subagentRouter);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({
      error: {
        message: `Route ${req.method} ${req.path} not found`,
        type: 'invalid_request_error',
        code: null,
      },
    });
  });

  // Global error handler
  app.use((err, req, res, next) => {
    console.error('[App] Unhandled server error:', err);
    res.status(500).json({
      error: {
        message: err.message || 'Internal Server Error',
        type: 'server_error',
        code: null,
      },
    });
  });

  return app;
}
