import { parseResponse } from '../src/toolCalling/responseParser.js';

const userOutput = `Completed

I'll create a snake game. First, let me check the workspace structure to decide where to place it and whether there's an existing project to integrate with.

__Plan:__

1. Inspect the working directory to understand the context
2. Create a self-contained HTML/CSS/JS snake game (runs directly in the browser — no dependencies)
3. Verify the files were created correctly

<invoke name="run_commands"> <parameter name="commands">["ls -la /home/whoamix/glm2api"]</parameter> </invoke> </invoke>

**continue

Thinking

Completed

<invoke name="run_commands"> <parameter name="commands">["ls -la /home/whoamix/glm2api"]</parameter> </invoke>`;

console.log('Testing parseResponse on user output...');
const result = parseResponse(userOutput);
console.log('Result:', JSON.stringify(result, null, 2));

if (result.isToolCall && result.toolCalls.length > 0) {
  console.log('\n>>> SUCCESS! Parsed tool name:', result.toolCalls[0].function.name);
  console.log('>>> Arguments:', result.toolCalls[0].function.arguments);
} else {
  console.error('\n>>> FAILED: Tool call not detected!');
  process.exit(1);
}
