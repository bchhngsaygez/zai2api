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
          if (!response.ok || response.status >= 400) {
            let errorDetail = 'HTTP_' + response.status;
            try {
              const errClone = response.clone();
              const errText = await errClone.text();
              if (errText) {
                errorDetail += ': ' + errText.slice(0, 300);
              }
            } catch (e) {}

            const isQuotaOrAuth = response.status === 429 || response.status === 402 || response.status === 401 || response.status === 403;
            const errCode = (isQuotaOrAuth ? 'QUOTA_OR_AUTH_HTTP_' : 'API_ERROR_HTTP_') + response.status + ' - ' + errorDetail;
            sendBridge('error', errCode);
            console.error('[ZAI_ERROR]:' + errCode);
            try { if (window.__onZaiStreamError) window.__onZaiStreamError(errCode); } catch (e) {}
            return response;
          }

          try {
            const clone = response.clone();
            const contentType = response.headers?.get('content-type') || '';

            // Check if response returned JSON error instead of event-stream
            if (contentType.includes('application/json')) {
              (async () => {
                try {
                  const json = await clone.json();
                  if (json && (json.error || (json.code !== undefined && json.code !== 0 && json.code !== 200))) {
                    const msg = json.message || json.msg || json.error?.message || json.error || JSON.stringify(json);
                    const errPayload = 'QUOTA_OR_API_JSON_ERROR: ' + msg;
                    sendBridge('error', errPayload);
                    console.error('[ZAI_ERROR]:' + errPayload);
                    try { if (window.__onZaiStreamError) window.__onZaiStreamError(errPayload); } catch (e) {}
                    return;
                  }
                } catch (e) {}
              })();
            }

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

