import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config.js';

const API_KEYS_FILE = path.resolve(config.projectRoot, 'api_keys.json');

class ApiKeysManager {
  constructor() {
    this.keys = [];
    this.init();
  }

  init() {
    try {
      if (fs.existsSync(API_KEYS_FILE)) {
        const raw = fs.readFileSync(API_KEYS_FILE, 'utf-8');
        this.keys = JSON.parse(raw);
      } else {
        this.keys = [];
        this.saveToFile();
      }
    } catch (err) {
      console.error('[ApiKeysManager] Failed to load api_keys.json:', err.message);
      this.keys = [];
    }
  }

  saveToFile() {
    try {
      fs.writeFileSync(API_KEYS_FILE, JSON.stringify(this.keys, null, 2), 'utf-8');
    } catch (err) {
      console.error('[ApiKeysManager] Failed to save api_keys.json:', err.message);
    }
  }

  maskKey(keyStr = '') {
    if (!keyStr) return '';
    if (keyStr.length <= 12) return '••••••••';
    const prefix = keyStr.slice(0, 7); // e.g. 'sk-zai-'
    const suffix = keyStr.slice(-4);
    return `${prefix}••••••••••••${suffix}`;
  }

  hasKeys() {
    return this.keys.length > 0;
  }

  getAll() {
    return this.keys.map(k => ({
      id: k.id,
      name: k.name,
      key: k.key,
      maskedKey: this.maskKey(k.key),
      active: !!k.active,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt || null,
      requestCount: k.requestCount || 0,
    }));
  }

  getById(id) {
    return this.keys.find(k => k.id === id) || null;
  }

  createKey({ name, customKey }) {
    const trimmedName = (name && name.trim()) ? name.trim() : `API Key ${this.keys.length + 1}`;
    let generatedKey = '';

    if (customKey && typeof customKey === 'string' && customKey.trim()) {
      generatedKey = customKey.trim();
      const duplicate = this.keys.find(k => k.key === generatedKey);
      if (duplicate) {
        const err = new Error('An API key with this value already exists');
        err.statusCode = 400;
        throw err;
      }
    } else {
      generatedKey = `sk-zai-${crypto.randomBytes(24).toString('hex')}`;
    }

    const id = `key_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const newKey = {
      id,
      name: trimmedName,
      key: generatedKey,
      active: true,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      requestCount: 0,
    };

    this.keys.push(newKey);
    this.saveToFile();

    return {
      ...newKey,
      maskedKey: this.maskKey(newKey.key),
    };
  }

  updateKey(id, { name, active }) {
    const key = this.keys.find(k => k.id === id);
    if (!key) {
      const err = new Error(`API key with ID "${id}" not found`);
      err.statusCode = 404;
      throw err;
    }

    if (name !== undefined && typeof name === 'string' && name.trim()) {
      key.name = name.trim();
    }

    if (active !== undefined) {
      key.active = Boolean(active);
    }

    this.saveToFile();

    return {
      ...key,
      maskedKey: this.maskKey(key.key),
    };
  }

  deleteKey(id) {
    const index = this.keys.findIndex(k => k.id === id);
    if (index === -1) {
      const err = new Error(`API key with ID "${id}" not found`);
      err.statusCode = 404;
      throw err;
    }

    const removed = this.keys.splice(index, 1)[0];
    this.saveToFile();
    return { success: true, removedId: id, name: removed.name };
  }

  validateKey(rawKey) {
    // If no custom API keys are configured, allow access for seamless backward compatibility
    if (!this.hasKeys()) {
      return { valid: true, isDefaultFallback: true };
    }

    if (!rawKey || typeof rawKey !== 'string') {
      return { valid: false, reason: 'API key is required' };
    }

    const cleaned = rawKey.trim();
    const matched = this.keys.find(k => k.key === cleaned);

    if (!matched) {
      return { valid: false, reason: 'Invalid API key' };
    }

    if (!matched.active) {
      return { valid: false, reason: 'This API key has been disabled' };
    }

    // Increment telemetry
    matched.requestCount = (matched.requestCount || 0) + 1;
    matched.lastUsedAt = new Date().toISOString();
    this.saveToFile();

    return { valid: true, key: matched };
  }
}

export const apiKeysManager = new ApiKeysManager();
