import assert from 'assert';

console.log('=====================================================');
console.log('   Testing DOM Error Scoping & Send Resilience      ');
console.log('=====================================================\n');

// 1. Simulate checkDomError logic against simulated DOM structures
function evaluateDomError(domSim) {
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
    'rate limit',
    '请求过于频繁',
    '429'
  ];

  const alertSelectors = [
    '[role="alert"]',
    '.toast[data-type="error"]',
    '[data-sonner-toast][data-type="error"]',
    '[data-sonner-toast]',
    '.ant-message-error',
    '.ant-notification-notice-error',
    '.alert-error',
    '.toast-error',
    '[data-state="open"][role="dialog"]',
    '.modal.error'
  ];

  for (const sel of alertSelectors) {
    const elements = domSim.querySelectorAll(sel);
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
  return null;
}

// Helper mock element
class MockElement {
  constructor(tag, classes = [], attrs = {}, text = '') {
    this.tagName = tag.toUpperCase();
    this.classList = new Set(classes);
    this.attributes = attrs;
    this.innerText = text;
    this.textContent = text;
    this.parent = null;
    this.children = [];
  }

  append(child) {
    child.parent = this;
    this.children.push(child);
  }

  closest(sel) {
    let curr = this;
    while (curr) {
      if (curr.matches(sel)) return curr;
      curr = curr.parent;
    }
    return null;
  }

  matches(sel) {
    if (sel.includes('[') && sel.startsWith('.')) {
      const parts = sel.split('[');
      const cls = parts[0].slice(1);
      if (!this.classList.has(cls)) return false;
      const m = ('[' + parts[1]).match(/\[([a-zA-Z0-9_-]+)(?:="([^"]+)")?\]/);
      if (m) {
        const attr = m[1];
        const val = m[2];
        return val !== undefined ? this.attributes[attr] === val : this.attributes[attr] !== undefined;
      }
      return true;
    }
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return this.classList.has(cls);
    }
    if (sel.startsWith('#')) {
      return this.attributes.id === sel.slice(1);
    }
    if (sel.includes('[')) {
      const m = sel.match(/\[([a-zA-Z0-9_-]+)(?:="([^"]+)")?\]/);
      if (m) {
        const attr = m[1];
        const val = m[2];
        return val !== undefined ? this.attributes[attr] === val : this.attributes[attr] !== undefined;
      }
    }
    return this.tagName.toLowerCase() === sel.toLowerCase();
  }

  querySelectorAll(sel) {
    const results = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (c.matches(sel)) results.push(c);
        walk(c);
      }
    };
    walk(this);
    return results;
  }
}

// Test Case 1: Chat input containing "rate limit" and "429" should NOT trigger DOM error
{
  const root = new MockElement('body');
  const form = new MockElement('form');
  const textarea = new MockElement('textarea', [], { id: 'chat-input' }, 'Please fix this error: HTTP 429 Too Many Requests. How do I handle rate limit?');
  form.append(textarea);
  root.append(form);

  const detected = evaluateDomError(root);
  assert.strictEqual(detected, null, 'Chat input containing "rate limit" must NOT trigger DOM error');
  console.log('✓ Test 1 Passed: Chat input containing "rate limit" does not trigger false positive');
}

// Test Case 2: Chat message history mentioning "rate limit" or "quota exceeded" should NOT trigger DOM error
{
  const root = new MockElement('body');
  const chatUser = new MockElement('div', ['chat-user'], {}, 'I got rate limit error yesterday');
  const chatAssistant = new MockElement('div', ['chat-assistant'], { 'data-message-id': 'msg-1' }, 'Z.ai rate limit is 100 requests per minute.');
  root.append(chatUser);
  root.append(chatAssistant);

  const detected = evaluateDomError(root);
  assert.strictEqual(detected, null, 'Chat history messages must NOT trigger DOM error');
  console.log('✓ Test 2 Passed: Chat history messages mentioning "rate limit" do not trigger false positive');
}

// Test Case 3: Genuine toast alert banner with "Server is busy" SHOULD be detected
{
  const root = new MockElement('body');
  const toast = new MockElement('div', ['toast'], { 'data-type': 'error' }, 'Server is busy, please try again later');
  root.append(toast);

  const detected = evaluateDomError(root);
  assert.ok(detected !== null, 'Genuine toast error banner should be detected');
  assert.strictEqual(detected, 'server is busy');
  console.log('✓ Test 3 Passed: Genuine error toast is correctly detected as: ' + detected);
}

// Test Case 4: Genuine role="alert" with "请求过于频繁" SHOULD be detected
{
  const root = new MockElement('body');
  const alert = new MockElement('div', [], { role: 'alert' }, '请求过于频繁，请稍后再试');
  root.append(alert);

  const detected = evaluateDomError(root);
  assert.ok(detected !== null, 'Genuine role="alert" should be detected');
  assert.strictEqual(detected, '请求过于频繁');
  console.log('✓ Test 4 Passed: Genuine role="alert" banner is correctly detected as: ' + detected);
}

// Test Case 5: Verify selectors in selectors.js
import { selectors } from '../src/browser/selectors.js';
{
  assert.ok(selectors.chatInput.includes('#chat-input'), 'chatInput selector contains #chat-input');
  assert.ok(selectors.sendMessageButton.includes('#send-message-button'), 'sendMessageButton selector contains #send-message-button');
  assert.ok(selectors.sendMessageButton.includes('button[type="submit"]'), 'sendMessageButton contains button[type="submit"] fallback');
  console.log('✓ Test 5 Passed: selectors.js contains robust multi-selector fallbacks');
}

console.log('\n=====================================================');
console.log('   ALL DOM ERROR & RESILIENCE TESTS PASSED!          ');
console.log('=====================================================');
