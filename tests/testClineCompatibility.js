import assert from 'assert';
import { buildPromptWithTools } from '../src/toolCalling/promptWrapper.js';
import { parseResponse, normalizeToolArgs, findRecentFilePath } from '../src/toolCalling/responseParser.js';

console.log('=====================================================');
console.log('   Testing Cline Full Compatibility & Tool Resilience');
console.log('=====================================================\n');

// 1. Test buildPromptWithTools preserves Anthropic/Cline style tool_use and tool_result blocks
{
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Use frontend-design skill and make a snake game' }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'I will call the skills tool to load frontend-design.' },
        { type: 'text', text: "I'll invoke the frontend-design skill." },
        {
          type: 'tool_use',
          id: 'call_skills_123',
          name: 'skills',
          input: { skill: 'frontend-design', args: 'Make a snake game' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_skills_123',
          name: 'skills',
          content: '<command-instructions>Create distinctive frontend interfaces...</command-instructions>',
        },
      ],
    },
  ];

  const tools = [{ function: { name: 'editor' } }, { function: { name: 'skills' } }];
  const prompt = buildPromptWithTools({ messages, tools });

  assert.ok(prompt.includes('User: Use frontend-design skill and make a snake game'), 'User prompt must be preserved');
  assert.ok(prompt.includes('<|DSML|invoke name="skills">'), 'Assistant previous tool call must be rendered in DSML format');
  assert.ok(prompt.includes('<|DSML|parameter name="skill"><![CDATA[frontend-design]]></|DSML|parameter>'), 'tool_use parameters must be converted to DSML');
  assert.ok(prompt.includes('[Real Tool Execution Result (skills)]:'), 'tool_result header must be present');
  assert.ok(prompt.includes('Create distinctive frontend interfaces'), 'tool_result content must be preserved in context');
  assert.ok(!prompt.includes('User: \n'), 'Empty user turn must not be generated');

  console.log('✓ Test 1 Passed: Cline tool_use and tool_result blocks properly formatted in history');
}

// 2. Test parseResponse with missing <invoke> and inline newText="..."
{
  const rawOutput = `The skill guidance is loaded. Free rein on the brief — here's my design thinking before I build:

**Concept:** Meridian Snake.

<tool_call>editor newText="<!DOCTYPE html>
<html>
<head><title>Meridian</title></head>
<body><canvas id='board'></canvas></body>
</html>"
<|DSML|parameter name="path"><![CDATA[meridian/index.html]]></|DSML|parameter>
<|DSML|parameter name="new_text"><![CDATA[<!DOCTYPE html>
<html>
<head><title>Meridian Complete</title></head>
<body><canvas id='board' width='400' height='400'></canvas></body>
</html>]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`;

  const parsed = parseResponse(rawOutput, [{ function: { name: 'editor' } }]);
  assert.strictEqual(parsed.isToolCall, true, 'Should detect tool call even with missing invoke tag');
  assert.strictEqual(parsed.toolCalls.length, 1, 'Should have 1 tool call');
  assert.strictEqual(parsed.toolCalls[0].function.name, 'editor', 'Should resolve tool name to editor');

  const args = JSON.parse(parsed.toolCalls[0].function.arguments);
  assert.strictEqual(args.path, 'meridian/index.html', 'Should extract path correctly');
  assert.ok(args.new_text.includes('<canvas id=\'board\''), 'Should extract new_text from parameter');
  assert.strictEqual(args.newText, undefined, 'newText alias must be removed');
  assert.ok(parsed.content.includes('Free rein on the brief'), 'Pre-content rationale must be preserved');

  console.log('✓ Test 2 Passed: Recovered tool call with missing invoke and inline newText');
}

// 3. Test normalizeToolArgs guarantees path and new_text as strings for Cline Zod validator
{
  const emptyEditorArgs = {};
  const norm = normalizeToolArgs('editor', emptyEditorArgs, [], '', [
    { role: 'user', content: 'Please create snake-game/index.html' },
  ]);

  assert.strictEqual(typeof norm.path, 'string', 'path must always be a string');
  assert.strictEqual(norm.path, 'snake-game/index.html', 'path must auto-resolve from recent messages');
  assert.strictEqual(typeof norm.new_text, 'string', 'new_text must always be a string');
  assert.strictEqual(norm.newText, undefined, 'newText alias must be deleted');
  assert.strictEqual(norm.content, undefined, 'content alias must be deleted');

  console.log('✓ Test 3 Passed: normalizeToolArgs guarantees path & new_text as strings for Zod');
}

// 4. Test read_files auto-coercion for Cline
{
  const readArgs = { path: '/home/whoamix/project/package.json' };
  const norm = normalizeToolArgs('read_files', readArgs, [], '', []);
  assert.ok(Array.isArray(norm.files), 'files must be an Array for read_files');
  assert.strictEqual(norm.files[0].path, '/home/whoamix/project/package.json');
  assert.strictEqual(norm.path, undefined, 'path alias must be deleted from read_files args');

  console.log('✓ Test 4 Passed: read_files coerced to { files: [{ path }] }');
}

// 5. Test skills tool argument normalization
{
  const skillsArgs = { name: 'frontend-design', parameters: 'Make something good' };
  const norm = normalizeToolArgs('skills', skillsArgs, [], '', []);
  assert.strictEqual(norm.skill, 'frontend-design', 'skill name must be mapped');
  assert.strictEqual(norm.args, 'Make something good', 'args must be mapped');
  assert.strictEqual(norm.name, undefined, 'name alias must be deleted');
  assert.strictEqual(norm.parameters, undefined, 'parameters alias must be deleted');

  console.log('✓ Test 5 Passed: skills arguments mapped to { skill, args }');
}

console.log('\n=====================================================');
console.log('   ALL CLINE COMPATIBILITY TESTS PASSED!             ');
console.log('=====================================================');
