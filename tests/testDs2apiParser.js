import assert from 'assert';
import { parseResponse, parseMarkupParameterValue, normalizeDSMLMarkup } from '../src/toolCalling/responseParser.js';
import { buildPromptWithTools, renderToolCallToDSML } from '../src/toolCalling/promptWrapper.js';

console.log('=====================================================');
console.log('   Running DS2API Parser & Tool Calling Unit Tests   ');
console.log('=====================================================\n');

// 1. Test CDATA code block with quotes and newlines
{
  const raw = `<|DSML|tool_calls>
  <|DSML|invoke name="editor">
    <|DSML|parameter name="path"><![CDATA[snake/index.html]]></|DSML|parameter>
    <|DSML|parameter name="new_text"><![CDATA[<!DOCTYPE html>
<html>
<head><title>Snake "Game"</title></head>
<body>
  <canvas id="board"></canvas>
  <script>const msg = "hello world";</script>
</body>
</html>]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`;

  const parsed = parseResponse(raw);
  assert.strictEqual(parsed.isToolCall, true, 'Should detect tool call');
  assert.strictEqual(parsed.toolCalls.length, 1, 'Should have 1 tool call');
  const tc = parsed.toolCalls[0];
  assert.strictEqual(tc.function.name, 'editor');
  const args = JSON.parse(tc.function.arguments);
  assert.strictEqual(args.path, 'snake/index.html');
  assert.ok(args.new_text.includes('<!DOCTYPE html>'), 'new_text should contain raw HTML');
  assert.ok(args.new_text.includes('const msg = "hello world";'), 'quotes inside CDATA must not be corrupted');
  console.log('✓ Test 1 Passed: DSML editor with unescaped CDATA HTML and quotes');
}

// 2. Test Array <item> parameters (commands)
{
  const raw = `<|DSML|tool_calls>
  <|DSML|invoke name="run_commands">
    <|DSML|parameter name="commands">
      <item><![CDATA[npm test]]></item>
      <item><![CDATA[echo "all done"]]></item>
    </|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`;

  const parsed = parseResponse(raw);
  assert.strictEqual(parsed.isToolCall, true);
  const args = JSON.parse(parsed.toolCalls[0].function.arguments);
  assert.ok(Array.isArray(args.commands), 'commands should be an Array');
  assert.strictEqual(args.commands.length, 2);
  assert.strictEqual(args.commands[0], 'npm test');
  assert.strictEqual(args.commands[1], 'echo "all done"');
  console.log('✓ Test 2 Passed: Array <item> elements converted to native JS Array');
}

// 3. Test Nested objects inside items (read_files)
{
  const raw = `<|DSML|tool_calls>
  <|DSML|invoke name="read_files">
    <|DSML|parameter name="files">
      <item><path><![CDATA[package.json]]></path></item>
      <item><path><![CDATA[src/index.js]]></path></item>
    </|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`;

  const parsed = parseResponse(raw);
  assert.strictEqual(parsed.isToolCall, true);
  const args = JSON.parse(parsed.toolCalls[0].function.arguments);
  assert.ok(Array.isArray(args.files), 'files should be an array');
  assert.strictEqual(args.files.length, 2);
  assert.strictEqual(args.files[0].path, 'package.json');
  assert.strictEqual(args.files[1].path, 'src/index.js');
  console.log('✓ Test 3 Passed: Nested objects inside <item> parsed correctly');
}

// 4. Test Mixed prose and pre-text rationale retention
{
  const raw = `I will build the snake game in a dedicated folder now.
Step 1 is creating the main canvas structure.

<|DSML|tool_calls>
  <|DSML|invoke name="editor">
    <|DSML|parameter name="path"><![CDATA[snake/game.js]]></|DSML|parameter>
    <|DSML|parameter name="new_text"><![CDATA[console.log('game');]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`;

  const parsed = parseResponse(raw);
  assert.strictEqual(parsed.isToolCall, true);
  assert.ok(parsed.content.includes('I will build the snake game'), 'Content rationale should be preserved');
  assert.ok(!parsed.content.includes('<|DSML|tool_calls>'), 'Tool call tags stripped from content');
  console.log('✓ Test 4 Passed: Pre-text rationale preserved in content, tags stripped');
}

