import express from 'express';
import { logger } from '../logger.js';

export const logsRouter = express.Router();

// Get recent logs as JSON
logsRouter.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit || '200', 10);
  res.json({
    success: true,
    logs: logger.getLogs(limit),
  });
});

// Stream logs in real-time via Server-Sent Events (SSE)
logsRouter.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Send current recent logs first
  const recent = logger.getLogs(50);
  res.write(`data: ${JSON.stringify({ type: 'init', logs: recent })}\n\n`);

  // Listener for incoming new logs
  const onLog = (entry) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`);
    }
  };

  const onClear = () => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'clear' })}\n\n`);
    }
  };

  logger.on('log', onLog);
  logger.on('clear', onClear);

  req.on('close', () => {
    logger.off('log', onLog);
    logger.off('clear', onClear);
  });
});

// Clear logs
logsRouter.post('/api/logs/clear', (req, res) => {
  logger.clear();
  res.json({ success: true });
});
