// zai2api Studio Client Script
// Minimalist Monochrome Black & White UI with Dark & Light Mode

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initTabs();
  initStats();
  initTokens();
  initChat();
  initTesting();
  initLogs();
});

/* =====================================================
   0. Theme Management (Light & Dark Mode)
   ===================================================== */
function initTheme() {
  const toggleBtn = document.getElementById('theme-toggle');
  const saved = localStorage.getItem('zai_theme');
  
  let currentTheme = saved || 'dark';
  applyTheme(currentTheme);

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
      applyTheme(currentTheme);
      localStorage.setItem('zai_theme', currentTheme);
    });
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('zai_theme')) {
      currentTheme = e.matches ? 'dark' : 'light';
      applyTheme(currentTheme);
    }
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const sunIcon = document.getElementById('theme-icon-sun');
  const moonIcon = document.getElementById('theme-icon-moon');
  if (sunIcon && moonIcon) {
    if (theme === 'dark') {
      sunIcon.style.display = 'block';
      moonIcon.style.display = 'none';
    } else {
      sunIcon.style.display = 'none';
      moonIcon.style.display = 'block';
    }
  }
}

/* =====================================================
   1. Tab Navigation
   ===================================================== */
function initTabs() {
  const tabButtons = document.querySelectorAll('.nav-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;

      tabButtons.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetPanel = document.getElementById(`tab-${target}`);
      if (targetPanel) {
        targetPanel.classList.add('active');
      }
    });
  });
}

/* =====================================================
   2. Global Usage Stats
   ===================================================== */
let refreshStatsTimer = null;

async function refreshStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.success) return;

    const tokensEl = document.getElementById('stats-total-tokens');
    if (tokensEl) {
      const total = data.totalTokens || 0;
      tokensEl.textContent = total >= 1000000 
        ? (total / 1000000).toFixed(2) + 'M' 
        : total >= 1000 
          ? (total / 1000).toFixed(1) + 'k' 
          : total.toLocaleString();
    }

    const breakdownEl = document.getElementById('stats-tokens-breakdown');
    if (breakdownEl) {
      const p = (data.totalPromptTokens || 0).toLocaleString();
      const c = (data.totalCompletionTokens || 0).toLocaleString();
      breakdownEl.textContent = `${p} in / ${c} out`;
    }

    const reqsEl = document.getElementById('stats-requests-count');
    if (reqsEl) reqsEl.textContent = (data.totalRequests || 0).toLocaleString();

    const accountEl = document.getElementById('stats-active-account');
    if (accountEl) accountEl.textContent = data.activeTokenLabel || 'Guest Mode';

    const badgeEl = document.getElementById('stats-rotation-badge');
    if (badgeEl) {
      badgeEl.textContent = data.activeTokenLabel === 'Guest Mode' ? 'GUEST' : 'ACTIVE';
    }
  } catch (err) {
    console.debug('Failed to refresh stats:', err.message);
  }
}

window.refreshStats = refreshStats;

function initStats() {
  const btnQuickRotate = document.getElementById('btn-quick-rotate');
  if (btnQuickRotate) {
    btnQuickRotate.addEventListener('click', async () => {
      try {
        btnQuickRotate.disabled = true;
        const res = await fetch('/api/tokens/rotate', { method: 'POST' });
        const data = await res.json();
        if (data.rotated) {
          if (typeof showToast === 'function') showToast(`Rotated to ${data.token.label}!`);
        } else {
          if (typeof showToast === 'function') showToast(data.reason || 'Could not rotate token', 'warning');
        }
        await refreshStats();
        if (typeof window.loadTokensGlobal === 'function') window.loadTokensGlobal();
      } catch (e) {
        if (typeof showToast === 'function') showToast('Rotation failed', 'error');
      } finally {
        btnQuickRotate.disabled = false;
      }
    });
  }

  // Initial fetch and recurring poll every 5s
  refreshStats();
  if (refreshStatsTimer) clearInterval(refreshStatsTimer);
  refreshStatsTimer = setInterval(refreshStats, 5000);
}

