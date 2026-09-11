import crypto from 'crypto';

/**
 * Repairs JSON strings containing unescaped control characters (newlines, tabs)
 * within string literals, which frequently occurs when LLMs output multi-line code files,
 * and removes illegal trailing commas.
 */
function repairJson(jsonStr) {
  let inString = false;
  let escaped = false;
  let result = '';

  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];

    if (inString) {
      if (escaped) {
        result += char;
        escaped = false;
      } else if (char === '\\') {
        result += char;
        escaped = true;
      } else if (char === '"') {
        result += char;
        inString = false;
      } else if (char === '\n') {
        result += '\\n';
      } else if (char === '\r') {
        result += '\\r';
      } else if (char === '\t') {
        result += '\\t';
      } else {
        result += char;
      }
    } else {
      if (char === '"') {
        inString = true;
      }
      result += char;
    }
  }

  // Strip trailing commas before closing braces/brackets
  return result.replace(/,\s*([}\]])/g, '$1');
}

/**
 * Normalizes a candidate object into an OpenAI-compatible function tool call.
 * Handles:
 * 1. Standard OpenAI format: { name: "...", arguments: { ... } }
 * 2. Flat format (used by Cline models): { name: "editor", path: "...", new_text: "..." }
 * 3. Wrapped format: { function: { name: "...", arguments: ... } }
 */
function tryParseSingleObject(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // Format with function wrapper: { function: { name: "...", arguments: ... } }
  if (obj.function && typeof obj.function === 'object') {
    const fnName = obj.function.name;
    if (typeof fnName === 'string' && fnName.trim()) {
      let args = obj.function.arguments || obj.function.parameters || {};
      if (typeof args === 'object') {
        const { name, ...rest } = obj.function;
        if (Object.keys(args).length === 0 && Object.keys(rest).length > 0) {
          args = rest;
        }
      }
      return {
        id: `call_${crypto.randomBytes(8).toString('hex')}`,
        type: 'function',
        function: {
          name: fnName.trim(),
          arguments: typeof args === 'string' ? args : JSON.stringify(args),
        },
      };
    }
  }

  // Direct tool name: name, tool, action, tool_name
  const toolName = obj.name || obj.tool || obj.action || obj.tool_name;
  if (typeof toolName === 'string' && toolName.trim()) {
    let args = null;
    if (obj.arguments !== undefined) {
      args = obj.arguments;
    } else if (obj.parameters !== undefined) {
      args = obj.parameters;
    } else if (obj.input !== undefined) {
      args = obj.input;
    } else {
      // Flat properties: all keys other than metadata are the arguments
      // e.g. { name: "editor", path: "/home/...", new_text: "..." }
      // e.g. { name: "run_commands", commands: ["..."] }
      const { name, tool, action, tool_name, type, id, call_id, function: _fn, ...rest } = obj;
      args = rest;
    }

    return {
      id: `call_${crypto.randomBytes(8).toString('hex')}`,
      type: 'function',
      function: {
        name: toolName.trim(),
        arguments: typeof args === 'string' ? args : JSON.stringify(args || {}),
      },
    };
  }

  return null;
}

function tryParseJsonToolCall(jsonStr) {
  if (!jsonStr || typeof jsonStr !== 'string') return null;
  const trimmed = jsonStr.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

  try {
    const obj = JSON.parse(trimmed);
    if (Array.isArray(obj) && obj.length > 0) {
      return tryParseSingleObject(obj[0]);
    }
    return tryParseSingleObject(obj);
  } catch (e) {
    // Attempt repair for unescaped newlines in code strings and trailing commas
    try {
      const repaired = repairJson(trimmed);
      const obj = JSON.parse(repaired);
      if (Array.isArray(obj) && obj.length > 0) {
        return tryParseSingleObject(obj[0]);
      }
      return tryParseSingleObject(obj);
    } catch (e2) {
      return null;
    }
  }
}

/**
 * Parses XML-based tool call formats commonly used by Cline and agent frameworks:
 * 1. <invoke name="tool_name"><parameter name="...">val</parameter></invoke>
 * 2. <tool_call><name>...</name><arguments>...</arguments></tool_call>
 * 3. Direct tool tags: <write_to_file><path>...</path><content>...</content></write_to_file>
 */