// 5. Test Multiple parallel tool calls
{
  const raw = `<|DSML|tool_calls>
  <|DSML|invoke name="editor">
    <|DSML|parameter name="path"><![CDATA[a.txt]]></|DSML|parameter>
    <|DSML|parameter name="new_text"><![CDATA[hello A]]></|DSML|parameter>
  </|DSML|invoke>
  <|DSML|invoke name="editor">
    <|DSML|parameter name="path"><![CDATA[b.txt]]></|DSML|parameter>
    <|DSML|parameter name="new_text"><![CDATA[hello B]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`;

  const parsed = parseResponse(raw);
  assert.strictEqual(parsed.isToolCall, true);
  assert.strictEqual(parsed.toolCalls.length, 2, 'Should extract both parallel tool calls');
  assert.strictEqual(JSON.parse(parsed.toolCalls[0].function.arguments).path, 'a.txt');
  assert.strictEqual(JSON.parse(parsed.toolCalls[1].function.arguments).path, 'b.txt');
  console.log('✓ Test 5 Passed: Multiple parallel tool calls extracted');
}

// 6. Test Canonical XML <tool_calls>
{
  const raw = `<tool_calls>
  <invoke name="ask_followup_question">
    <parameter name="question"><![CDATA[Which stack do you want?]]></parameter>
    <parameter name="options">
      <item><![CDATA[Canvas]]></item>
      <item><![CDATA[React]]></item>
    </parameter>
  </invoke>
</tool_calls>`;

  const parsed = parseResponse(raw);
  assert.strictEqual(parsed.isToolCall, true);
  const args = JSON.parse(parsed.toolCalls[0].function.arguments);
  assert.strictEqual(args.question, 'Which stack do you want?');
  assert.deepStrictEqual(args.options, ['Canvas', 'React']);
  console.log('✓ Test 6 Passed: Canonical XML <tool_calls> supported');
}

// 7. Test Narrow repair: missing opening <tool_calls> tag
{
  const raw = `<|DSML|invoke name="editor">
  <|DSML|parameter name="path"><![CDATA[test.js]]></|DSML|parameter>
  <|DSML|parameter name="new_text"><![CDATA[console.log(1);]]></|DSML|parameter>
</|DSML|invoke>
</|DSML|tool_calls>`;

  const parsed = parseResponse(raw);
  assert.strictEqual(parsed.isToolCall, true);
  const args = JSON.parse(parsed.toolCalls[0].function.arguments);
  assert.strictEqual(args.path, 'test.js');
  console.log('✓ Test 7 Passed: Narrow repair of missing opening tag');
}

// 8. Test Auto-resolving missing path from messages history
{
  const messages = [
    { role: 'user', content: 'Create a snake game at snake-game/snake.html' }
  ];
  const raw = `<|DSML|tool_calls>
  <|DSML|invoke name="editor">
    <|DSML|parameter name="new_text"><![CDATA[<h1>Snake</h1>]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`;

  const parsed = parseResponse(raw, [{ function: { name: 'editor' } }], messages);
  assert.strictEqual(parsed.isToolCall, true);
  const args = JSON.parse(parsed.toolCalls[0].function.arguments);
  assert.strictEqual(args.path, 'snake-game/snake.html', 'Should auto-resolve path from history');
  console.log('✓ Test 8 Passed: Auto-resolved missing path from message history');
}

// 9. Test Prompt Builder with DSML history rendering
{
  const prompt = buildPromptWithTools({
    tools: [
      { function: { name: 'editor', description: 'Create or edit file' } },
      { function: { name: 'run_commands', description: 'Execute commands' } }
    ],
    messages: [
      { role: 'user', content: 'Create a game' },
      {
        role: 'assistant',
        tool_calls: [{
          function: {
            name: 'editor',
            arguments: JSON.stringify({ path: 'index.html', new_text: '<!DOCTYPE html>' })
          }
        }]
      },
      { role: 'tool', tool_call_id: 'call_123', content: 'File created successfully' }
    ]
  });

  assert.ok(prompt.includes('<|DSML|tool_calls>'), 'Prompt must contain DSML tool instructions');
  assert.ok(prompt.includes('<![CDATA['), 'Prompt must enforce CDATA');
  assert.ok(prompt.includes('Output integrity guard'), 'Prompt must include output integrity guard');
  assert.ok(prompt.includes('index.html'), 'History assistant turn rendered DSML tool call');
  console.log('✓ Test 9 Passed: buildPromptWithTools renders aligned DSML prompt & history');
}

console.log('\n=====================================================');
console.log('   ALL 9 UNIT TESTS PASSED SUCCESSFULLY!   ');
console.log('=====================================================\n');