/* =====================================================
   3. Token Management
   ===================================================== */
async function initTokens() {
  const headerStatus = document.getElementById('header-token-status');
  const activeLabel = document.getElementById('active-token-label');
  const activePreview = document.getElementById('active-token-preview');
  const btnGuest = document.getElementById('btn-guest-mode');
  const addForm = document.getElementById('form-add-token');
  const tokensListEl = document.getElementById('tokens-list');

  async function loadTokens() {
    try {
      const res = await fetch('/api/tokens');
      const data = await res.json();

      if (data.isGuestMode || !data.activeToken) {
        headerStatus.textContent = 'Free Guest Mode';
        activeLabel.textContent = 'Guest Mode (No Token)';
        activePreview.textContent = 'Using unauthenticated Z.ai guest session';
        btnGuest.disabled = true;
      } else {
        headerStatus.textContent = data.activeToken.label;
        activeLabel.textContent = data.activeToken.label;
        activePreview.textContent = data.activeToken.maskedToken;
        btnGuest.disabled = false;
      }

      renderTokensList(data.tokens || []);
    } catch (err) {
      console.error('Failed to fetch tokens:', err);
      headerStatus.textContent = 'Connection Error';
    }
  }

  function renderTokensList(tokens) {
    if (!tokens || tokens.length === 0) {
      tokensListEl.innerHTML = '<div class="empty-state">No saved accounts found</div>';
      return;
    }

    tokensListEl.innerHTML = '';
    tokens.forEach(tok => {
      const item = document.createElement('div');
      item.className = `account-item ${tok.active ? 'active' : ''}`;

      const isCooldown = tok.isRateLimited;
      const cooldownBadge = isCooldown ? `<span class="badge-cooldown">⚠️ Cooldown (${tok.cooldownRemainingSec}s)</span>` : '';

      item.innerHTML = `
        <div class="account-info">
          <strong>${escapeHtml(tok.label)} ${tok.active ? '<span class="badge-status ok">ACTIVE</span>' : ''} ${cooldownBadge}</strong>
          <code class="token-code">${tok.maskedToken}</code>
        </div>
        <div class="account-actions">
          ${!tok.active ? `<button class="btn btn-secondary btn-sm btn-activate" data-id="${tok.id}">Activate</button>` : ''}
          <button class="btn btn-danger btn-sm btn-delete" data-id="${tok.id}">Remove</button>
        </div>
      `;

      tokensListEl.appendChild(item);
    });

    tokensListEl.querySelectorAll('.btn-activate').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.closest('button').dataset.id;
        try {
          await fetch('/api/tokens/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
          loadTokens();
          if (window.refreshStats) window.refreshStats();
        } catch (err) {
          alert('Failed to activate token: ' + err.message);
        }
      });
    });

    tokensListEl.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.closest('button').dataset.id;
        if (confirm('Are you sure you want to delete this token?')) {
          try {
            await fetch(`/api/tokens/${id}`, { method: 'DELETE' });
            loadTokens();
          } catch (err) {
            alert('Failed to delete token: ' + err.message);
          }
        }
      });
    });
  }

  btnGuest.addEventListener('click', async () => {
    try {
      await fetch('/api/tokens/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'guest' }),
      });
      loadTokens();
      if (window.refreshStats) window.refreshStats();
    } catch (err) {
      alert('Failed to switch to guest mode: ' + err.message);
    }
  });

  const btnRotate = document.getElementById('btn-rotate-token');
  if (btnRotate) {
    btnRotate.addEventListener('click', async () => {
      try {
        btnRotate.disabled = true;
        const res = await fetch('/api/tokens/rotate', { method: 'POST' });
        const data = await res.json();
        if (data.rotated) {
          alert(`Rotated to "${data.token.label}"!`);
        } else {
          alert(data.reason || 'Could not rotate token');
        }
        await loadTokens();
        if (window.refreshStats) window.refreshStats();
      } catch (err) {
        alert('Rotation error: ' + err.message);
      } finally {
        btnRotate.disabled = false;
      }
    });
  }

  const btnClearCooldowns = document.getElementById('btn-clear-cooldowns');
  if (btnClearCooldowns) {
    btnClearCooldowns.addEventListener('click', async () => {
      try {
        await fetch('/api/tokens/clear-cooldowns', { method: 'POST' });
        alert('All token rate-limit cooldowns have been reset!');
        await loadTokens();
        if (window.refreshStats) window.refreshStats();
      } catch (err) {
        alert('Failed to clear cooldowns');
      }
    });
  }

  window.loadTokensGlobal = loadTokens;

  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = document.getElementById('token-label').value.trim();
    const token = document.getElementById('token-jwt').value.trim();
    const setActive = document.getElementById('token-set-active').checked;

    if (!token) return;

    try {
      const res = await fetch('/api/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, token, setActive }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error?.message || 'Failed to save token');
      }

      addForm.reset();
      document.getElementById('token-set-active').checked = true;
      loadTokens();
    } catch (err) {
      alert(err.message);
    }
  });

  loadTokens();
}

