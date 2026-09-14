import express from 'express';
import { authManager } from '../authManager.js';

export const authRouter = express.Router();

// Check if currently authenticated
authRouter.get('/api/auth/status', (req, res) => {
  const token = authManager.extractToken(req);
  const authenticated = Boolean(token && authManager.isValidSession(token));
  res.json({
    success: true,
    authenticated,
    requiresAuth: true,
  });
});

// Login with dashboard password
authRouter.post('/api/auth/login', (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || typeof password !== 'string') {
      return res.status(400).json({
        success: false,
        error: { message: 'Password is required' },
      });
    }

    if (!authManager.verifyPassword(password)) {
      return res.status(401).json({
        success: false,
        error: { message: 'Incorrect password' },
      });
    }

    const token = authManager.createSession();
    res.json({
      success: true,
      token,
      message: 'Authenticated successfully',
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: { message: err.message },
    });
  }
});

// Change dashboard password
authRouter.post('/api/auth/change-password', authManager.requireDashboardAuth, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword) {
      return res.status(400).json({
        success: false,
        error: { message: 'Current password is required' },
      });
    }
    if (!newPassword || newPassword.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: { message: 'New password cannot be empty' },
      });
    }

    const newToken = authManager.updatePassword(currentPassword, newPassword);
    res.json({
      success: true,
      token: newToken,
      message: 'Password updated successfully',
    });
  } catch (err) {
    const status = err.statusCode || 400;
    res.status(status).json({
      success: false,
      error: { message: err.message },
    });
  }
});

// Logout
authRouter.post('/api/auth/logout', (req, res) => {
  const token = authManager.extractToken(req) || req.body?.token;
  if (token) {
    authManager.revokeSession(token);
  }
  res.json({ success: true, message: 'Logged out successfully' });
});
