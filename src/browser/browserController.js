import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
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

    console.log(`[Browser] Initializing stealth browser controller using engine: ${config.browserEngine}...`);
    console.log(`[Browser] Profile directory: ${config.userDataDir}`);
    console.log(`[Browser] Headless mode: ${config.headless}`);

    // Ensure user data directory exists
    if (!fs.existsSync(config.userDataDir)) {
      fs.mkdirSync(config.userDataDir, { recursive: true });
    }

    // Clean up stale lock files if previous process crashed or was killed
    try {
      const lockFiles = ['lock', '.parentlock', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'];
      for (const lf of lockFiles) {
        const p = path.join(config.userDataDir, lf);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    } catch (e) {}

    if (config.browserEngine === 'camoufox') {
      console.log('[Browser] Launching Camoufox (Firefox-based stealth)...');
      const { Camoufox } = await import('camoufox-js');
      const firefoxUserPrefs = {};
      if (config.optimizeRam) {
        console.log('[Browser] RAM Optimization active: single-process mode, 16MB cache cap, zero-bfcache.');
        Object.assign(firefoxUserPrefs, {
          'browser.sessionhistory.max_entries': 2,
          'browser.sessionhistory.max_total_viewers': 0,
          'browser.cache.memory.enable': true,
          'browser.cache.memory.capacity': 16384,
          'browser.cache.disk.enable': false,
          'dom.ipc.processCount': 1,
          'dom.ipc.processCount.webIsolated': 1,
          'image.mem.surfacecache.max_size_kb': 8192,
          'media.peerconnection.enabled': false,
          'toolkit.telemetry.enabled': false,
          'datareporting.healthreport.uploadEnabled': false,
          'experiments.supported': false,
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
    } else {
      console.log('[Browser] Launching CloakBrowser (Chromium-based stealth with 73 C++ source patches)...');

      // Ensure stealth binary is downloaded via resilient downloader with Range resume
      try {
        const { ensureCloakBrowser } = await import('../cli/downloadBrowser.js');
        await ensureCloakBrowser();
      } catch (dlErr) {
        console.warn('[Browser] Resilient download notice:', dlErr.message);
      }

      const { launchPersistentContext } = await import('cloakbrowser');
      const chromiumArgs = [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ];
      if (config.optimizeRam) {
        console.log('[Browser] RAM Optimization active: lean Chromium flags, disabling background tasks.');
        chromiumArgs.push(
          '--js-flags=--max-old-space-size=256',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-component-update',
          '--disable-default-apps',
          '--disable-domain-reliability',
          '--disable-extensions',
          '--disable-sync',
          '--disable-translate',
          '--no-first-run',
          '--no-default-browser-check'
        );
      }

      this.browser = await launchPersistentContext({
        userDataDir: config.userDataDir,
        headless: config.headless,
        args: chromiumArgs,
      });
    }

    this.browser.on('close', () => {
      console.warn(`[Browser] ${config.browserEngine} browser closed!`);
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
   * floating menus, and backdrop overlays that block user interaction.
   */
  async dismissModals() {
    if (!this.page || this.page.isClosed()) return;
    try {
      // 1. Send Escape key to close any active popovers, dropdowns, or tooltips
      await this.page.keyboard.press('Escape').catch(() => {});

      await this.page.evaluate(() => {
        // 2. Click dismiss buttons (Maybe Later, Close, Dismiss)
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

        // 3. Remove dialog overlays, floating wrappers, and backdrops that intercept pointer events
        const selectorsToPurge = [
          'div.fixed.inset-0.z-10000',
          'div.fixed.inset-0.z-50',
          '[data-dialog-overlay]',
          '._modal-overlay',
          '[data-bits-floating-content-wrapper]',
          '[data-radix-popper-content-wrapper]',
          '[data-popover-content]',
          '[data-dropdown-menu-content]',
          '[role="menu"]',
        ];
        for (const sel of selectorsToPurge) {
          document.querySelectorAll(sel).forEach(el => {
            // Safety: never purge an element containing the chat input or textarea
            if (!el.querySelector('#chat-input') && !el.querySelector('textarea')) {
              el.remove();
            }
          });
        }

        // 4. Restore body scrolling and pointer events
        if (document.body) {
          document.body.style.pointerEvents = 'auto';
          document.body.style.overflow = 'auto';
        }

        // 5. Ensure chatInput is unblocked, enabled, and editable
        const input = document.querySelector('#chat-input, textarea');
        if (input) {
          input.removeAttribute('disabled');
          input.removeAttribute('readonly');
          input.disabled = false;
          input.readOnly = false;
          input.style.pointerEvents = 'auto';
        }
      });
    } catch (e) {
      // Non-critical, ignore
    }
  }

  /**
   * Resilient input setter that prevents Playwright actionability timeouts.
   * Uses page.fill with a short timeout, seamlessly falling back to direct
   * DOM property injection with Svelte reactive event triggering.
   */
  async setChatInputValue(prompt = '') {
    if (!this.page || this.page.isClosed()) return;

    // 1. Dismiss any blocking overlays
    await this.dismissModals();

    // 2. Wait for textarea selector in DOM
    const inputHandle = await this.page.waitForSelector(selectors.chatInput, { timeout: 8000 }).catch(() => null);
    if (!inputHandle) {
      throw new Error(`Chat input not found in DOM (waited for: ${selectors.chatInput})`);
    }

    // 3. Try standard page.fill with a short 2000ms timeout
    let filled = false;
    try {
      await this.page.fill(selectors.chatInput, prompt, { timeout: 2000 });
      filled = true;
    } catch (fillErr) {
      console.warn('[Browser] page.fill actionability delayed or blocked, applying direct DOM value injection...');
    }

    // 4. If page.fill timed out or failed, inject value directly into DOM
    if (!filled) {
      await this.page.evaluate(({ sel, text }) => {
        const input = document.querySelector(sel.chatInput);
        if (!input) return false;

        // Force enable and editable
        input.removeAttribute('disabled');
        input.removeAttribute('readonly');
        input.disabled = false;
        input.readOnly = false;
        input.style.pointerEvents = 'auto';

        // React & Svelte native prototype property setter
        const proto = window.HTMLTextAreaElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(input, text);
        } else {
          input.value = text;
        }

        // Trigger full event sequence for Svelte reactive bindings
        input.dispatchEvent(new Event('focus', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        return true;
      }, { sel: selectors, text: prompt }).catch(() => false);
    }

    // 5. Always ensure input & change events are dispatched for Svelte reactivity
    await this.page.evaluate((sel) => {
      const input = document.querySelector(sel.chatInput);
      if (input) {
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }
    }, selectors).catch(() => {});

    // 6. Verify input value
    if (prompt) {
      const currentVal = await this.page.inputValue(selectors.chatInput).catch(() => '');
      if (!currentVal) {
        console.warn('[Browser] Input value empty after initial injection. Retrying direct property assign...');
        await this.page.evaluate(({ sel, text }) => {
          const input = document.querySelector(sel.chatInput);
          if (input) {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          }
        }, { sel: selectors, text: prompt }).catch(() => {});
      }
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



    const scriptContent = getInjectedScript(config.zaiAuthToken);

    // HTML route injection for fetch hook & route-based IPC bridge (works across Chromium & Firefox)
    await this.page.route('https://chat.z.ai/**', async (route) => {
      const req = route.request();
      const url = req.url();

      // Intercept bridge stream chunks directly in Node
      if (url.includes('/__zai_bridge/chunk')) {
        const data = req.postData();
        if (this.currentStreamHandler && data) {
          this.currentStreamHandler.handleChunk(data);
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        return;
      }

      // Intercept bridge stream errors
      if (url.includes('/__zai_bridge/error')) {
        const err = req.postData();
        if (this.currentStreamHandler && err) {
          this.currentStreamHandler.handleError(err);
        }
        await route.fulfill({ status: 200, body: 'ok' });
        return;
      }

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

    // Block heavy static media assets if configured
    if (config.blockImages) {
      await this.page.route(/\.(?:png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|eot)(?:\?.*)?$/i, (route) => {
        return route.abort().catch(() => {});
      }).catch(() => {});
    }

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
      } else {
        await this.page.waitForURL((url) => !url.pathname.includes('/c/'), { timeout: 5000 }).catch(() => {});
      }

      await new Promise(r => setTimeout(r, 400));
      await this.dismissModals();
      await this.setChatInputValue('');

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

  isQuotaOrRateLimitError(text) {
    if (!text || typeof text !== 'string') return false;
    const lower = text.toLowerCase();
    const quotaKeywords = [
      'quota',
      'usage limit',
      'rate limit',
      'exceeded',
      'limit reached',
      'too many requests',
      '429',
      '402',
      '401',
      '403',
      'unauthorized',
      'insufficient',
      'balance',
      'credit',
      'upgrade',
      'subscribe',
      'token expired',
      'invalid token',
      'login required',
      'please log in',
      'account restricted',
      'account suspended',
      'disabled',
      'locked',
      '额度',
      '用完',
      '用尽',
      '超限',
      '频繁',
      '频率过高',
      '次数已满',
      '次数已用完',
      '余额不足',
      '请充值',
      '权限不足',
      '重新登录',
      '登录过期',
      'hết hạn',
      'giới hạn',
      'hạn mức',
      'quota_or_auth_http_',
      'rate_limit_http_',
      'quota_or_api_json_error'
    ];
    return quotaKeywords.some(kw => lower.includes(kw));
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
        'service is busy',
        'usage limit',
        'quota exceeded',
        'quota',
        'rate limit',
        '请求过于频繁',
        '频率过高',
        '次数已满',
        '次数已用完',
        '额度已用完',
        '额度不足',
        '余额不足',
        '超限',
        'upgrade to continue',
        'subscribe',
        '429',
        '402',
        '401',
        '403'
      ];

      // 1. Scoped alert containers and toast notifications
      const alertSelectors = [
        '[role="alert"]',
        '.toast[data-type="error"]',
        '[data-sonner-toast][data-type="error"]',
        '[data-sonner-toast]',
        '.ant-message-error',
        '.ant-notification-notice-error',
        '.alert-error',
        '.toast-error',
        '.modal.error',
        '.error-message',
        '.error-notice'
      ];

      for (const sel of alertSelectors) {
        const elements = document.querySelectorAll(sel);
        for (const el of elements) {
          if (
            el.closest('#chat-input') ||
            el.closest('form') ||
            el.closest('.chat-user') ||
            el.closest('.chat-assistant') ||
            el.closest('[data-message-id]') ||
            el.closest('pre') ||
            el.closest('code')
          ) {
            continue;
          }

          const text = (el.innerText || el.textContent || '').toLowerCase().trim();
          if (!text) continue;

          for (const kw of errorKeywords) {
            if (text.includes(kw)) {
              return kw;
            }
          }
        }
      }

      // 2. Check for blocking quota / upgrade paywall dialogs
      const dialogSelectors = ['[role="dialog"]', '.modal', '[data-state="open"]'];
      for (const dSel of dialogSelectors) {
        const dialogs = document.querySelectorAll(dSel);
        for (const dlg of dialogs) {
          if (dlg.id === 'auth-modal' || dlg.id === 'security-modal' || dlg.id === 'edit-key-modal') continue;
          const dlgText = (dlg.innerText || '').toLowerCase();
          if (
            dlgText.includes('quota') ||
            dlgText.includes('usage limit') ||
            dlgText.includes('upgrade') ||
            dlgText.includes('subscribe') ||
            dlgText.includes('额度') ||
            dlgText.includes('次数')
          ) {
            return 'Modal dialog blocking chat: ' + dlgText.slice(0, 80);
          }
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
      await this.page.keyboard.press('Escape').catch(() => {});
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
        const dtElements = all.filter(el => {
          const t = el.innerText || '';
          return (t.includes('Deep Think') || t.includes('深度思考')) && el.children.length > 0 && el.children.length < 4;
        });
        const trigger = dtElements[dtElements.length - 1];
        if (!trigger) return;

        const currentText = trigger.innerText.toLowerCase();
        const isAlreadyActive = trigger.classList.contains('active') ||
                                trigger.getAttribute('aria-pressed') === 'true' ||
                                trigger.getAttribute('data-state') === 'on' ||
                                trigger.classList.contains('bg-primary') ||
                                trigger.classList.contains('text-primary');

        if (currentText.includes(target) || (isAlreadyActive && target === 'max')) return;

        trigger.click();
        await new Promise(r => setTimeout(r, 400));

        const options = Array.from(document.querySelectorAll('[data-dropdown-menu-content] *, [role="menu"] *, [data-bits-floating-content-wrapper] *'));
        const match = options.find(el => {
          const t = (el.innerText || '').trim().toLowerCase();
          return (t === target || t.includes(target)) && el.children.length === 0;
        });
        if (match) {
          match.click();
        } else {
          trigger.click();
        }
      }, targetMode);
      await new Promise(r => setTimeout(r, 300));
      await this.page.keyboard.press('Escape').catch(() => {});
    } catch (e) {
      console.warn('[Browser] setThinkingMode warning:', e.message);
    }
  }

  async sendMessage({
    prompt,
    model = config.defaultModel,
    thinkingMode = 'max',
    onDelta,
    onReasoning,
    onUsage,
    onDone,
    onError,
    rotationAttempt = 0,
  }) {
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

    const handleAutoRotateAndRetry = async (reason) => {
      if (firstTokenReceived || isCompleted) return false;

      let tokensManager = null;
      try {
        const mod = await import('../server/tokensManager.js');
        tokensManager = mod.tokensManager;
      } catch (e) {}

      if (!tokensManager) return false;

      const canRotate = tokensManager.hasMultipleTokens ? tokensManager.hasMultipleTokens() : (tokensManager.tokens && tokensManager.tokens.length > 1);
      const totalTokens = tokensManager.tokens ? tokensManager.tokens.length : 1;

      if (canRotate && rotationAttempt < totalTokens) {
        const currentToken = tokensManager.getActiveTokenObject ? tokensManager.getActiveTokenObject() : null;
        console.warn(`[AutoRotate] Quota/token failure detected: "${reason}". Current token: "${currentToken?.label}". Initiating auto-rotation (attempt ${rotationAttempt + 1}/${totalTokens})...`);
        isCompleted = true;
        cleanup();

        if (currentToken) {
          tokensManager.markTokenRateLimited(currentToken.id, 30 * 60 * 1000);
        }

        const rotResult = await tokensManager.rotateToNextToken(`quota_exhausted: ${reason}`);
        if (rotResult && rotResult.rotated) {
          console.log(`[AutoRotate] Switched to "${rotResult.token.label}". Resetting session and retrying request...`);

          if (onReasoning && config.streamReasoning) {
            onReasoning(`\n[System Notice: Active token "${currentToken?.label || 'Account'}" reached quota limit. Automatically switched to "${rotResult.token.label}". Resuming...]\n\n`);
          }

          await this.ensureCleanSlate();

          this.sendMessage({
            prompt,
            model,
            thinkingMode,
            onDelta,
            onReasoning,
            onUsage,
            onDone,
            onError,
            rotationAttempt: rotationAttempt + 1,
          });
          return true;
        }
      }

      return false;
    };

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (firstTokenReceived) {
        idleTimer = setTimeout(() => {
          if (fullAnswer.length > 0) {
            console.log('[Browser] Stream idle after tokens received. Finalizing...');
            finish();
          }
        }, 20000);
      }
    };

    // Request inactivity timeout safety guard (resets as long as tokens are arriving)
    const resetInactivityTimer = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(async () => {
        if (fullAnswer.length > 0) {
          console.warn(`[Browser] Stream inactivity timeout after ${config.timeoutMs}ms. Finalizing with received content...`);
          finish();
        } else {
          const rotated = await handleAutoRotateAndRetry(`Inactivity timeout after ${config.timeoutMs}ms with zero tokens`);
          if (rotated) return;
          fail(new Error(`Z.ai response timed out after ${config.timeoutMs}ms of inactivity`));
        }
      }, config.timeoutMs);
    };

    resetInactivityTimer();

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
            onDelta,
            onReasoning,
            onUsage,
            onDone,
            onError,
            rotationAttempt,
          });
        }
      }, config.peakHourTtftMs);
    }

    // DOM Error Sniffing Interval (only active before stream begins)
    domCheckInterval = setInterval(async () => {
      if (isCompleted || firstTokenReceived) return;
      const domError = await this.checkDomError();
      if (domError && !isCompleted && !firstTokenReceived) {
        console.warn(`[Browser] DOM error banner detected: "${domError}"`);

        // Check if error is related to quota or rate limits
        const isQuotaOrLimit = this.isQuotaOrRateLimitError(domError);
        if (isQuotaOrLimit) {
          const rotated = await handleAutoRotateAndRetry(`DOM error: ${domError}`);
          if (rotated) return;
          fail(new Error(`Z.ai rate limit / quota exceeded: ${domError}`));
          return;
        }

        cleanup();

        if (model !== config.fallbackModel) {
          if (onReasoning) {
            onReasoning(`\n[System Notice: Peak-hour server error ("${domError}"). Auto-routing to ${config.fallbackModel}...]\n\n`);
          }
          await this.newChat();
          return this.sendMessage({
            prompt,
            model: config.fallbackModel,
            onDelta,
            onReasoning,
            onUsage,
            onDone,
            onError,
            rotationAttempt,
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
                    resetInactivityTimer();
                    fullReasoning += delta_content;
                    if (onReasoning) onReasoning(delta_content);
                  } else if (phase === 'answer' && delta_content) {
                    firstTokenReceived = true;
                    if (ttftTimer) clearTimeout(ttftTimer);
                    resetIdleTimer();
                    resetInactivityTimer();
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
      handleError: async (err) => {
        console.error('[Browser] Stream reported error:', err);
        const isQuotaOrLimit = this.isQuotaOrRateLimitError(String(err));
        if (isQuotaOrLimit && !firstTokenReceived) {
          const rotated = await handleAutoRotateAndRetry(`Stream error: ${err}`);
          if (rotated) return;
        }
        fail(new Error(err));
      },
    };

    try {
      await this.dismissModals();

      if (model) await this.setModel(model);
      if (thinkingMode) await this.setThinkingMode(thinkingMode);

      // Clean up any dropdowns or backdrops left from model/thinking switch
      await this.dismissModals();

      // Check if chat input is disabled due to quota or account restriction
      const isInputDisabled = await this.page.evaluate((sel) => {
        const input = document.querySelector(sel.chatInput);
        if (!input) return false;
        return input.disabled || input.readOnly || input.getAttribute('disabled') !== null;
      }, selectors).catch(() => false);

      if (isInputDisabled) {
        console.warn('[Browser] Chat input is disabled (account may be restricted or out of quota).');
        const rotated = await handleAutoRotateAndRetry('Chat input is disabled / locked');
        if (rotated) return;
      }

      // Check for blocking paywall or quota dialog
      const blockingDialog = await this.page.evaluate(() => {
        const dialogs = document.querySelectorAll('[role="dialog"], .modal, [data-state="open"]');
        for (const dlg of dialogs) {
          if (dlg.id === 'auth-modal' || dlg.id === 'security-modal' || dlg.id === 'edit-key-modal') continue;
          const txt = (dlg.innerText || '').toLowerCase();
          if (
            txt.includes('quota') ||
            txt.includes('usage limit') ||
            txt.includes('upgrade') ||
            txt.includes('subscribe') ||
            txt.includes('额度') ||
            txt.includes('次数') ||
            txt.includes('429') ||
            txt.includes('402')
          ) {
            return txt.slice(0, 100);
          }
        }
        return null;
      }).catch(() => null);

      if (blockingDialog) {
        console.warn(`[Browser] Paywall/Quota dialog blocking chat: "${blockingDialog}"`);
        const rotated = await handleAutoRotateAndRetry(`Blocking dialog: ${blockingDialog}`);
        if (rotated) return;
      }

      // 1. Enter prompt in textarea using resilient multi-stage setter
      await this.setChatInputValue(prompt);

      await new Promise(r => setTimeout(r, 400));
      await this.dismissModals();

      // 2. Click send button via DOM click with multi-attempt polling or fallback to keyboard Enter
      let clicked = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        clicked = await this.page.evaluate((sel) => {
          const btn = document.querySelector(sel.sendMessageButton);
          if (btn && !btn.disabled && !btn.classList.contains('disabled')) {
            btn.click();
            return true;
          }
          return false;
        }, selectors).catch(() => false);

        if (clicked) break;

        // Alternate button selectors directly in DOM
        clicked = await this.page.evaluate(() => {
          const candidates = [
            '#send-message-button',
            'button[type="submit"]',
            'button[aria-label*="send" i]',
            'button[aria-label*="发送" i]',
            'form button:last-of-type',
            'button.send-button'
          ];
          for (const s of candidates) {
            const btn = document.querySelector(s);
            if (btn && !btn.disabled && !btn.classList.contains('disabled')) {
              btn.click();
              return true;
            }
          }
          return false;
        }).catch(() => false);

        if (clicked) break;
        await new Promise(r => setTimeout(r, 200));
      }

      if (!clicked) {
        console.log('[Browser] Send button not clickable or not found, falling back to Enter key...');
        await this.page.evaluate((sel) => {
          const input = document.querySelector(sel.chatInput);
          if (input) input.focus();
        }, selectors).catch(() => {});
        await this.page.keyboard.press('Enter').catch(() => {});

        await new Promise(r => setTimeout(r, 600));
        const valStill = await this.page.inputValue(selectors.chatInput).catch(() => '');
        if (valStill && valStill.trim().length > 0) {
          const domErr = await this.checkDomError();
          if (domErr && this.isQuotaOrRateLimitError(domErr)) {
            const rotated = await handleAutoRotateAndRetry(`Send blocked: ${domErr}`);
            if (rotated) return;
          }
        }
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
