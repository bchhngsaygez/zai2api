import express from 'express';
import { tokensManager } from '../tokensManager.js';

export const tokensRouter = express.Router();

// List all tokens
tokensRouter.get('/api/tokens', (req, res) => {
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
tokensRouter.post('/api/tokens', async (req, res) => {
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
tokensRouter.post('/api/tokens/activate', async (req, res) => {
  try {
    const { id } = req.body;
    const result = await tokensManager.activateToken(id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

// Delete a token
tokensRouter.delete('/api/tokens/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await tokensManager.removeToken(id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});
