import { Camoufox } from 'camoufox-js';
import { EventEmitter } from 'events';
import { config } from '../config.js';
import { selectors } from './selectors.js';
import { getInjectedScript } from './pageHook.js';

export class BrowserController extends EventEmitter {
  constructor() {
    super();
    this.browser = null; // BrowserContext
    this.page = null;
    this.isReady = false;
    this.isBusy = false;
    this.currentStreamHandler = null;
  }

  async initialize() {
    if (this.browser && this.page && !this.page.isClosed()) return;

    console.log('[Browser] Initializing Camoufox stealth browser controller...');
    console.log(`[Browser] Profile directory: ${config.userDataDir}`);
    console.log(`[Browser] Headless mode: ${config.headless}`);

    // Clean up stale lock files if previous process crashed or was killed
    try {
      const lockPath = path.join(config.userDataDir, 'lock');
      const parentLockPath = path.join(config.userDataDir, '.parentlock');
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      if (fs.existsSync(parentLockPath)) fs.unlinkSync(parentLockPath);
    } catch (e) {}

    const firefoxUserPrefs = {};
    if (config.optimizeRam) {
      console.log('[Browser] RAM Optimization active: single-process mode, 16MB cache cap, zero-bfcache.');
      Object.assign(firefoxUserPrefs, {
        // Discard page cache when navigating back/forward (saves hundreds of MBs)
        'browser.sessionhistory.max_entries': 2,
        'browser.sessionhistory.max_total_viewers': 0,
        // Restrict memory cache capacity to 16MB
        'browser.cache.memory.enable': true,
        'browser.cache.memory.capacity': 16384,
        'browser.cache.disk.enable': false,
        // Single content process mode: prevents Firefox from spawning multiple helper processes
        'dom.ipc.processCount': 1,
        'dom.ipc.processCount.webIsolated': 1,
        // Restrict image decode cache
        'image.mem.surfacecache.max_size_kb': 8192,
        // Disable WebRTC overhead
        'media.peerconnection.enabled': false,
        // Disable telemetry and background workers
        'toolkit.telemetry.enabled': false,
        'datareporting.healthreport.uploadEnabled': false,
        'experiments.supported': false,
        // Faster JS GC
        'javascript.options.mem.gc_frequency': 100,
      });
    }

    this.browser = await Camoufox({
      headless: config.headless,
      user_data_dir: config.userDataDir,
      block_images: config.blockImages,
      block_webrtc: config.optimizeRam,
      i_know_what_im_doing: true,
      firefox_user_prefs: firefoxUserPrefs,
    });

    this.browser.on('close', () => {
      console.warn('[Browser] Camoufox browser closed!');
      this.browser = null;
      this.page = null;
      this.isReady = false;
    });

    await this.setupPage();
    this.isReady = true;
    console.log('[Browser] Browser controller ready for requests.');
  }

