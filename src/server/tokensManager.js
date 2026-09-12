import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { browserController } from '../browser/browserController.js';
import { statsTracker } from './statsTracker.js';

const TOKENS_FILE = path.resolve(config.projectRoot, 'tokens.json');
const ENV_FILE = path.resolve(config.projectRoot, '.env');

class TokensManager {
  constructor() {
    this.tokens = [];
    this.init();
  }

  init() {
    try {
      if (fs.existsSync(TOKENS_FILE)) {
        const raw = fs.readFileSync(TOKENS_FILE, 'utf-8');
        this.tokens = JSON.parse(raw);
      } else {
        // Initialize from .env if present
        if (config.zaiAuthToken && config.zaiAuthToken.trim()) {
          this.tokens = [
            {
              id: 'tok_default',
              label: 'Primary Token',
              token: config.zaiAuthToken.trim(),
              active: true,
              createdAt: new Date().toISOString(),
            },
          ];
        } else {
          this.tokens = [];
        }
        this.saveToFile();
      }
    } catch (err) {
      console.error('[TokensManager] Failed to load tokens.json:', err.message);
      this.tokens = [];
    }
  }

  saveToFile() {
    try {
      fs.writeFileSync(TOKENS_FILE, JSON.stringify(this.tokens, null, 2), 'utf-8');
    } catch (err) {
      console.error('[TokensManager] Failed to write tokens.json:', err.message);
    }
  }

  syncToEnv(activeTokenString) {
    try {
      if (fs.existsSync(ENV_FILE)) {
        let envContent = fs.readFileSync(ENV_FILE, 'utf-8');
        if (envContent.includes('ZAI_AUTH_TOKEN=')) {
          envContent = envContent.replace(
            /ZAI_AUTH_TOKEN=.*/,
            `ZAI_AUTH_TOKEN=${activeTokenString || ''}`
          );
        } else {
          envContent += `\nZAI_AUTH_TOKEN=${activeTokenString || ''}\n`;
        }
        fs.writeFileSync(ENV_FILE, envContent, 'utf-8');
      }
      config.zaiAuthToken = activeTokenString || '';
      console.log(`[TokensManager] Synced active token to .env and runtime config. Active: ${activeTokenString ? 'Yes' : 'No (Guest)'}`);
    } catch (err) {
      console.error('[TokensManager] Failed to sync .env:', err.message);
    }
  }

  maskToken(tokenStr) {
    if (!tokenStr) return '';
    if (tokenStr.length <= 16) return '••••••••••••';
    return `${tokenStr.slice(0, 10)}...${tokenStr.slice(-6)}`;
  }

  getTokens() {
    const now = Date.now();
    return this.tokens.map(t => {
      const isRateLimited = Boolean(t.rateLimitedUntil && t.rateLimitedUntil > now);
      const cooldownRemainingSec = isRateLimited ? Math.ceil((t.rateLimitedUntil - now) / 1000) : 0;
      return {
        id: t.id,
        label: t.label,
        maskedToken: this.maskToken(t.token),
        tokenLength: t.token.length,
        active: !!t.active,
        isRateLimited,
        cooldownRemainingSec,
        rateLimitedUntil: t.rateLimitedUntil || null,
        createdAt: t.createdAt,
      };
    });
  }

  getActiveToken() {
    const active = this.tokens.find(t => t.active);
    return active ? active.token : null;
  }

  getActiveTokenObject() {
    return this.tokens.find(t => t.active) || null;
  }

  markTokenRateLimited(tokenOrId, cooldownMs = 15 * 60 * 1000) {
    const target = this.tokens.find(t => t.id === tokenOrId || t.token === tokenOrId);
    if (!target) return null;

    target.rateLimitedUntil = Date.now() + cooldownMs;
    console.warn(`[TokensManager] Marked token "${target.label}" (${this.maskToken(target.token)}) as rate-limited for ${Math.round(cooldownMs / 60000)}m.`);
    this.saveToFile();
    return target;
  }

  clearRateLimits() {
    this.tokens.forEach(t => { delete t.rateLimitedUntil; });
    this.saveToFile();
  }

