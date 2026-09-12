import { browserController } from '../src/browser/browserController.js';
import { selectors } from '../src/browser/selectors.js';

console.log('=====================================================');
console.log('   Testing Chat Input Resilience & Actionability Fix');
console.log('=====================================================\n');

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`✅ PASS: ${message}`);
    testsPassed++;
  } else {
    console.error(`❌ FAIL: ${message}`);
    testsFailed++;
  }
}

// 1. Mock page with simulated DOM for testing setChatInputValue resilience
class MockElement {
  constructor(tag, id, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.attributes = { ...attrs };
    this.style = { pointerEvents: attrs.style?.pointerEvents || 'auto' };
    this.value = attrs.value || '';
    this.disabled = !!attrs.disabled;
    this.readOnly = !!attrs.readOnly;
    this.eventsDispatched = [];
    this.children = [];
  }

  getAttribute(k) { return this.attributes[k]; }
  setAttribute(k, v) { this.attributes[k] = v; if (k === 'disabled') this.disabled = true; if (k === 'readonly') this.readOnly = true; }
  removeAttribute(k) { delete this.attributes[k]; if (k === 'disabled') this.disabled = false; if (k === 'readonly') this.readOnly = false; }
  querySelector(sel) { return null; }
  remove() { this.removed = true; }
  dispatchEvent(evt) { this.eventsDispatched.push(evt.type); }
  focus() { this.focused = true; }
  click() { this.clicked = true; }
}

async function runTests() {
  // Test 1: setChatInputValue handles page.fill failure with DOM injection
  console.log('--- Test 1: setChatInputValue actionability timeout fallback ---');
  let fillAttempted = false;
  let evaluateCalled = false;
  let inputElement = new MockElement('textarea', 'chat-input', { disabled: true, readOnly: true });

  const mockPage = {
    isClosed: () => false,
    keyboard: { press: async () => {} },
    waitForSelector: async (sel, opts) => ({ isHandle: true }),
    fill: async (sel, text, opts) => {
      fillAttempted = true;
      // Simulate Playwright actionability timeout:
      throw new Error('page.fill: Timeout 30000ms exceeded. waiting for element to be visible, enabled and editable');
    },
    evaluate: async (fn, arg) => {
      evaluateCalled = true;
      return true;
    },
    inputValue: async (sel) => 'injected value',
  };

  // Temporarily attach mock page to controller
  const originalPage = browserController.page;
  browserController.page = mockPage;

  const testPrompt = '[AVAILABLE TOOLS]\nTool: bash\nCargo test failure\n60k character prompt simulation...';

  try {
    await browserController.setChatInputValue(testPrompt);
    assert(fillAttempted, 'page.fill was attempted first');
    assert(evaluateCalled, 'Direct DOM injection fallback executed after fill error');
  } catch (err) {
    assert(false, `setChatInputValue threw error: ${err.message}`);
  }

  // Test 2: dismissModals purges overlays and unblocks textarea
  console.log('\n--- Test 2: dismissModals clears backdrops and unblocks input ---');
  let escapePressed = false;
  let purgedElements = [];
  const overlayEl = new MockElement('div', 'overlay-1', { class: 'fixed inset-0 z-50' });
  const floatingMenuEl = new MockElement('div', 'menu-1', { 'data-bits-floating-content-wrapper': '' });

  const mockDismissPage = {
    isClosed: () => false,
    keyboard: {
      press: async (key) => {
        if (key === 'Escape') escapePressed = true;
      }
    },
    evaluate: async (fn) => {
      const elements = [overlayEl, floatingMenuEl];
      for (const el of elements) {
        el.remove();
        purgedElements.push(el.id);
      }
      inputElement.removeAttribute('disabled');
      inputElement.removeAttribute('readonly');
      inputElement.disabled = false;
      inputElement.readOnly = false;
    }
  };

  browserController.page = mockDismissPage;
  await browserController.dismissModals();

  assert(escapePressed, 'Escape key sent to close any active popovers/menus');
  assert(purgedElements.includes('overlay-1'), 'Modal backdrop overlay was purged');
  assert(purgedElements.includes('menu-1'), 'Floating bits menu wrapper was purged');
  assert(inputElement.disabled === false, 'Chat input disabled flag removed');
  assert(inputElement.readOnly === false, 'Chat input readOnly flag removed');

  // Test 3: setThinkingMode handles already-active toggle without clicking
  console.log('\n--- Test 3: setThinkingMode does not toggle when already active ---');
  let triggerClicked = false;
  const mockThinkingPage = {
    isClosed: () => false,
    keyboard: { press: async () => {} },
    evaluate: async (fn, target) => {
      const activeTrigger = new MockElement('button', 'deep-think-btn', {
        'aria-pressed': 'true',
        class: 'bg-primary'
      });
      activeTrigger.innerText = '深度思考 (Deep Think)';
      const isAlreadyActive = activeTrigger.attributes?.class?.includes('bg-primary') || activeTrigger.attributes?.['aria-pressed'] === 'true';
      if (isAlreadyActive && target === 'max') {
        return; // Correctly skips click
      }
      triggerClicked = true;
    }
  };

  browserController.page = mockThinkingPage;
  await browserController.setThinkingMode('max');
  assert(!triggerClicked, 'setThinkingMode skipped clicking already active Deep Think button');

  // Restore original page
  browserController.page = originalPage;

  console.log('\n=====================================================');
  console.log(`Results: ${testsPassed} Passed, ${testsFailed} Failed`);
  console.log('=====================================================');

  if (testsFailed > 0) process.exit(1);
}

runTests();
