import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const browserEngine = (process.env.BROWSER_ENGINE || 'cloakbrowser').toLowerCase();
const defaultDataDir = browserEngine === 'camoufox' ? './user-data-camoufox' : './user-data-cloak';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '127.0.0.1',
  browserEngine,
  userDataDir: path.resolve(projectRoot, process.env.USER_DATA_DIR || defaultDataDir),
  headless: process.env.HEADLESS !== 'false',
  optimizeRam: process.env.OPTIMIZE_RAM !== 'false',
  blockImages: process.env.BLOCK_IMAGES === 'true' || process.env.OPTIMIZE_RAM !== 'false',
  defaultModel: process.env.DEFAULT_MODEL || 'glm-5.3-flash',
  timeoutMs: parseInt(process.env.TIMEOUT_MS || '300000', 10),
  streamReasoning: process.env.STREAM_REASONING !== 'false',
  targetUrl: 'https://chat.z.ai/',
  zaiAuthToken: process.env.ZAI_AUTH_TOKEN || '',
  peakHourTtftMs: parseInt(process.env.PEAK_HOUR_TTFT_MS || '9000', 10),
  fallbackModel: process.env.FALLBACK_MODEL || 'glm-5.3-flash',
  dashboardPassword: process.env.DASHBOARD_PASSWORD || 'admin',
  projectRoot,
};