  /**
   * Automatically dismisses marketing popups, announcement dialogs,
   * and floating backdrop overlays that block user interaction.
   */
  async dismissModals() {
    if (!this.page || this.page.isClosed()) return;
    try {
      await this.page.evaluate(() => {
        // 1. Click dismiss buttons (Maybe Later, Close, Dismiss)
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          const text = (btn.innerText || '').trim().toLowerCase();
          const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (
            text.includes('maybe later') ||
            text === 'later' ||
            text === 'dismiss' ||
            text === 'got it' ||
            text === 'cancel' ||
            aria === 'close'
          ) {
            btn.click();
          }
        }

        // 2. Remove dialog overlays and floating wrappers that intercept pointer events
        const selectorsToPurge = [
          'div.fixed.inset-0.z-10000',
          '[data-dialog-overlay]',
          '._modal-overlay',
          '[data-bits-floating-content-wrapper]',
          '[data-popover-content]',
        ];
        for (const sel of selectorsToPurge) {
          document.querySelectorAll(sel).forEach(el => el.remove());
        }

        // 3. Restore body scrolling and pointer events
        if (document.body) {
          document.body.style.pointerEvents = 'auto';
          document.body.style.overflow = 'auto';
        }
      });
    } catch (e) {
      // Non-critical, ignore
    }
  }

  async setupPage() {
    const pages = typeof this.browser.pages === 'function' ? this.browser.pages() : [];
    this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

    // Close redundant pages
    for (let i = 1; i < pages.length; i++) {
      await pages[i].close().catch(() => {});
    }

    // Console stream bridge listener
    this.page.on('console', (msg) => {
      const text = msg.text();
      if (text.startsWith('[ZAI_CHUNK]:')) {
        const chunk = text.slice('[ZAI_CHUNK]:'.length);
        if (this.currentStreamHandler) {
          this.currentStreamHandler.handleChunk(chunk);
        }
      } else if (text.startsWith('[ZAI_ERROR]:')) {
        const err = text.slice('[ZAI_ERROR]:'.length);
        if (this.currentStreamHandler) {
          this.currentStreamHandler.handleError(err);
        }
      }
    });

    // Expose stream chunk callbacks as backup
    try {
      await this.page.exposeFunction('__onZaiStreamChunk', (chunk) => {
        if (this.currentStreamHandler) {
          this.currentStreamHandler.handleChunk(chunk);
        }
      });
    } catch (e) {}

    try {
      await this.page.exposeFunction('__onZaiStreamError', (err) => {
        if (this.currentStreamHandler) {
          this.currentStreamHandler.handleError(err);
        }
      });
    } catch (e) {}

    const scriptContent = getInjectedScript(config.zaiAuthToken);

    // HTML route injection for fetch hook (bypasses Firefox Xray wrappers)
    await this.page.route('https://chat.z.ai/**', async (route) => {
      const req = route.request();
      if (req.resourceType() === 'document') {
        try {
          const response = await route.fetch();
          let body = await response.text();
          body = body.replace('<head>', `<head><script>${scriptContent}</script>`);
          await route.fulfill({
            response,
            body,
            headers: {
              ...response.headers(),
              'content-security-policy': '',
            },
          });
        } catch (routeErr) {
          await route.continue().catch(() => {});
        }
      } else {
        await route.continue().catch(() => {});
      }
    });

    // Defense-in-depth init script
    try {
      await this.page.addInitScript(scriptContent);
    } catch (e) {}

    // Navigate to target URL
    console.log(`[Browser] Navigating to ${config.targetUrl}...`);
    await this.page.goto(config.targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    }).catch(err => {
      console.warn('[Browser] Navigation warning:', err.message);
    });

    // Ensure token is saved in localStorage after initial load if configured
    if (config.zaiAuthToken) {
      await this.page.evaluate((token) => {
        try {
          localStorage.setItem('token', token);
          localStorage.setItem('auth_token', token);
        } catch (e) {}
      }, config.zaiAuthToken).catch(() => {});
    }

    await this.dismissModals();
    await this.page.waitForSelector(selectors.chatInput, { timeout: 30000 });
  }

  async ensureReady() {
    if (!this.browser || !this.page || this.page.isClosed()) {
      await this.initialize();
      return;
    }
    await this.dismissModals();
    const hasInput = await this.page.$(selectors.chatInput).catch(() => null);
    if (!hasInput) {
      console.log('[Browser] Chat input not found, navigating fresh to chat.z.ai...');
      await this.setupPage();
    }
  }

  async newChat() {
    await this.ensureReady();
    console.log('[Browser] Resetting session / Opening New Chat...');
    try {
      await this.dismissModals();

      // Prefer clicking the UI New Chat button over a full page reload to preserve SPA state & hooks
      const clickedNewChat = await this.page.evaluate((sel) => {
        const btn = document.querySelector(sel.newChatButton) ||
                    document.querySelector(sel.sidebarNewChatButton) ||
                    document.querySelector('a[href="/"]') ||
                    document.querySelector('button[aria-label="New Chat"]');
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      }, selectors).catch(() => false);

      if (!clickedNewChat) {
        await this.page.goto(config.targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
      }

      await new Promise(r => setTimeout(r, 400));
      await this.dismissModals();
      await this.page.waitForSelector(selectors.chatInput, { timeout: 15000 });
      await this.page.fill(selectors.chatInput, '');

      // Ensure token is saved in localStorage
      if (config.zaiAuthToken) {
        await this.page.evaluate((token) => {
          try {
            if (!localStorage.getItem('token')) {
              localStorage.setItem('token', token);
              localStorage.setItem('auth_token', token);
            }
          } catch (e) {}
        }, config.zaiAuthToken).catch(() => {});
      }
    } catch (err) {
      console.warn('[Browser] New chat navigation warning:', err.message);
    }
  }

  async ensureCleanSlate() {
    await this.ensureReady();
    const currentUrl = this.page.url();
    if (currentUrl.includes('/c/') || !currentUrl.includes('chat.z.ai')) {
      console.log(`[Browser] Active URL is ${currentUrl}. Ensuring clean slate New Chat...`);
      await this.newChat();
    } else {
      await this.dismissModals();
      const val = await this.page.inputValue(selectors.chatInput).catch(() => '');
      if (val && val.trim().length > 0) {
        await this.newChat();
      }
    }
  }

  async checkDomError() {
    if (!this.page || this.page.isClosed()) return null;
    return await this.page.evaluate(() => {
      const errorKeywords = [
        'server is busy',
        'please try again later',
        '当前访问人数过多',
        '网络繁忙',
        '系统繁忙',
        'too many requests',
        'service unavailable',
        'service is busy'
      ];
      const text = document.body ? document.body.innerText.toLowerCase() : '';
      for (const kw of errorKeywords) {
        if (text.includes(kw)) {
          return kw;
        }
      }
      return null;
    }).catch(() => null);
  }

  async setModel(modelName) {
    if (!this.page || this.page.isClosed() || !modelName) return;
    try {
      const normalized = modelName.toLowerCase();
      let targetText = 'GLM-5.3-Flash';
      if (normalized.includes('5.3') && !normalized.includes('flash')) {
        targetText = 'GLM-5.3';
      } else if (normalized.includes('5.2')) {
        targetText = 'GLM-5.2';
      }

      await this.page.evaluate(async (target) => {
        const btn = document.querySelector('.modelSelectorButton') || document.querySelector('#model-selector-x-preview-l-button');
        if (!btn) return;
        const current = btn.innerText ? btn.innerText.trim() : '';
        if (current.toLowerCase() === target.toLowerCase()) return;

        btn.click();
        await new Promise(r => setTimeout(r, 400));

        const options = Array.from(document.querySelectorAll('[data-dropdown-menu-content] *, [role="menu"] *, [data-bits-floating-content-wrapper] *'));
        const match = options.find(el => el.innerText && el.innerText.trim().toLowerCase() === target.toLowerCase() && el.children.length === 0);
        if (match) {
          match.click();
        } else {
          btn.click();
        }
      }, targetText);
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.warn('[Browser] setModel warning:', e.message);
    }
  }

  async setThinkingMode(mode = 'max') {
    if (!this.page || this.page.isClosed() || !mode) return;
    try {
      const targetMode = mode.toLowerCase();
      if (!['low', 'high', 'max'].includes(targetMode)) return;

      await this.page.evaluate(async (target) => {
        const all = Array.from(document.querySelectorAll('*'));
        const dtElements = all.filter(el => el.innerText && el.innerText.includes('Deep Think') && el.children.length > 0 && el.children.length < 4);
        const trigger = dtElements[dtElements.length - 1];
        if (!trigger) return;

        const currentText = trigger.innerText.toLowerCase();
        if (currentText.includes(target)) return;

        trigger.click();
        await new Promise(r => setTimeout(r, 400));

        const options = Array.from(document.querySelectorAll('[data-dropdown-menu-content] *, [role="menu"] *, [data-bits-floating-content-wrapper] *'));
        const match = options.find(el => el.innerText && el.innerText.trim().toLowerCase() === target && el.children.length === 0);
        if (match) {
          match.click();
        } else {
          trigger.click();
        }
      }, targetMode);
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.warn('[Browser] setThinkingMode warning:', e.message);
    }
  }

  async sendMessage({ prompt, model = config.defaultModel, thinkingMode = 'max', onDelta, onReasoning, onUsage, onDone, onError }) {
    await this.ensureReady();
    this.isBusy = true;

    let isCompleted = false;
    let firstTokenReceived = false;
    let fullAnswer = '';
    let fullReasoning = '';
    let collectedUsage = null;
    let timeoutTimer = null;
    let ttftTimer = null;
    let domCheckInterval = null;
    let idleTimer = null;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (ttftTimer) clearTimeout(ttftTimer);
      if (domCheckInterval) clearInterval(domCheckInterval);
      if (idleTimer) clearTimeout(idleTimer);
      this.currentStreamHandler = null;
      this.isBusy = false;
    };

    const finish = () => {
      if (isCompleted) return;
      isCompleted = true;
      cleanup();
      if (onDone) onDone({ answer: fullAnswer, reasoning: fullReasoning, usage: collectedUsage });
    };

    const fail = (err) => {
      if (isCompleted) return;
      isCompleted = true;
      cleanup();
      if (onError) onError(err);
    };

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (firstTokenReceived) {
        idleTimer = setTimeout(() => {
          if (fullAnswer.length > 0) {
            console.log('[Browser] Stream idle after tokens received. Finalizing...');
            finish();
          }
        }, 3500);
      }
    };

    // Overall request timeout safety guard
    timeoutTimer = setTimeout(() => {
      if (fullAnswer.length > 0) {
        finish();
      } else {
        fail(new Error(`Z.ai response timed out after ${config.timeoutMs}ms`));
      }
    }, config.timeoutMs);

    // Peak-Hour TTFT Threshold & Fallback
    const isStandardModel = model && !model.toLowerCase().includes('flash');
    if (isStandardModel) {
      console.log(`[Browser] Monitoring TTFT for non-flash model "${model}" (threshold: ${config.peakHourTtftMs}ms)...`);
      ttftTimer = setTimeout(async () => {
        if (!firstTokenReceived && !isCompleted) {
          console.warn(`[Browser] Peak-hour congestion detected! TTFT exceeded ${config.peakHourTtftMs}ms for ${model}. Falling back to ${config.fallbackModel}...`);
          cleanup();
          
          if (onReasoning) {
            onReasoning(`\n[System Notice: Standard model "${model}" congested (TTFT > ${config.peakHourTtftMs}ms). Automatically re-routing to ${config.fallbackModel}...]\n\n`);
          }

          await this.newChat();

          return this.sendMessage({
            prompt,
            model: config.fallbackModel,
            images: allImages,
            onDelta,
            onReasoning,
            onUsage,
            onDone,
            onError,
          });
        }
      }, config.peakHourTtftMs);
    }

    // DOM Error Sniffing Interval
    domCheckInterval = setInterval(async () => {
      if (isCompleted) return;
      const domError = await this.checkDomError();
      if (domError && !isCompleted) {
        console.warn(`[Browser] DOM error banner detected: "${domError}"`);
        cleanup();

        if (model !== config.fallbackModel) {
          if (onReasoning) {
            onReasoning(`\n[System Notice: Peak-hour server error ("${domError}"). Auto-routing to ${config.fallbackModel}...]\n\n`);
          }
          await this.newChat();
          return this.sendMessage({
            prompt,
            model: config.fallbackModel,
            images: allImages,
            onDelta,
            onReasoning,
            onUsage,
            onDone,
            onError,
          });
        } else {
          fail(new Error(`Z.ai server busy: ${domError}`));
        }
      }
    }, 2000);

    this.currentStreamHandler = {
      handleChunk: (rawChunk) => {
        try {
          const lines = rawChunk.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed === 'data: [DONE]' || trimmed === '[DONE]') {
              finish();
              return;
            }

            if (trimmed.startsWith('{')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (parsed.type === 'stream_end' || parsed.done) {
                  finish();
                  return;
                }
              } catch (e) {}
            }

            if (trimmed.startsWith('data: ')) {
              const payloadStr = trimmed.slice(6).trim();
              if (payloadStr === '[DONE]') {
                finish();
                return;
              }
              if (!payloadStr) continue;

              try {
                const parsed = JSON.parse(payloadStr);
                if (parsed.type === 'stream_end' || parsed.done || parsed.data?.done) {
                  finish();
                  return;
                }

                if (parsed.data) {
                  const { phase, delta_content, usage, done } = parsed.data;

                  if (done) {
                    finish();
                    return;
                  }

                  if (phase === 'thinking' && delta_content) {
                    firstTokenReceived = true;
                    if (ttftTimer) clearTimeout(ttftTimer);
                    resetIdleTimer();
                    fullReasoning += delta_content;
                    if (onReasoning) onReasoning(delta_content);
                  } else if (phase === 'answer' && delta_content) {
                    firstTokenReceived = true;
                    if (ttftTimer) clearTimeout(ttftTimer);
                    resetIdleTimer();
                    fullAnswer += delta_content;
                    if (onDelta) onDelta(delta_content);
                  } else if (phase === 'other' && usage) {
                    collectedUsage = usage;
                    if (onUsage) onUsage(usage);
                  }
                }
              } catch (parseErr) {}
            }
          }
        } catch (err) {
          console.error('[Browser] Error processing stream chunk:', err);
        }
      },
      handleError: (err) => {
        console.error('[Browser] Stream reported error:', err);
        fail(new Error(err));
      },
    };

    try {
      await this.dismissModals();

      if (model) await this.setModel(model);
      if (thinkingMode) await this.setThinkingMode(thinkingMode);

      // 1. Enter prompt in textarea using page.fill to trigger Svelte reactivity
      await this.page.waitForSelector(selectors.chatInput, { timeout: 10000 });
      await this.page.fill(selectors.chatInput, prompt);

      await new Promise(r => setTimeout(r, 400));
      await this.dismissModals();

      // 2. Click send button via DOM click or fallback to keyboard Enter
      await this.page.waitForSelector(selectors.sendMessageButton, { timeout: 5000 });
      const clicked = await this.page.evaluate((sel) => {
        const btn = document.querySelector(sel.sendMessageButton);
        if (btn && !btn.disabled && !btn.classList.contains('disabled')) {
          btn.click();
          return true;
        }
        return false;
      }, selectors);

      if (!clicked) {
        await this.page.focus(selectors.chatInput).catch(() => {});
        await this.page.keyboard.press('Enter').catch(() => {});
      }

      console.log(`[Browser] Prompt dispatched to chat.z.ai (model: ${model}, thinking: ${thinkingMode}). Awaiting stream...`);
    } catch (err) {
      fail(err);
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page = null;
      this.isReady = false;
    }
  }
}

export const browserController = new BrowserController();
