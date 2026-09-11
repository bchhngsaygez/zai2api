import { parseResponse, findRecentFilePath, normalizeToolArgs } from '../src/toolCalling/responseParser.js';

console.log('=====================================================');
console.log('   Testing Missing Arguments & Bare Tool Calls');
console.log('=====================================================\n');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${message}`);
    failed++;
  }
}

const mockMessages = [
  { role: 'user', content: 'Create a snake game in snake-game/snake.html' },
  {
    role: 'assistant',
    content: 'Sure! I will create the file at /home/whoamix/.cline/data/workspaces/chat/snake-game/snake.html',
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'editor',
          arguments: JSON.stringify({
            path: '/home/whoamix/.cline/data/workspaces/chat/snake-game/snake.html',
            new_text: '// part 1\n<!DOCTYPE html>...',
          }),
        },
      },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'call_1',
    content: 'Error: file already exists, editor requires old_text for existing files.',
  },
];

// Test 1: findRecentFilePath from messages
console.log('--- Test 1: findRecentFilePath ---');
const recentPath = findRecentFilePath(mockMessages);
assert(
  recentPath === '/home/whoamix/.cline/data/workspaces/chat/snake-game/snake.html',
  `Found recent path from messages: ${recentPath}`
);

// Test 2: Bare trailing <tool_call>read_files with aborted preceding tag
console.log('\n--- Test 2: Trailing bare <tool_call>read_files ---');
const textWithBareTag = 'The last edit failed because the file already exists (the editor requires old_text for existing files). Let me inspect its current state before continuing:<tool_call>run_commands... <tool_call>read_files';
const res2 = parseResponse(textWithBareTag, [], mockMessages);

assert(res2.isToolCall === true, 'Detected tool call for bare trailing tag');
assert(res2.toolCalls && res2.toolCalls.length > 0, 'Emitted at least one tool call');
if (res2.toolCalls && res2.toolCalls[0]) {
  const tc = res2.toolCalls[0];
  assert(tc.function.name === 'read_files', `Tool name is read_files (got ${tc.function.name})`);
  const args = JSON.parse(tc.function.arguments);
  assert(Array.isArray(args.files) && args.files.length > 0, 'files array is present');
  assert(
    args.files[0].path === '/home/whoamix/.cline/data/workspaces/chat/snake-game/snake.html',
    `Auto-populated target path in files: ${args.files[0]?.path}`
  );
  assert(
    !res2.content.includes('<tool_call>'),
    `Pre-content is cleaned of raw tool tags: "${res2.content}"`
  );
}

// Test 3: <editor> direct tag containing HTML markup with path in pre-text
console.log('\n--- Test 3: <editor> with HTML markup and path in text ---');
const textWithEditorTag = `I'll build a self-contained Snake game in a dedicated snake-game folder at /home/whoamix/.cline/data/workspaces/chat/snake-game/snake.html. Creating it now:
<editor>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Snake Game</title>
<style>body { margin: 0; }</style>
</head>
<body>
<canvas id="board"></canvas>
</body>
</html>
</editor>`;

const res3 = parseResponse(textWithEditorTag, [], []);
assert(res3.isToolCall === true, 'Detected tool call for <editor> direct tag');
if (res3.toolCalls && res3.toolCalls[0]) {
  const tc = res3.toolCalls[0];
  assert(tc.function.name === 'editor', `Tool name is editor (got ${tc.function.name})`);
  const args = JSON.parse(tc.function.arguments);
  assert(
    args.path === '/home/whoamix/.cline/data/workspaces/chat/snake-game/snake.html',
    `Path resolved from text: ${args.path}`
  );
  assert(
    typeof args.new_text === 'string' && args.new_text.includes('<canvas id="board">'),
    `new_text contains full HTML markup (length: ${args.new_text?.length})`
  );
  assert(args.content === undefined, 'content alias removed in favor of new_text');
}

// Test 4: JSON tool call with content instead of new_text and missing path
console.log('\n--- Test 4: JSON editor tool call with content alias and missing path ---');
const jsonText = `\`\`\`json
{
  "name": "editor",
  "arguments": {
    "content": "console.log('hello snake');"
  }
}
\`\`\``;
const res4 = parseResponse(jsonText, [], mockMessages);
assert(res4.isToolCall === true, 'Detected tool call for JSON editor');
if (res4.toolCalls && res4.toolCalls[0]) {
  const tc = res4.toolCalls[0];
  const args = JSON.parse(tc.function.arguments);
  assert(
    args.path === '/home/whoamix/.cline/data/workspaces/chat/snake-game/snake.html',
    `Path resolved from messages: ${args.path}`
  );
  assert(args.new_text === "console.log('hello snake');", `new_text mapped from content: ${args.new_text}`);
  assert(args.content === undefined, 'content alias cleaned up');
}

// Test 5: run_commands command -> commands array normalization
console.log('\n--- Test 5: run_commands command -> commands normalization ---');
const cmdText = `\`\`\`json
{
  "name": "run_commands",
  "arguments": {
    "command": "ls -la"
  }
}
\`\`\``;
const res5 = parseResponse(cmdText, [], []);
assert(res5.isToolCall === true, 'Detected run_commands tool call');
if (res5.toolCalls && res5.toolCalls[0]) {
  const tc = res5.toolCalls[0];
  const args = JSON.parse(tc.function.arguments);
  assert(Array.isArray(args.commands) && args.commands[0] === 'ls -la', `commands is array: ${JSON.stringify(args.commands)}`);
}

console.log('\n=====================================================');
console.log(`Results: ${passed} Passed, ${failed} Failed`);
console.log('=====================================================');

if (failed > 0) {
  process.exit(1);
}
