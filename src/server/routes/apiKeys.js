import express from 'express';
import { apiKeysManager } from '../apiKeysManager.js';

export const apiKeysRouter = express.Router();

// List all API keys
apiKeysRouter.get(['/api/keys', '/v1/api-keys'], (req, res) => {
  try {
    const keys = apiKeysManager.getAll();
    res.json({
      success: true,
      keys,
      count: keys.length,
      hasKeys: apiKeysManager.hasKeys(),
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Create new API key
apiKeysRouter.post(['/api/keys', '/v1/api-keys'], (req, res) => {
  try {
    const { name, customKey } = req.body || {};
    const created = apiKeysManager.createKey({ name, customKey });
    res.json({
      success: true,
      key: created,
      message: 'API key created successfully',
    });
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: { message: err.message } });
  }
});

// Update / Edit API key (name, active status)
apiKeysRouter.put(['/api/keys/:id', '/v1/api-keys/:id'], (req, res) => {
  try {
    const { id } = req.params;
    const { name, active } = req.body || {};
    const updated = apiKeysManager.updateKey(id, { name, active });
    res.json({
      success: true,
      key: updated,
      message: 'API key updated successfully',
    });
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: { message: err.message } });
  }
});

// Delete API key
apiKeysRouter.delete(['/api/keys/:id', '/v1/api-keys/:id'], (req, res) => {
  try {
    const { id } = req.params;
    const result = apiKeysManager.deleteKey(id);
    res.json({
      success: true,
      ...result,
      message: 'API key deleted successfully',
    });
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: { message: err.message } });
  }
});
