import assert from 'assert';
import { parseResponse, normalizeToolArgs, extractSimulatedCommand, extractSimulatedFileWrite } from '../src/toolCalling/responseParser.js';
import { buildPromptWithTools } from '../src/toolCalling/promptWrapper.js';

console.log('=====================================================');
console.log('   Testing OpenCode Tool Calling & Anti-Simulation   ');
console.log('=====================================================\n');

const openCodeTools = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Executes a given bash command in a persistent shell session.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute' },
          workdir: { type: 'string', description: 'Working directory' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read contents of a file.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to file' }
        },
        required: ['filePath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: 'Write content to a file.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to file' },
          content: { type: 'string', description: 'File content' }
        },
        required: ['filePath', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description: 'Edit a file by replacing oldString with newString.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to file' },
          oldString: { type: 'string', description: 'Exact string to find' },
          newString: { type: 'string', description: 'Replacement string' }
        },
        required: ['filePath', 'oldString', 'newString']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files matching pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' }
        },
        required: ['pattern']
      }
    }
  }
];

// Test 1: User's exact raw snippet (terminal command + simulated compiler output on one line)
{
  const raw = `$ . "$HOME/.cargo/env" && cargo test 2>&1 Compiling ratchet-crypto v0.1.0 (/home/whoamix/Documents/Default Project/ghostchat/crates/ratchet-crypto) Compiling ghostchat v0.1.0 (/home/whoamix/Documents/Default Project/ghostchat/crates/ghostchat) warning: function \`exclude_from_capture\` is never used --> crates/ghostchat/src/display.rs:9:8 | 9 | pub fn exclude_from_capture(_hwnd: isize) -> Result<(), String> { | ^^^^^^^^^^^^^^^^^^^^ | = note: \`#[warn(dead_code)]\` (part of \`#[warn(unused)]\`) on by default warning: \`ghostchat\` (bin "ghostchat" test) generated 1 warning Finished \`test\` profile [unoptimized + debuginfo] target(s) in 0.57s Running unittests src/main.rs (target/debug/deps/ghostchat-71728a1ea87305f9) running 2 tests test transport::tests::frame_roundtrip ... ok test burn::tests::nuke_clears_viewport ... ok test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s Running unittests src/lib.rs (target/debug/deps/memguard-a1a6f66439c6fe26) running 1 test test tests::zeroizes_on_drop ... ok
All 7 unit tests pass. Now I should do an end-to-end verification...`;

  const parsed = parseResponse(raw, openCodeTools);
  assert.strictEqual(parsed.isToolCall, true, 'Should detect simulated command execution as a tool call');
  assert.strictEqual(parsed.toolCalls.length, 1, 'Should produce 1 tool call');
  assert.strictEqual(parsed.toolCalls[0].function.name, 'bash', 'Tool name should be bash');
  const args = JSON.parse(parsed.toolCalls[0].function.arguments);
  assert.strictEqual(args.command, '. "$HOME/.cargo/env" && cargo test 2>&1', 'Should cleanly isolate the cargo test command');
  console.log('✓ Test 1 Passed: User snippet cleanly intercepted and converted to bash tool call');
}

// Test 2: Multi-line terminal simulation with pre-text
{
  const raw = `I will run the unit tests to verify our latest changes:

$ cargo test 2>&1
Compiling ghostchat v0.1.0 ...
Finished \`test\` profile
running 2 tests ... ok
test result: ok. 2 passed`;

  const parsed = parseResponse(raw, openCodeTools);
  assert.strictEqual(parsed.isToolCall, true);
  assert.strictEqual(parsed.toolCalls[0].function.name, 'bash');
  const args = JSON.parse(parsed.toolCalls[0].function.arguments);
  assert.strictEqual(args.command, 'cargo test 2>&1');
  assert.ok(parsed.content.includes('I will run the unit tests'), 'Pre-text preserved');
  console.log('✓ Test 2 Passed: Multi-line simulated terminal session intercepted');
}

// Test 3: Markdown code block \`\`\`bash
{
  const raw = `Let's run the cargo test:
\`\`\`bash
cargo test --package ratchet-crypto
\`\`\``;

  const parsed = parseResponse(raw, openCodeTools);
  assert.strictEqual(parsed.isToolCall, true);
  assert.strictEqual(parsed.toolCalls[0].function.name, 'bash');
  const args = JSON.parse(parsed.toolCalls[0].function.arguments);
  assert.strictEqual(args.command, 'cargo test --package ratchet-crypto');
  console.log('✓ Test 3 Passed: Markdown bash code block converted to tool call');
}

