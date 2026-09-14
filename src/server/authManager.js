import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

const ENV_FILE = path.resolve(config.projectRoot, '.env');

class AuthManager {
  constructor() {
    this.sessions = new Map(); // token -> { createdAt: number }
  }

  getPassword() {
    return config.dashboardPassword || 'admin';
  }

  verifyPassword(inputPassword) {
    if (typeof inputPassword !== 'string') return false;
    const currentPass = this.getPassword();
    try {
      const inputBuffer = Buffer.from(inputPassword);
      const currentBuffer = Buffer.from(currentPass);
      if (inputBuffer.length !== currentBuffer.length) {
        return false;
      }
      return crypto.timingSafeEqual(inputBuffer, currentBuffer);
    } catch {
      return inputPassword === currentPass;
    }
  }

  createSession() {
    const token = `dash_${crypto.randomBytes(32).toString('hex')}`;
    this.sessions.set(token, { createdAt: Date.now() });
    return token;
  }

  isValidSession(token) {
    if (!token || typeof token !== 'string') return false;
    return this.sessions.has(token);
  }

  revokeSession(token) {
    if (token) {
      this.sessions.delete(token);
    }
  }

  revokeAllSessions() {
    this.sessions.clear();
  }

  syncToEnv(newPassword) {
    try {
      if (fs.existsSync(ENV_FILE)) {
        let envContent = fs.readFileSync(ENV_FILE, 'utf-8');
        if (envContent.includes('DASHBOARD_PASSWORD=')) {
          envContent = envContent.replace(
            /DASHBOARD_PASSWORD=.*/,
            `DASHBOARD_PASSWORD=${newPassword}`
          );
        } else {
          envContent += `\nDASHBOARD_PASSWORD=${newPassword}\n`;
        }
        fs.writeFileSync(ENV_FILE, envContent, 'utf-8');
      }
    } catch (err) {
      console.error('[AuthManager] Failed to sync DASHBOARD_PASSWORD to .env:', err.message);
    }
  }

  updatePassword(currentPassword, newPassword) {
    if (!this.verifyPassword(currentPassword)) {
      const err = new Error('Current password does not match');
      err.statusCode = 401;
      throw err;
    }

    if (!newPassword || typeof newPassword !== 'string' || newPassword.trim().length === 0) {
      const err = new Error('New password cannot be empty');
      err.statusCode = 400;
      throw err;
    }

    const trimmed = newPassword.trim();
    config.dashboardPassword = trimmed;
    this.syncToEnv(trimmed);

    // Invalidate prior sessions
    this.revokeAllSessions();

    // Create fresh session for current caller
    const newToken = this.createSession();
    console.log('[AuthManager] Dashboard password updated successfully.');
    return newToken;
  }

  extractToken(req) {
    // 1. Check Authorization header (Bearer <token>)
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    // 2. Check X-Dashboard-Token header
    const customHeader = req.headers['x-dashboard-token'];
    if (customHeader) {
      return String(customHeader).trim();
    }
    // 3. Check query string (e.g. for EventSource / SSE logs stream)
    if (req.query && req.query.token) {
      return String(req.query.token).trim();
    }
    return null;
  }

  requireDashboardAuth = (req, res, next) => {
    const token = this.extractToken(req);
    if (token && this.isValidSession(token)) {
      return next();
    }

    return res.status(401).json({
      error: {
        message: 'Unauthorized: Valid dashboard session required',
        code: 'unauthorized',
      },
    });
  };
}

export const authManager = new AuthManager();
