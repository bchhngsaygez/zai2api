import { parseResponse } from '../src/toolCalling/responseParser.js';

console.log('=====================================================');
console.log('   Testing Mutant <tool_call> Tag Parsing');
console.log('=====================================================\n');

const userEncounteredText = `I'll create a Snake game as a single self-contained HTML file (playable directly in a browser with keyboard controls) inside a new project folder in the workspace.<tool_call>editor>


</invoke>
path
/home/whoamix/.cline/data/workspaces/chat/snake-game/snake.html
new_text
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Snake Game</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #eee; }
</style>
</head>
<body>
  <h1>Snake</h1>
  <canvas id="board" width="400" height="400"></canvas>
</body>
</html>`;

const tools = [
  {
    type: 'function',
    function: {
      name: 'editor',
      description: 'Perform file operations',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          new_text: { type: 'string' },
        },
        required: ['path', 'new_text'],
      },
    },
  },
];

const result = parseResponse(userEncounteredText, tools);
console.log('Parse result:\n', JSON.stringify(result, null, 2));

if (!result.isToolCall || !result.toolCalls || result.toolCalls.length === 0) {
  console.error('\n>>> TEST FAILED: Mutant tool call was not detected!');
  process.exit(1);
}

const toolCall = result.toolCalls[0];
if (toolCall.function.name !== 'editor') {
  console.error(`\n>>> TEST FAILED: Expected tool name "editor", got "${toolCall.function.name}"`);
  process.exit(1);
}

let parsedArgs = {};
try {
  parsedArgs = JSON.parse(toolCall.function.arguments);
} catch (e) {
  console.error('\n>>> TEST FAILED: Arguments are not valid JSON:', toolCall.function.arguments);
  process.exit(1);
}

if (parsedArgs.path !== '/home/whoamix/.cline/data/workspaces/chat/snake-game/snake.html') {
  console.error('\n>>> TEST FAILED: Path mismatch:', parsedArgs.path);
  process.exit(1);
}

if (!parsedArgs.new_text || !parsedArgs.new_text.includes('<!DOCTYPE html>')) {
  console.error('\n>>> TEST FAILED: new_text content missing or invalid:', parsedArgs.new_text);
  process.exit(1);
}

console.log('\n>>> SUCCESS! Verified mutant tool call parsed perfectly:');
console.log('  Tool Name:', toolCall.function.name);
console.log('  Path:', parsedArgs.path);
console.log('  New Text Length:', parsedArgs.new_text.length);
console.log('  Content Before Tool Call:', result.content);
