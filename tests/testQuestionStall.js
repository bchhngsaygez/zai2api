import { parseResponse } from '../src/toolCalling/responseParser.js';

console.log('=====================================================');
console.log('   Testing Conversational Question Stall Recovery');
console.log('=====================================================\n');

const stalledText = `I'll build you a complete snake game. Quick plan before I start:

1. **Decide location & stack** — per this workspace's convention, I'll confirm where the project should live (a new dedicated folder inside the current workspace by default).
2. **Implement the game** — grid-based board, arrow/WASD controls, food spawning, score, game over + restart, increasing speed.
3. **Verify** — I'll check the files are complete and syntactically valid.

One quick decision needed from you:`;

const tools = [
  {
    type: 'function',
    function: {
      name: 'ask_followup_question',
      description: 'Ask the user a question to gather additional information or clarify ambiguity',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_to_file',
      description: 'Write file',
      parameters: { type: 'object' },
    },
  },
];

const result = parseResponse(stalledText, tools);
console.log('Parse result:\n', JSON.stringify(result, null, 2));

if (!result.isToolCall || !result.toolCalls || result.toolCalls.length === 0) {
  console.error('\n>>> TEST FAILED: Question stall was not converted into a tool call!');
  process.exit(1);
}

const toolCall = result.toolCalls[0];
if (toolCall.function.name !== 'ask_followup_question') {
  console.error(`\n>>> TEST FAILED: Expected tool name "ask_followup_question", got "${toolCall.function.name}"`);
  process.exit(1);
}

let parsedArgs = {};
try {
  parsedArgs = JSON.parse(toolCall.function.arguments);
} catch (e) {
  console.error('\n>>> TEST FAILED: Arguments are not valid JSON:', toolCall.function.arguments);
  process.exit(1);
}

if (!parsedArgs.question || !Array.isArray(parsedArgs.options) || parsedArgs.options.length === 0) {
  console.error('\n>>> TEST FAILED: Invalid question or options array:', parsedArgs);
  process.exit(1);
}

console.log('\n>>> SUCCESS! Verified stall recovered into tool call:');
console.log('  Tool Name:', toolCall.function.name);
console.log('  Question:', parsedArgs.question);
console.log('  Options Count:', parsedArgs.options.length);
console.log('  First Option:', parsedArgs.options[0]);
