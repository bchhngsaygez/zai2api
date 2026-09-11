import express from 'express';
import { orchestrator } from '../../subagent/orchestrator.js';
import { requestQueue } from '../../queue/fifoQueue.js';

export const subagentRouter = express.Router();

subagentRouter.post('/v1/subagent/task', async (req, res) => {
  const { prompt, outputDir = './generated_project', stream = false } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Field "prompt" is required' });
  }

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (event, data) => {
      if (!res.writableEnded) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    try {
      const result = await orchestrator.executeTask({
        taskPrompt: prompt,
        outputDir,
        onProgress: (progress) => {
          sendEvent('progress', progress);
        },
      });

      sendEvent('complete', result);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      sendEvent('error', { message: err.message });
      res.end();
    }
  } else {
    try {
      const result = await orchestrator.executeTask({
        taskPrompt: prompt,
        outputDir,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
});

subagentRouter.get('/v1/queue/status', (req, res) => {
  res.json(requestQueue.getStatus());
});