/* =====================================================
   3. Interactive Chat with Thinking Mode Selection
   ===================================================== */
function initChat() {
  const chatWindow = document.getElementById('chat-window');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const modelSelect = document.getElementById('chat-model-select');
  const btnClear = document.getElementById('btn-clear-chat');
  const btnSend = document.getElementById('btn-chat-send');
  const thinkingControl = document.getElementById('chat-thinking-control');
  const inputModeTag = document.getElementById('input-mode-tag');

  let currentThinkingMode = 'max'; // 'low', 'high', 'max'
  let messages = [];

  // Handle Thinking Mode Segment Click
  const segmentBtns = thinkingControl.querySelectorAll('.segment-btn');
  segmentBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      segmentBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentThinkingMode = btn.dataset.mode;

      const labels = {
        low: 'Low Thinking',
        high: 'High Thinking',
        max: 'Max Thinking'
      };
      inputModeTag.textContent = labels[currentThinkingMode] || 'Thinking';
    });
  });

  // Suggestion chips
  document.querySelectorAll('.chip-suggestion').forEach(chip => {
    chip.addEventListener('click', () => {
      chatInput.value = chip.dataset.prompt;
      chatInput.focus();
      autoGrowTextarea(chatInput);
    });
  });

  function autoGrowTextarea(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  }

  chatInput.addEventListener('input', () => autoGrowTextarea(chatInput));

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chatForm.dispatchEvent(new Event('submit'));
    }
  });

  btnClear.addEventListener('click', () => {
    messages = [];
    chatWindow.innerHTML = `
      <div class="chat-hero">
        <div class="hero-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
        </div>
        <h2>zai2api Studio</h2>
        <p>Direct low-latency streaming to Z.ai with reasoning extraction and thinking modes.</p>
        <div class="hero-suggestions">
          <button class="chip-suggestion" data-prompt="Explain quantum entanglement in 3 simple sentences.">
            <span class="chip-title">Quantum Entanglement</span>
            <span class="chip-desc">Explain the core principles in 3 simple sentences</span>
          </button>
          <button class="chip-suggestion" data-prompt="Write an async/await retry function in TypeScript with exponential backoff.">
            <span class="chip-title">TypeScript Retry</span>
            <span class="chip-desc">Async helper with exponential backoff & jitter</span>
          </button>
          <button class="chip-suggestion" data-prompt="Solve a challenging logical riddle step-by-step.">
            <span class="chip-title">Logic Puzzle</span>
            <span class="chip-desc">Step-by-step deduction of a complex riddle</span>
          </button>
        </div>
      </div>
    `;

    document.querySelectorAll('.chip-suggestion').forEach(chip => {
      chip.addEventListener('click', () => {
        chatInput.value = chip.dataset.prompt;
        chatInput.focus();
        autoGrowTextarea(chatInput);
      });
    });
  });

  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const prompt = chatInput.value.trim();
    if (!prompt) return;

    chatInput.value = '';
    chatInput.style.height = 'auto';
    btnSend.disabled = true;

    // Remove hero if present
    const hero = chatWindow.querySelector('.chat-hero');
    if (hero) hero.remove();

    // 1. Add User Row
    messages.push({ role: 'user', content: prompt });
    const userRow = document.createElement('div');
    userRow.className = 'chat-row user-row';
    userRow.innerHTML = `
      <div class="avatar-badge">U</div>
      <div class="bubble-container">
        <div class="bubble-meta">You</div>
        <div class="bubble-card">${escapeHtml(prompt)}</div>
      </div>
    `;
    chatWindow.appendChild(userRow);
    chatWindow.scrollTop = chatWindow.scrollHeight;

    // 2. Prepare Assistant Row
    const selectedModel = modelSelect.value;
    const modeLabel = currentThinkingMode.toUpperCase();
    const assistantRow = document.createElement('div');
    assistantRow.className = 'chat-row assistant-row';
    assistantRow.innerHTML = `
      <div class="avatar-badge">AI</div>
      <div class="bubble-container">
        <div class="bubble-meta">zai2api • ${selectedModel} • ${modeLabel} THINK</div>
        <div class="bubble-card">
          <details class="thinking-drawer" style="display: none;" open>
            <summary>
              <span class="thinking-orb"></span>
              <span>Thought Process</span>
            </summary>
            <div class="thinking-body"></div>
          </details>
          <div class="msg-content">Thinking...</div>
        </div>
      </div>
    `;
    chatWindow.appendChild(assistantRow);
    chatWindow.scrollTop = chatWindow.scrollHeight;

    const thinkingDrawer = assistantRow.querySelector('.thinking-drawer');
    const thinkingBody = assistantRow.querySelector('.thinking-body');
    const contentEl = assistantRow.querySelector('.msg-content');

    let accumulatedAnswer = '';
    let accumulatedReasoning = '';

    try {
      const response = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages: messages,
          thinking_mode: currentThinkingMode,
          stream: true,
        }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `HTTP Error ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      contentEl.textContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === 'data: [DONE]') continue;
          if (trimmed.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(trimmed.slice(6));
              const delta = parsed.choices?.[0]?.delta;
              if (delta) {
                if (delta.reasoning_content) {
                  accumulatedReasoning += delta.reasoning_content;
                  thinkingDrawer.style.display = 'block';
                  thinkingBody.textContent = accumulatedReasoning;
                }
                if (delta.content) {
                  accumulatedAnswer += delta.content;
                  contentEl.innerHTML = formatMarkdown(accumulatedAnswer);
                }
              }
            } catch (e) {}
          }
        }
        chatWindow.scrollTop = chatWindow.scrollHeight;
      }

      if (!accumulatedAnswer && accumulatedReasoning) {
        contentEl.textContent = '(Completed reasoning without text output)';
      }

      messages.push({ role: 'assistant', content: accumulatedAnswer });
    } catch (err) {
      contentEl.innerHTML = `<span style="color: var(--danger-fg)">Error: ${escapeHtml(err.message)}</span>`;
    } finally {
      btnSend.disabled = false;
      chatInput.focus();
      if (window.refreshStats) window.refreshStats();
    }
  });
}

/* =====================================================
   4. Playground & cURL Generator
   ===================================================== */
function initTesting() {
  const methodSelect = document.getElementById('test-method');
  const pathInput = document.getElementById('test-path');
  const bodyInput = document.getElementById('test-body');
  const bodyGroup = document.getElementById('group-test-body');
  const curlOutput = document.getElementById('curl-output');
  const btnRun = document.getElementById('btn-run-test');
  const btnCopy = document.getElementById('btn-copy-curl');
  const responseOutput = document.getElementById('test-response-output');
  const statusBadge = document.getElementById('test-status-badge');
  const latencySpan = document.getElementById('test-latency');

  const presets = {
    simple: {
      method: 'POST',
      path: '/v1/chat/completions',
      body: JSON.stringify({
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'Say "Testing zai2api OK" in 4 words.' }],
        thinking_mode: 'max',
        stream: false,
      }, null, 2),
    },
    stream: {
      method: 'POST',
      path: '/v1/chat/completions',
      body: JSON.stringify({
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'Count from 1 to 5 slowly with brief descriptions.' }],
        thinking_mode: 'high',
        stream: true,
      }, null, 2),
    },
    'low-think': {
      method: 'POST',
      path: '/v1/chat/completions',
      body: JSON.stringify({
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'What is 15 * 37?' }],
        thinking_mode: 'low',
        stream: false,
      }, null, 2),
    },
    'max-think': {
      method: 'POST',
      path: '/v1/chat/completions',
      body: JSON.stringify({
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'Design a scalable multi-region caching system.' }],
        thinking_mode: 'max',
        stream: false,
      }, null, 2),
    },
    tools: {
      method: 'POST',
      path: '/v1/chat/completions',
      body: JSON.stringify({
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'What is the weather in Tokyo right now?' }],
        tools: [{
          type: 'function',
          function: {
            name: 'get_current_weather',
            description: 'Get the current weather in a given location',
            parameters: {
              type: 'object',
              properties: {
                location: { type: 'string', description: 'The city and state, e.g. San Francisco, CA' },
                unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
              },
              required: ['location']
            }
          }
        }],
        stream: false,
      }, null, 2),
    },
    models: {
      method: 'GET',
      path: '/v1/models',
      body: '',
    },
    health: {
      method: 'GET',
      path: '/health',
      body: '',
    },
  };

  function updateCurl() {
    const method = methodSelect.value;
    const path = pathInput.value;
    const host = window.location.origin || 'http://127.0.0.1:3000';
    const url = `${host}${path}`;

    if (method === 'GET') {
      bodyGroup.style.display = 'none';
      curlOutput.textContent = `curl -X GET "${url}" \\\n  -H "Authorization: Bearer any-token"`;
    } else {
      bodyGroup.style.display = 'flex';
      const body = bodyInput.value.trim();
      const escapedBody = body.replace(/'/g, "'\\''");
      curlOutput.textContent = `curl -X POST "${url}" \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer any-token" \\\n  -d '${escapedBody}'`;
    }
  }

  // Preset chips click
  document.querySelectorAll('.preset-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const presetKey = chip.dataset.preset;
      const preset = presets[presetKey];
      if (preset) {
        methodSelect.value = preset.method;
        pathInput.value = preset.path;
        bodyInput.value = preset.body;
        updateCurl();
      }
    });
  });

  methodSelect.addEventListener('change', updateCurl);
  pathInput.addEventListener('input', updateCurl);
  bodyInput.addEventListener('input', updateCurl);

  btnCopy.addEventListener('click', () => {
    navigator.clipboard.writeText(curlOutput.textContent).then(() => {
      const span = btnCopy.querySelector('span');
      if (span) {
        span.textContent = 'Copied!';
        setTimeout(() => { span.textContent = 'Copy'; }, 1500);
      }
    });
  });

  btnRun.addEventListener('click', async () => {
    const method = methodSelect.value;
    const path = pathInput.value;
    const body = bodyInput.value.trim();

    statusBadge.textContent = 'EXECUTING';
    statusBadge.className = 'badge-status idle';
    latencySpan.textContent = '';
    responseOutput.textContent = 'Dispatching request to zai2api...';
    btnRun.disabled = true;

    const startTime = Date.now();

    try {
      const options = { method, headers: {} };
      let isStream = false;

      if (method === 'POST') {
        options.headers['Content-Type'] = 'application/json';
        options.body = body;
        try {
          const parsed = JSON.parse(body);
          if (parsed.stream) isStream = true;
        } catch (e) {}
      }

      const res = await fetch(path, options);
      const latency = Date.now() - startTime;
      latencySpan.textContent = `${latency}ms`;

      statusBadge.textContent = `${res.status} ${res.statusText || (res.ok ? 'OK' : 'ERR')}`;
      statusBadge.className = `badge-status ${res.ok ? 'ok' : 'error'}`;

      if (isStream && res.body) {
        responseOutput.textContent = '';
        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          responseOutput.textContent += decoder.decode(value, { stream: true });
          responseOutput.scrollTop = responseOutput.scrollHeight;
        }
      } else {
        const text = await res.text();
        try {
          const json = JSON.parse(text);
          responseOutput.textContent = JSON.stringify(json, null, 2);
        } catch (e) {
          responseOutput.textContent = text;
        }
      }
    } catch (err) {
      statusBadge.textContent = 'FAIL';
      statusBadge.className = 'badge-status error';
      responseOutput.textContent = `Execution Error:\n${err.message}`;
    } finally {
      btnRun.disabled = false;
      if (window.refreshStats) window.refreshStats();
    }
  });

  presets.simple && (bodyInput.value = presets.simple.body);
  updateCurl();
}