  async rotateToNextToken(reason = 'rate_limit') {
    if (this.tokens.length <= 1) {
      console.warn('[TokensManager] Cannot rotate token: 1 or fewer tokens configured.');
      return { rotated: false, reason: 'Only 1 token available' };
    }

    const now = Date.now();
    const currentIndex = this.tokens.findIndex(t => t.active);
    let nextIndex = -1;

    // First, search cyclically for a token that is NOT currently in cooldown
    for (let i = 1; i < this.tokens.length; i++) {
      const idx = (currentIndex + i) % this.tokens.length;
      const t = this.tokens[idx];
      if (!t.rateLimitedUntil || t.rateLimitedUntil <= now) {
        nextIndex = idx;
        break;
      }
    }

    // If all tokens are rate-limited, pick the one with the soonest expiring cooldown
    if (nextIndex === -1) {
      console.warn('[TokensManager] All tokens are currently rate-limited. Falling back to the earliest expiring token.');
      let earliestTime = Infinity;
      this.tokens.forEach((t, idx) => {
        if (idx !== currentIndex && t.rateLimitedUntil && t.rateLimitedUntil < earliestTime) {
          earliestTime = t.rateLimitedUntil;
          nextIndex = idx;
        }
      });
      if (nextIndex === -1) nextIndex = (currentIndex + 1) % this.tokens.length;
    }

    const nextToken = this.tokens[nextIndex];
    console.log(`[TokensManager] Switching active token from index ${currentIndex} to "${nextToken.label}" (Reason: ${reason})...`);

    // Switch active state
    this.tokens.forEach((t, idx) => { t.active = (idx === nextIndex); });
    this.saveToFile();
    this.syncToEnv(nextToken.token);
    await this.refreshBrowserSession();

    statsTracker.recordRotation();

    return {
      rotated: true,
      token: {
        id: nextToken.id,
        label: nextToken.label,
        maskedToken: this.maskToken(nextToken.token),
      },
    };
  }

  async addToken({ label, token, setActive = false }) {
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new Error('Token string cannot be empty');
    }

    const trimmed = token.trim();
    const id = `tok_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const isFirst = this.tokens.length === 0;
    const makeActive = setActive || isFirst;

    if (makeActive) {
      this.tokens.forEach(t => { t.active = false; });
    }

    const newToken = {
      id,
      label: label && label.trim() ? label.trim() : `Token ${this.tokens.length + 1}`,
      token: trimmed,
      active: makeActive,
      createdAt: new Date().toISOString(),
    };

    this.tokens.push(newToken);
    this.saveToFile();

    if (makeActive) {
      this.syncToEnv(trimmed);
      await this.refreshBrowserSession();
    }

    return {
      id: newToken.id,
      label: newToken.label,
      maskedToken: this.maskToken(newToken.token),
      active: newToken.active,
      createdAt: newToken.createdAt,
    };
  }

  async activateToken(id) {
    if (id === null || id === 'guest' || id === 'none') {
      // Switch to Guest Mode
      this.tokens.forEach(t => { t.active = false; });
      this.saveToFile();
      this.syncToEnv('');
      await this.refreshBrowserSession();
      return { activeToken: null, mode: 'guest' };
    }

    const target = this.tokens.find(t => t.id === id);
    if (!target) {
      throw new Error(`Token with ID "${id}" not found`);
    }

    this.tokens.forEach(t => { t.active = (t.id === id); });
    this.saveToFile();
    this.syncToEnv(target.token);
    await this.refreshBrowserSession();

    return {
      activeToken: {
        id: target.id,
        label: target.label,
        maskedToken: this.maskToken(target.token),
      },
      mode: 'authenticated',
    };
  }

  async removeToken(id) {
    const target = this.tokens.find(t => t.id === id);
    if (!target) {
      throw new Error(`Token with ID "${id}" not found`);
    }

    const wasActive = target.active;
    this.tokens = this.tokens.filter(t => t.id !== id);

    if (wasActive) {
      if (this.tokens.length > 0) {
        this.tokens[0].active = true;
        this.syncToEnv(this.tokens[0].token);
      } else {
        this.syncToEnv('');
      }
      await this.refreshBrowserSession();
    }

    this.saveToFile();
    return { success: true, removedId: id };
  }

  async refreshBrowserSession() {
    try {
      if (browserController && browserController.page && !browserController.page.isClosed()) {
        console.log('[TokensManager] Refreshing browser session with new active token...');
        const token = this.getActiveToken();
        await browserController.page.evaluate((tok) => {
          if (tok) {
            localStorage.setItem('token', tok);
            localStorage.setItem('auth_token', tok);
          } else {
            localStorage.removeItem('token');
            localStorage.removeItem('auth_token');
          }
        }, token).catch(() => {});
        await browserController.newChat().catch(() => {});
      }
    } catch (err) {
      console.warn('[TokensManager] Browser session refresh warning:', err.message);
    }
  }
}

export const tokensManager = new TokensManager();