// Test 4: OpenCode 'write' argument normalization
{
  const rawArgs = {
    path: 'crates/ghostchat/src/main.rs',
    new_text: 'fn main() { println!("ghostchat"); }'
  };
  const norm = normalizeToolArgs('write', rawArgs, openCodeTools);
  assert.strictEqual(norm.filePath, 'crates/ghostchat/src/main.rs', 'filePath must be populated');
  assert.strictEqual(norm.content, 'fn main() { println!("ghostchat"); }', 'content must be populated');
  assert.strictEqual(norm.path, undefined, 'path alias should be removed');
  assert.strictEqual(norm.new_text, undefined, 'new_text alias should be removed');
  console.log('✓ Test 4 Passed: OpenCode write tool arguments normalized to filePath & content');
}

// Test 5: OpenCode 'edit' argument normalization
{
  const rawArgs = {
    target_file: 'crates/ghostchat/src/display.rs',
    old_text: 'pub fn exclude_from_capture',
    new_text: '#[allow(dead_code)]\npub fn exclude_from_capture'
  };
  const norm = normalizeToolArgs('edit', rawArgs, openCodeTools);
  assert.strictEqual(norm.filePath, 'crates/ghostchat/src/display.rs', 'filePath must be populated');
  assert.strictEqual(norm.oldString, 'pub fn exclude_from_capture', 'oldString must be populated');
  assert.strictEqual(norm.newString, '#[allow(dead_code)]\npub fn exclude_from_capture', 'newString must be populated');
  console.log('✓ Test 5 Passed: OpenCode edit tool arguments normalized to filePath, oldString, newString');
}

// Test 6: OpenCode 'read' argument normalization
{
  const rawArgs = { path: 'Cargo.toml' };
  const norm = normalizeToolArgs('read', rawArgs, openCodeTools);
  assert.strictEqual(norm.filePath, 'Cargo.toml', 'filePath must be set for read');
  assert.strictEqual(norm.path, undefined, 'path alias should be removed');
  console.log('✓ Test 6 Passed: OpenCode read tool arguments normalized to filePath');
}

// Test 7: Simulated file write recovery
{
  const raw = `Rewriting crates/ghostchat/src/main.rs with split read/write halves:

\`\`\`rust
use std::net::TcpStream;

fn main() {
    println!("ghostchat running");
}
\`\`\``;

  const parsed = parseResponse(raw, openCodeTools);
  assert.strictEqual(parsed.isToolCall, true);
  assert.strictEqual(parsed.toolCalls[0].function.name, 'write');
  const args = JSON.parse(parsed.toolCalls[0].function.arguments);
  assert.strictEqual(args.filePath, 'crates/ghostchat/src/main.rs');
  assert.ok(args.content.includes('fn main()'), 'content should have rust code');
  console.log('✓ Test 7 Passed: Raw code block with file intent converted to write tool call');
}

// Test 8: Prompt Wrapper produces OpenCode examples & anti-simulation directives
{
  const prompt = buildPromptWithTools({
    tools: openCodeTools,
    messages: [
      { role: 'user', content: 'Run cargo test' }
    ]
  });

  assert.ok(prompt.includes('Example A — Write File ("write")'), 'Prompt must contain OpenCode write example');
  assert.ok(prompt.includes('Example A2 — Edit File In-Place ("edit")'), 'Prompt must contain OpenCode edit example');
  assert.ok(prompt.includes('Example B — Execute Command ("bash")'), 'Prompt must contain OpenCode bash example');
  assert.ok(prompt.includes('STRICT PROHIBITION ON COMMAND SIMULATION & TERMINAL ROLEPLAY'), 'Prompt must contain anti-simulation rule');
  assert.ok(prompt.includes('CRITICAL ACTION MANDATE — MUST EXECUTE TOOLS NOW'), 'Prompt must contain final recency action mandate');
  console.log('✓ Test 8 Passed: Prompt contains concrete OpenCode examples and strict anti-simulation directives');
}

console.log('\n=====================================================');
console.log('   ALL 8 OPENCODE COMPATIBILITY TESTS PASSED!        ');
console.log('=====================================================\n');
