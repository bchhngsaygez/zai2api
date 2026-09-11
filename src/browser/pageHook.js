/**
 * Script injected into page to intercept SSE network responses directly from
 * chat.z.ai's client-side window.fetch implementation.
 */
export function getInjectedScript(token = '') {
  return `
    (() => {
      if (window.__zaiHookInstalled) return;
      window.__zaiHookInstalled = true;

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
            console.error('[ZAI_ERROR]:' + errCode);
            if (window.__onZaiStreamError) window.__onZaiStreamError(errCode);
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
                    console.log('[ZAI_CHUNK]:' + JSON.stringify({ type: 'stream_end' }));
                    if (window.__onZaiStreamChunk) {
                      window.__onZaiStreamChunk(JSON.stringify({ type: 'stream_end' }));
                    }
                    break;
                  }
                  const rawText = decoder.decode(value, { stream: true });
                  console.log('[ZAI_CHUNK]:' + rawText);
                  if (window.__onZaiStreamChunk) {
                    window.__onZaiStreamChunk(rawText);
                  }
                }
              } catch (err) {
                console.error('[ZAI_ERROR]:' + (err.message || String(err)));
                if (window.__onZaiStreamError) {
                  window.__onZaiStreamError(err.message || String(err));
                }
              }
            })();
          } catch (e) {
            console.error('[ZaiHook] Failed to clone stream:', e);
          }
        }
        return response;
      };
    })();
  `;
}

