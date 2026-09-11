import { parseResponse } from '../src/toolCalling/responseParser.js';

console.log('=====================================================');
console.log('   Testing <tool_call>ask_question Parsing');
console.log('=====================================================\n');

const userEncounteredText = `<tool_call>ask_question
question: Where would you like the snake game project to live, and which version do you want?
options: ["New folder in this workspace — HTML/JS/Canvas snake game (runs in any browser, no install needed)", "New folder in this workspace — Python (pygame) snake game (needs \`pip install pygame\`)", "New folder in this workspace — pick whatever stack you think is best", "Different location — I'll tell you the path"]`;

const tools = [
  {
    type: 'function',
    function: {
      name: 'ask_question',
      description: 'Ask the user a question with selectable options',
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

const result = parseResponse(userEncounteredText, tools);
console.log('Parse result:\n', JSON.stringify(result, null, 2));

if (!result.isToolCall || !result.toolCalls || result.toolCalls.length === 0) {
  console.error('\n>>> TEST FAILED: Tool call not detected!');
  process.exit(1);
}

const toolCall = result.toolCalls[0];
if (toolCall.function.name !== 'ask_question') {
  console.error(`\n>>> TEST FAILED: Expected tool name "ask_question", got "${toolCall.function.name}"`);
  process.exit(1);
}

let parsedArgs = {};
try {
  parsedArgs = JSON.parse(toolCall.function.arguments);
} catch (e) {
  console.error('\n>>> TEST FAILED: Arguments are not valid JSON:', toolCall.function.arguments);
  process.exit(1);
}

if (!parsedArgs.question || !Array.isArray(parsedArgs.options)) {
  console.error('\n>>> TEST FAILED: Missing question or options array in arguments:', parsedArgs);
  process.exit(1);
}

console.log('\n>>> SUCCESS! Verified ask_question tool call detected:');
console.log('  Tool Name:', toolCall.function.name);
console.log('  Question:', parsedArgs.question);
console.log('  Options Count:', parsedArgs.options.length);
console.log('  First Option:', parsedArgs.options[0]);