function parseXmlToolCall(text, toolList = []) {
  // 1. Match <invoke name="tool_name"> ... </invoke>
  const invokeRegex = /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/i;
  const invokeMatch = text.match(invokeRegex);
  if (invokeMatch) {
    const toolName = invokeMatch[1].trim();
    const body = invokeMatch[2];
    const args = {};
    const paramRegex = /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/gi;
    let pMatch;
    let found = false;
    while ((pMatch = paramRegex.exec(body)) !== null) {
      found = true;
      try { args[pMatch[1].trim()] = JSON.parse(pMatch[2].trim()); }
      catch (e) { args[pMatch[1].trim()] = pMatch[2].trim(); }
    }
    if (!found) {
      try { Object.assign(args, JSON.parse(body.trim())); }
      catch (e) { args.input = body.trim(); }
    }
    return {
      toolCall: {
        id: `call_${crypto.randomBytes(8).toString('hex')}`,
        type: 'function',
        function: { name: toolName, arguments: JSON.stringify(args) },
      },
      index: invokeMatch.index,
    };
  }

  // 2. Match <tool_call><name>...</name><arguments>...</arguments></tool_call>
  const toolCallTagRegex = /<tool_call>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<arguments>([\s\S]*?)<\/arguments>[\s\S]*?<\/tool_call>/i;
  const tcMatch = text.match(toolCallTagRegex);
  if (tcMatch) {
    const toolName = tcMatch[1].trim();
    let args = {};
    try { args = JSON.parse(tcMatch[2].trim()); }
    catch (e) { args = { input: tcMatch[2].trim() }; }
    return {
      toolCall: {
        id: `call_${crypto.randomBytes(8).toString('hex')}`,
        type: 'function',
        function: { name: toolName, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
      },
      index: tcMatch.index,
    };
  }

  // 3. Match direct tool tags: e.g. <write_to_file>, <execute_command>, <read_file>, <editor>, <run_commands>
  const dynamicToolNames = (toolList || []).map(t => t.function?.name || t.name).filter(Boolean);
  const commonTools = [
    'write_to_file', 'execute_command', 'read_file', 'replace_in_file',
    'editor', 'read_files', 'run_commands',
    'attempt_completion', 'ask_followup_question', 'apply_diff', 'list_dir', 'search_files',
    ...dynamicToolNames,
  ];
  const uniqueToolNames = [...new Set(commonTools)];

  for (const toolName of uniqueToolNames) {
    const tagRegex = new RegExp(`<${toolName}>([\\s\\S]*?)</${toolName}>`, 'i');
    const tagMatch = text.match(tagRegex);
    if (tagMatch) {
      const body = tagMatch[1];
      const args = {};
      const childRegex = /<([a-zA-Z0-9_\-]+)>([\s\S]*?)<\/\1>/gi;
      let cMatch;
      let count = 0;
      while ((cMatch = childRegex.exec(body)) !== null) {
        count++;
        args[cMatch[1]] = cMatch[2].trim();
      }
      if (count === 0) {
        args.content = body.trim();
      }
      return {
        toolCall: {
          id: `call_${crypto.randomBytes(8).toString('hex')}`,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(args) },
        },
        index: tagMatch.index,
      };
    }
  }

  return null;
}

/**
 * Checks if the generated response text contains a tool call (JSON or XML) or standard text.
 * Truncates any hallucinated tool results or conversational loops following the tool call.
 */
export function parseResponse(rawText, tools = []) {
  if (!rawText || typeof rawText !== 'string') {
    return { isToolCall: false, content: rawText || '' };
  }

  const trimmed = rawText.trim();

  // 1. Check XML format first
  const xmlResult = parseXmlToolCall(trimmed, tools);
  if (xmlResult) {
    const preText = trimmed.slice(0, xmlResult.index).trim();
    return {
      isToolCall: true,
      toolCalls: [xmlResult.toolCall],
      content: preText || null,
    };
  }

  // 2. Check Markdown JSON code blocks: ```json { ... } ``` or ``` { ... } ```
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  let match;
  while ((match = codeBlockRegex.exec(trimmed)) !== null) {
    const candidate = match[1].trim();
    const toolCall = tryParseJsonToolCall(candidate);
    if (toolCall) {
      const preText = trimmed.slice(0, match.index).trim();
      return {
        isToolCall: true,
        toolCalls: [toolCall],
        content: preText || null,
      };
    }
  }

  // 3. Check Raw JSON object starting with { and ending with }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1).trim();
    const toolCall = tryParseJsonToolCall(candidate);
    if (toolCall) {
      const preText = trimmed.slice(0, firstBrace).trim();
      return {
        isToolCall: true,
        toolCalls: [toolCall],
        content: preText || null,
      };
    }
  }

  // Standard plain text
  return { isToolCall: false, content: rawText };
}
