/**
 * Script injected into page to intercept SSE network responses directly from
 * chat.z.ai's client-side window.fetch implementation.
 */
export function getInjectedScript(token = '') {
  return `
    (() => {
      if (window.__zaiHookInstalled) return;
      window.__zaiHookInstalled = true;

      const sendBridge = (endpoint, payload) => {
        try {
          fetch('/__zai_bridge/' + endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: typeof payload === 'string' ? payload : JSON.stringify(payload),
          }).catch(() => {});
        } catch (e) {}
      };

      ${token ? `
        try {
          localStorage.setItem('token', ${JSON.stringify(token)});
          localStorage.setItem('auth_token', ${JSON.stringify(token)});
        } catch (e) {}
      ` : ''}

      const originalFetch = window.fetch;
      window.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);
        const url = (args[0] && typeof args[0] === 'string') ? args[0] : (args[0]?.url || '');

        if (url.includes('/api/v2/chat/completions') || url.includes('/chat/completions')) {
          if (response.status === 429 || response.status === 402) {
            const errCode = 'RATE_LIMIT_HTTP_' + response.status;
            sendBridge('error', errCode);
            console.error('[ZAI_ERROR]:' + errCode);
            try { if (window.__onZaiStreamError) window.__onZaiStreamError(errCode); } catch (e) {}
          }
          try {
            const clone = response.clone();
            const reader = clone.body.getReader();
            const decoder = new TextDecoder();

            (async () => {
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) {
                    const endMsg = JSON.stringify({ type: 'stream_end' });
                    sendBridge('chunk', endMsg);
                    console.log('[ZAI_CHUNK]:' + endMsg);
                    try { if (window.__onZaiStreamChunk) window.__onZaiStreamChunk(endMsg); } catch (e) {}
                    break;
                  }
                  const rawText = decoder.decode(value, { stream: true });
                  sendBridge('chunk', rawText);
                  console.log('[ZAI_CHUNK]:' + rawText);
                  try { if (window.__onZaiStreamChunk) window.__onZaiStreamChunk(rawText); } catch (e) {}
                }
              } catch (err) {
                const errMsg = err.message || String(err);
                sendBridge('error', errMsg);
                console.error('[ZAI_ERROR]:' + errMsg);
                try { if (window.__onZaiStreamError) window.__onZaiStreamError(errMsg); } catch (e) {}
              }
            })();
          } catch (e) {
            sendBridge('error', 'Failed to clone stream: ' + e.message);
            console.error('[ZaiHook] Failed to clone stream:', e);
          }
        }
        return response;
      };
    })();
  `;
}

