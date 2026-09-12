import express from 'express';
import { statsTracker } from '../statsTracker.js';
import { tokensManager } from '../tokensManager.js';

export const statsRouter = express.Router();

statsRouter.get(['/api/stats', '/v1/stats'], (req, res) => {
  try {
    const stats = statsTracker.getStats();
    const activeObj = tokensManager.getActiveTokenObject();
    res.json({
      success: true,
      ...stats,
      activeTokenLabel: activeObj ? activeObj.label : 'Guest Mode',
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

statsRouter.post(['/api/stats/reset', '/v1/stats/reset'], (req, res) => {
  try {
    const stats = statsTracker.resetStats();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});
