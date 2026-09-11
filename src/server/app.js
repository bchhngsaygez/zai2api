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

  // Register dashboard APIs
  app.use(tokensRouter);
  app.use(logsRouter);
  app.use(statsRouter);

  // Register OpenAI-compatible and subagent routes
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