/* =====================================================
   5. Server Logs Viewer
   ===================================================== */
function initLogs() {
  const terminal = document.getElementById('logs-terminal');
  const searchInput = document.getElementById('log-search');
  const levelFilter = document.getElementById('log-level-filter');
  const autoScrollCheck = document.getElementById('log-autoscroll');
  const btnClear = document.getElementById('btn-clear-logs');
  const btnCopy = document.getElementById('btn-copy-logs');

  let logs = [];

  function formatTime(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    return d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function renderLogs() {
    const filterText = searchInput.value.toLowerCase();
    const filterLevel = levelFilter.value;

    const filtered = logs.filter(l => {
      const matchesText = !filterText || (l.message && l.message.toLowerCase().includes(filterText));
      const matchesLevel = filterLevel === 'all' || l.level === filterLevel;
      return matchesText && matchesLevel;
    });

    if (filtered.length === 0) {
      terminal.innerHTML = '<div class="empty-state">No matching log lines</div>';
      return;
    }

    terminal.innerHTML = filtered.map(l => {
      const time = formatTime(l.timestamp);
      const tagClass = `tag-${l.level}`;
      const tagText = `[${l.level.toUpperCase()}]`.padEnd(8);
      return `<div class="log-line"><span class="log-time">${time}</span><span class="${tagClass}">${escapeHtml(tagText)}</span> ${escapeHtml(l.message)}</div>`;
    }).join('');

    if (autoScrollCheck.checked) {
      terminal.scrollTop = terminal.scrollHeight;
    }
  }

  const eventSource = new EventSource('/api/logs/stream');

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'init' && Array.isArray(data.logs)) {
        logs = data.logs;
        renderLogs();
      } else if (data.type === 'log' && data.entry) {
        logs.push(data.entry);
        if (logs.length > 500) logs.shift();
        renderLogs();
      } else if (data.type === 'clear') {
        logs = [];
        renderLogs();
      }
    } catch (e) {
      console.error('Log parse error:', e);
    }
  };

  searchInput.addEventListener('input', renderLogs);
  levelFilter.addEventListener('change', renderLogs);

  btnClear.addEventListener('click', async () => {
    try {
      await fetch('/api/logs/clear', { method: 'POST' });
      logs = [];
      renderLogs();
    } catch (err) {
      console.error('Failed to clear logs:', err);
    }
  });

  btnCopy.addEventListener('click', () => {
    const text = logs.map(l => `${formatTime(l.timestamp)} [${l.level.toUpperCase()}] ${l.message}`).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      alert('Logs copied to clipboard!');
    });
  });
}

function formatMarkdown(text) {
  if (!text) return '';
  let formatted = escapeHtml(text);
  // Format code blocks
  formatted = formatted.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    return `<pre><code>${code}</code></pre>`;
  });
  // Format inline code
  formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Format bold
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Format italic
  formatted = formatted.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Format linebreaks
  formatted = formatted.replace(/\n/g, '<br>');
  return formatted;
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
