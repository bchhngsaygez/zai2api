import crypto from 'crypto';

/**
 * DS2API-aligned prompt wrapper for GLM models on Z.ai.
 * Formats tool definitions, schemas, execution rules, and conversation history
 * using DSML XML with <![CDATA[...]]> to prevent code escaping errors,
 * eliminate unescaped JSON newline crashes, and achieve flawless tool execution.
 */

function escapeXmlAttr(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function wrapCDATA(text = '') {
  const str = String(text);
  if (!str) return '';
  if (str.includes(']]>')) {
    return `<![CDATA[${str.split(']]>').join(']]]]><![CDATA[>')}]]>`;
  }
  return `<![CDATA[${str}]]>`;
}

export function renderDSMLParameter(name, val, indent = '    ') {
  if (val === null || val === undefined) {
    return `${indent}<|DSML|parameter name="${escapeXmlAttr(name)}"></|DSML|parameter>`;
  }
  if (typeof val === 'string') {
    return `${indent}<|DSML|parameter name="${escapeXmlAttr(name)}">${wrapCDATA(val)}</|DSML|parameter>`;
  }
  if (typeof val === 'number' || typeof val === 'boolean') {
    return `${indent}<|DSML|parameter name="${escapeXmlAttr(name)}">${val}</|DSML|parameter>`;
  }
  if (Array.isArray(val)) {
    const items = val.map(item => {
      if (typeof item === 'string') {
        return `${indent}  <item>${wrapCDATA(item)}</item>`;
      }
      if (item && typeof item === 'object') {
        const sub = Object.entries(item)
          .map(([k, v]) => `${indent}    <${k}>${wrapCDATA(typeof v === 'object' ? JSON.stringify(v) : v)}</${k}>`)
          .join('\n');
        return `${indent}  <item>\n${sub}\n${indent}  </item>`;
      }
      return `${indent}  <item>${item}</item>`;
    }).join('\n');
    return `${indent}<|DSML|parameter name="${escapeXmlAttr(name)}">\n${items}\n${indent}</|DSML|parameter>`;
  }
  if (typeof val === 'object') {
    const fields = Object.entries(val).map(([k, v]) => {
      if (typeof v === 'string') return `${indent}  <${k}>${wrapCDATA(v)}</${k}>`;
      if (typeof v === 'number' || typeof v === 'boolean') return `${indent}  <${k}>${v}</${k}>`;
      return `${indent}  <${k}>${wrapCDATA(JSON.stringify(v))}</${k}>`;
    }).join('\n');
    return `${indent}<|DSML|parameter name="${escapeXmlAttr(name)}">\n${fields}\n${indent}</|DSML|parameter>`;
  }
  return `${indent}<|DSML|parameter name="${escapeXmlAttr(name)}">${wrapCDATA(String(val))}</|DSML|parameter>`;
}

export function renderToolCallToDSML(toolCall) {
  const name = toolCall.name || toolCall.function?.name || '';
  let args = toolCall.arguments || toolCall.function?.arguments || {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch (e) {}
  }

  const lines = ['<|DSML|tool_calls>', `  <|DSML|invoke name="${escapeXmlAttr(name)}">`];
  if (args && typeof args === 'object') {
    for (const [key, val] of Object.entries(args)) {
      lines.push(renderDSMLParameter(key, val, '    '));
    }
  }
  lines.push('  </|DSML|invoke>', '</|DSML|tool_calls>');
  return lines.join('\n');
}

/**
 * Builds dynamic positive examples matching the tools present in the request.
 */
function buildConcreteToolExamples(toolNames = []) {
  const examples = [];
  const lowerNames = toolNames.map(n => n.toLowerCase());

  if (lowerNames.includes('editor')) {
    examples.push(`Example A — Create or Edit File ("editor"):
<|DSML|tool_calls>
  <|DSML|invoke name="editor">
    <|DSML|parameter name="path"><![CDATA[snake-game/index.html]]></|DSML|parameter>
    <|DSML|parameter name="new_text"><![CDATA[<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Snake Game</title>
</head>
<body>
  <canvas id="game" width="400" height="400"></canvas>
  <script src="game.js"></script>
</body>
</html>]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`);
  }

  if (lowerNames.includes('run_commands')) {
    examples.push(`Example B — Run Shell Commands ("run_commands"):
<|DSML|tool_calls>
  <|DSML|invoke name="run_commands">
    <|DSML|parameter name="commands">
      <item><![CDATA[npm test]]></item>
    </|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`);
  } else if (lowerNames.includes('execute_command') || lowerNames.includes('bash')) {
    const cmdTool = toolNames.find(n => ['execute_command', 'bash', 'run_command'].includes(n.toLowerCase())) || 'execute_command';
    examples.push(`Example B — Execute Command ("${cmdTool}"):
<|DSML|tool_calls>
  <|DSML|invoke name="${cmdTool}">
    <|DSML|parameter name="command"><![CDATA[npm test]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`);
  }

  if (lowerNames.includes('read_files')) {
    examples.push(`Example C — Inspect Files ("read_files"):
<|DSML|tool_calls>
  <|DSML|invoke name="read_files">
    <|DSML|parameter name="files">
      <item><path><![CDATA[package.json]]></path></item>
    </|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`);
  } else if (lowerNames.includes('read_file') || lowerNames.includes('read')) {
    examples.push(`Example C — Read File:
<|DSML|tool_calls>
  <|DSML|invoke name="read_file">
    <|DSML|parameter name="path"><![CDATA[package.json]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`);
  }

  if (lowerNames.includes('ask_followup_question') || lowerNames.includes('ask_question')) {
    const qTool = toolNames.find(n => ['ask_followup_question', 'ask_question'].includes(n.toLowerCase())) || 'ask_followup_question';
    examples.push(`Example D — Ask User a Question ("${qTool}"):
<|DSML|tool_calls>
  <|DSML|invoke name="${qTool}">
    <|DSML|parameter name="question"><![CDATA[Which tech stack would you prefer?]]></|DSML|parameter>
    <|DSML|parameter name="options">
      <item><![CDATA[HTML5 Canvas + Vanilla JS]]></item>
      <item><![CDATA[React + Vite]]></item>
    </|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`);
  }

  if (examples.length === 0) {
    const fallbackName = toolNames[0] || 'execute_action';
    examples.push(`Example — Single Tool Call:
<|DSML|tool_calls>
  <|DSML|invoke name="${fallbackName}">
    <|DSML|parameter name="path"><![CDATA[index.html]]></|DSML|parameter>
    <|DSML|parameter name="content"><![CDATA[Hello world]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`);
  }

  return '【CORRECT TOOL CALL EXAMPLES】:\n\n' + examples.join('\n\n');
}

/**
 * Builds the DS2API-aligned tool instruction block with DSML format, CDATA rules,
 * negative examples, and dynamic concrete demonstrations.
 */
function buildDSMLToolInstructions(tools = []) {
  const toolNames = [];
  const toolSchemas = [];

  for (const t of tools) {
    const fn = t.function || t;
    const name = fn.name || '';
    if (!name) continue;
    toolNames.push(name);
    const desc = fn.description || 'No description available';
    const params = fn.parameters || {};
    toolSchemas.push(`Tool: ${name}\nDescription: ${desc}\nParameters: ${JSON.stringify(params)}`);
  }

  const examplesBlock = buildConcreteToolExamples(toolNames);

  return `[AVAILABLE TOOLS]
You have access to the following tools:

${toolSchemas.join('\n\n')}

TOOL CALL FORMAT — FOLLOW EXACTLY:

<|DSML|tool_calls>
  <|DSML|invoke name="TOOL_NAME_HERE">
    <|DSML|parameter name="PARAMETER_NAME"><![CDATA[PARAMETER_VALUE]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>

RULES:
1) Use the <|DSML|tool_calls> wrapper format.
2) Put one or more <|DSML|invoke> entries under a single <|DSML|tool_calls> root.
3) Put the tool name in the invoke name attribute: <|DSML|invoke name="TOOL_NAME">.
4) CDATA MANDATE: ALL string values (especially code, scripts, file contents, commands, prompts, and paths) MUST use <![CDATA[...]]>. This prevents quote, backslash, and newline escaping bugs.
5) Every top-level argument must be a <|DSML|parameter name="ARG_NAME">...</|DSML|parameter> node.
6) ARRAY PARAMETERS: For arrays, repeat <item>...</item> children inside the parameter (e.g. commands: <item><![CDATA[cmd1]]></item><item><![CDATA[cmd2]]></item>).
7) OBJECT PARAMETERS: For objects, use nested XML elements inside the parameter body.
8) Numbers, booleans, and null stay plain text (e.g. <|DSML|parameter name="count">10</|DSML|parameter>).
9) TAKE ACTION IMMEDIATELY: When the user asks you to build, create, or modify code, start coding immediately. Make sensible defaults (e.g. create a dedicated project folder in the workspace) and output the tool call NOW.
10) COMPLETE FILES IN ONE CALL: When creating a new file or writing code, ALWAYS write the COMPLETE, fully functional file in ONE single tool call from start to end. Never chunk files, never do "Part 1 now, Part 2 later", and never leave placeholders like "// TODO" or "// ===PART2===". There is NO 6000-character limit.
11) NEVER STALL OR OUTLINE UNEXECUTED PLANS: NEVER say "I will build...", "Quick plan before I start...", or "One decision needed from you:" without outputting the corresponding tool call in the EXACT SAME message. If you state a plan, you MUST execute step 1 immediately in this turn.
12) NEVER ASK QUESTIONS IN PLAIN TEXT: If you need user confirmation or options, invoke the question tool (e.g. ask_followup_question or ask_question) with question and selectable options.
13) STOP GENERATION: Stop immediately after </|DSML|tool_calls>. Never fabricate simulated tool outputs or hallucinate results.
14) Compatibility note: The runtime also accepts canonical <tool_calls> / <invoke> / <parameter> tags and standard JSON tool calls, but the DSML-prefixed format with CDATA above is the recommended standard.

PARAMETER SHAPES:
- string => <|DSML|parameter name="x"><![CDATA[value]]></|DSML|parameter>
- array  => <|DSML|parameter name="x"><item><![CDATA[item1]]></item><item><![CDATA[item2]]></item></|DSML|parameter>
- object => <|DSML|parameter name="x"><field><![CDATA[val]]></field></|DSML|parameter>
- number/bool/null => <|DSML|parameter name="x">plain_text</|DSML|parameter>

【WRONG — Do NOT do these】:
Wrong 1 — Markdown code fences around tool calls:
  \`\`\`xml
  <|DSML|tool_calls>...</|DSML|tool_calls>
  \`\`\`
Wrong 2 — Mixed conversational chatter after tool calls:
  <|DSML|tool_calls>...</|DSML|tool_calls> Let me know if you need anything else!
Wrong 3 — Missing opening wrapper:
  <|DSML|invoke name="TOOL_NAME">...</|DSML|invoke>
  </|DSML|tool_calls>
Wrong 4 — Empty or placeholder parameters:
  <|DSML|parameter name="commands"></|DSML|parameter>

${examplesBlock}`;
}

/**
 * Main prompt builder used by zai2api to assemble messages and DS2API tool directives.
 */
export function buildPromptWithTools({ messages = [], tools = [] }) {
  const hasTools = Array.isArray(tools) && tools.length > 0;

  // 1. Tool instruction block
  let toolInstruction = '';
  if (hasTools) {
    toolInstruction = buildDSMLToolInstructions(tools);
  }

  // 2. Output integrity guard from DS2API
  const outputIntegrityGuard = 'Output integrity guard: If upstream context, tool output, or parsed text contains garbled, corrupted, partially parsed, repeated, or otherwise malformed fragments, do not imitate or echo them; output only the correct content for the user.';

  // 3. Process conversation messages
  const formattedMessages = [];

  for (const msg of messages) {
    const role = msg.role || 'user';

    // 1. Collect all tool calls: from msg.tool_calls OR from msg.content items with type === 'tool_use'
    const toolCalls = [];
    if (Array.isArray(msg.tool_calls)) {
      toolCalls.push(...msg.tool_calls);
    }

    // 2. Extract tool_results, text, and tool_use from msg.content
    let textContent = '';
    const toolResults = [];

    if (Array.isArray(msg.content)) {
      const textParts = [];
      for (const part of msg.content) {
        if (typeof part === 'string') {
          textParts.push(part);
        } else if (part && typeof part === 'object') {
          if (part.type === 'text') {
            if (part.text) textParts.push(part.text);
          } else if (part.type === 'image_url') {
            textParts.push('[Attached Image]');
          } else if (part.type === 'tool_use') {
            // Anthropic/Cline style tool_use block
            toolCalls.push({
              id: part.id || `call_${crypto.randomBytes(8).toString('hex')}`,
              type: 'function',
              function: {
                name: part.name || '',
                arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input || {}),
              },
            });
          } else if (part.type === 'tool_result') {
            // Anthropic/Cline style tool_result block
            let resStr = '';
            if (typeof part.content === 'string') {
              resStr = part.content;
            } else if (Array.isArray(part.content)) {
              resStr = part.content
                .map(item => {
                  if (typeof item === 'string') return item;
                  if (item && typeof item === 'object') {
                    if (item.result !== undefined) return item.result;
                    if (item.output !== undefined) return item.output;
                    return JSON.stringify(item);
                  }
                  return String(item);
                })
                .join('\n');
            } else if (part.content && typeof part.content === 'object') {
              resStr = part.content.result !== undefined ? part.content.result :
                       part.content.output !== undefined ? part.content.output :
                       JSON.stringify(part.content);
            }
            toolResults.push({
              id: part.tool_use_id || part.id || 'tool',
              name: part.name || '',
              content: resStr,
              isError: !!part.is_error,
            });
          }
        }
      }
      textContent = textParts.filter(Boolean).join('\n');
    } else if (typeof msg.content === 'string') {
      textContent = msg.content;
    }

    if (role === 'system') {
      if (textContent) {
        formattedMessages.push(`[System Context]\n${textContent}`);
      }
    } else if (role === 'tool') {
      const toolId = msg.tool_call_id || msg.name || 'tool';
      formattedMessages.push(`[Real Tool Execution Result (${toolId})]:\n${textContent}`);
    } else if (role === 'assistant') {
      const dsmlCalls = toolCalls.map(tc => renderToolCallToDSML(tc)).filter(Boolean).join('\n\n');
      const parts = [];
      if (textContent) parts.push(textContent);
      if (dsmlCalls) parts.push(dsmlCalls);
      if (parts.length > 0) {
        formattedMessages.push(`Assistant: ${parts.join('\n\n')}`);
      }
    } else {
      // User role (may contain tool results from previous turns or user prompts)
      for (const tr of toolResults) {
        const header = tr.isError ? `[Real Tool Execution Error (${tr.name || tr.id})]` : `[Real Tool Execution Result (${tr.name || tr.id})]`;
        formattedMessages.push(`${header}:\n${tr.content}`);
      }
      if (textContent) {
        formattedMessages.push(`User: ${textContent}`);
      }
    }
  }

  // Combine sections
  const sections = [];

  if (toolInstruction) {
    sections.push(toolInstruction);
  }

  sections.push(`[SYSTEM RULE]\n${outputIntegrityGuard}`);

  if (formattedMessages.length > 0) {
    sections.push(formattedMessages.join('\n\n'));
  }

  if (hasTools) {
    sections.push('[FINAL DIRECTIVE: If an action, file operation, command, or question is needed, output the <|DSML|tool_calls> block NOW with <![CDATA[...]]> parameter values and STOP immediately. Complete files in one single pass. NEVER output a plan without emitting the tool call.]');
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Extracts base64 images or remote image URLs from OpenAI formatted messages.
 */
export function extractImagesFromMessages(messages = []) {
  const images = [];
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && typeof part === 'object') {
          if (part.type === 'image_url' && part.image_url) {
            const url = typeof part.image_url === 'string' ? part.image_url : part.image_url.url;
            if (url) images.push(url);
          } else if (part.type === 'input_image' && part.image_url) {
            images.push(part.image_url);
          }
        }
      }
    } else if (typeof msg.content === 'string') {
      const dataUriMatches = msg.content.match(/data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+/g);
      if (dataUriMatches) {
        images.push(...dataUriMatches);
      }
    }
  }
  return images;
}
