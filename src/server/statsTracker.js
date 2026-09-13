import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

const STATS_FILE = path.resolve(config.projectRoot, 'stats.json');

class StatsTracker {
  constructor() {
    this.stats = {
      totalRequests: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalReasoningTokens: 0,
      rotationsCount: 0,
      firstRecorded: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };
    this.init();
  }

  init() {
    try {
      if (fs.existsSync(STATS_FILE)) {
        const raw = fs.readFileSync(STATS_FILE, 'utf-8');
        const loaded = JSON.parse(raw);
        delete loaded.estimatedSavedDollars;
        this.stats = { ...this.stats, ...loaded };
      } else {
        this.saveToFile();
      }
    } catch (err) {
      console.error('[StatsTracker] Failed to load stats.json:', err.message);
    }
  }

  saveToFile() {
    try {
      fs.writeFileSync(STATS_FILE, JSON.stringify(this.stats, null, 2), 'utf-8');
    } catch (err) {
      console.error('[StatsTracker] Failed to save stats.json:', err.message);
    }
  }

  /**
   * Estimates token count from text using character heuristic (approx 4 chars/token)
   */
  estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    return Math.max(1, Math.ceil(text.length / 4));
  }

  /**
   * Records a completed API request and increments cumulative metrics
   */
  recordRequest({ promptText = '', completionText = '', reasoningText = '', usage = null }) {
    const promptTokens = (usage && usage.prompt_tokens) || this.estimateTokens(promptText);
    const completionTokens = (usage && usage.completion_tokens) || this.estimateTokens(completionText);
    const reasoningTokens = (usage && usage.reasoning_tokens) || this.estimateTokens(reasoningText);

    this.stats.totalRequests += 1;
    this.stats.totalPromptTokens += promptTokens;
    this.stats.totalCompletionTokens += completionTokens;
    this.stats.totalReasoningTokens += reasoningTokens;
    this.stats.lastUpdated = new Date().toISOString();

    this.saveToFile();

    return {
      promptTokens,
      completionTokens,
      reasoningTokens,
    };
  }

  /**
   * Records a token rotation event
   */
  recordRotation() {
    this.stats.rotationsCount += 1;
    this.stats.lastUpdated = new Date().toISOString();
    this.saveToFile();
  }

  getStats() {
    return {
      ...this.stats,
      totalTokens: this.stats.totalPromptTokens + this.stats.totalCompletionTokens,
    };
  }

  resetStats() {
    this.stats = {
      totalRequests: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalReasoningTokens: 0,
      rotationsCount: 0,
      firstRecorded: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };
    this.saveToFile();
    return this.getStats();
  }
}

export const statsTracker = new StatsTracker();
