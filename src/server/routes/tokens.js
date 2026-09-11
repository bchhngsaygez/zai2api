import express from 'express';
import { tokensManager } from '../tokensManager.js';

export const tokensRouter = express.Router();

// List all tokens
tokensRouter.get(['/api/tokens', '/v1/tokens'], (req, res) => {
  try {
    const tokens = tokensManager.getTokens();
    const activeToken = tokens.find(t => t.active) || null;
    res.json({
      success: true,
      tokens,
      activeToken,
      isGuestMode: !activeToken,
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Add a new token
tokensRouter.post(['/api/tokens', '/v1/tokens'], async (req, res) => {
  try {
    const { label, token, setActive = false } = req.body;
    if (!token) {
      return res.status(400).json({ error: { message: 'Token is required' } });
    }
    const created = await tokensManager.addToken({ label, token, setActive });
    res.json({ success: true, token: created });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

// Activate a token or switch to Guest mode
tokensRouter.post(['/api/tokens/activate', '/v1/tokens/activate'], async (req, res) => {
  try {
    const { id } = req.body;
    const result = await tokensManager.activateToken(id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

// Rotate to next available token
tokensRouter.post(['/api/tokens/rotate', '/v1/tokens/rotate'], async (req, res) => {
  try {
    const result = await tokensManager.rotateToNextToken('manual_user_trigger');
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Clear all rate limit cooldowns
tokensRouter.post(['/api/tokens/clear-cooldowns', '/v1/tokens/clear-cooldowns'], (req, res) => {
  try {
    tokensManager.clearRateLimits();
    res.json({ success: true, message: 'All token cooldowns cleared' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Delete a token
tokensRouter.delete(['/api/tokens/:id', '/v1/tokens/:id'], async (req, res) => {
  try {
    const { id } = req.params;
    const result = await tokensManager.removeToken(id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});
