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
 * Parses key-value / YAML lines and bare parameter blocks within tool calls:
 * Supports:
 * - key: val
 * - bare parameter names followed by multiline value on subsequent lines (e.g. path\n/home/...\nnew_text\n<!DOCTYPE html>...)
 */
function parseKvOrYaml(bodyText, knownParams = []) {
  const args = {};
  // Strip stray opening/closing tags from bodyText (e.g. </invoke>, <invoke>, </tool_call>)
  const cleaned = bodyText.replace(/^\s*<\/(?:invoke|tool_call|tool-call|parameter)>\s*/gi, '').trim();
  const lines = cleaned.split('\n');
  let currentKey = null;
  let currentValue = '';

  const defaultKnownParams = [
    'path', 'new_text', 'content', 'command', 'commands',
    'question', 'options', 'file', 'files', 'diff', 'old_text',
    'url', 'query', 'action', 'message', 'text', 'code', 'line'
  ];
  const allKnownParams = [...new Set([...knownParams, ...defaultKnownParams])];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Pattern 1: standard key: value
    const kvMatch = line.match(/^([a-zA-Z0-9_\-]+):\s*(.*)$/);
    // Pattern 2: bare parameter name on its own line (e.g. "path" or "new_text")
    const isBareParam = allKnownParams.includes(trimmedLine.toLowerCase());

    if (kvMatch && !trimmedLine.startsWith('<')) {
      if (currentKey) {
        saveParsedArg(args, currentKey, currentValue);
      }
      currentKey = kvMatch[1].trim();
      currentValue = kvMatch[2];
    } else if (isBareParam) {
      if (currentKey) {
        saveParsedArg(args, currentKey, currentValue);
      }
      currentKey = trimmedLine.toLowerCase();
      currentValue = '';
    } else if (currentKey) {
      currentValue = currentValue ? (currentValue + '\n' + line) : line;
    }
  }

  if (currentKey) {
    saveParsedArg(args, currentKey, currentValue);
  }

  return args;
}

function saveParsedArg(args, key, rawVal) {
  const trimmed = rawVal.trim();
  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    trimmed === 'true' || trimmed === 'false' ||
    /^-?\d+(?:\.\d+)?$/.test(trimmed) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      args[key] = JSON.parse(trimmed);
      return;
    } catch (e) {}
  }
  args[key] = trimmed;
}

/**
 * Scans conversation history and current response text to locate the most recently referenced file path.
 */
export function findRecentFilePath(messages = [], rawText = '') {
  // 1. First check rawText for explicit paths
  if (rawText && typeof rawText === 'string') {
    const textMatches = [
      ...rawText.matchAll(/(?:at|in|file|path|to|folder|create|edit|inspect|read|write)\s+[`"']?(\/?[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,10})[`"']?/gi),
      ...rawText.matchAll(/[`"'](\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,10})[`"']/gi),
      ...rawText.matchAll(/(\/[a-zA-Z0-9_\-./]+(?:\/[a-zA-Z0-9_\-./]+)+\.[a-zA-Z0-9]{1,10})/g),
      ...rawText.matchAll(/[`"']([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,10})[`"']/g),
    ];
    for (let i = textMatches.length - 1; i >= 0; i--) {
      const p = textMatches[i][1]?.trim();
      if (isValidCandidatePath(p)) return p;
    }
  }

  // 2. Scan messages backwards
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg) continue;

      // Check tool_calls in assistant message
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || {};
          let args = fn.arguments;
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch (e) { args = {}; }
          }
          if (args && typeof args === 'object') {
            if (args.path && isValidCandidatePath(args.path)) return args.path;
            if (args.file && isValidCandidatePath(args.file)) return args.file;
            if (Array.isArray(args.files) && args.files[0]) {
              const fp = typeof args.files[0] === 'string' ? args.files[0] : args.files[0].path;
              if (isValidCandidatePath(fp)) return fp;
            }
          }
        }
      }

      // Check message content
      let contentStr = '';
      if (typeof msg.content === 'string') {
        contentStr = msg.content;
      } else if (Array.isArray(msg.content)) {
        contentStr = msg.content.map(c => (typeof c === 'string' ? c : c.text || '')).join('\n');
      }

      if (contentStr) {
        const contentMatches = [
          ...contentStr.matchAll(/"path"\s*:\s*"([^"]+)"/g),
          ...contentStr.matchAll(/[`"'](\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,10})[`"']/gi),
          ...contentStr.matchAll(/(\/[a-zA-Z0-9_\-./]+(?:\/[a-zA-Z0-9_\-./]+)+\.[a-zA-Z0-9]{1,10})/g),
          ...contentStr.matchAll(/[`"']([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,10})[`"']/g),
          ...contentStr.matchAll(/(?:at|in|file|path|to|create|edit|inspect|read|write)\s+[`"']?(\/?[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,10})[`"']?/gi),
        ];
        for (let j = contentMatches.length - 1; j >= 0; j--) {
          const p = contentMatches[j][1]?.trim();
          if (isValidCandidatePath(p)) return p;
        }
      }
    }
  }

  return null;
}

function isValidCandidatePath(p) {
  if (!p || typeof p !== 'string') return false;
  p = p.trim();
  if (p.length < 3 || p.length > 250) return false;
  if (p.startsWith('http://') || p.startsWith('https://')) return false;
  if (p.includes('node_modules')) return false;
  if (/\.[a-zA-Z0-9]{1,10}$/.test(p) || p.startsWith('/')) {
    return true;
  }
  return false;
}

/**
 * Normalizes tool arguments across aliases and fills in missing paths or parameters
 * required by agent environments like Cline.
 */
export function normalizeToolArgs(toolName, args = {}, tools = [], rawText = '', messages = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    args = {};
  }

  const normToolName = (toolName || '').toLowerCase().trim();

  // 1. File modification / creation tools
  if (['editor', 'write_to_file', 'new_file', 'create_file', 'edit_file', 'replace_in_file'].includes(normToolName)) {
    // Normalise path
    if (!args.path) {
      args.path = args.file_path || args.filePath || args.target_file || args.targetFile || args.file || args.filename || args.name;
    }
    if (!args.path) {
      const fallbackPath = findRecentFilePath(messages, rawText);
      if (fallbackPath) {
        console.warn(`[Parser] Auto-resolved missing path for ${toolName} to: ${fallbackPath}`);
        args.path = fallbackPath;
      }
    }

    // Normalise new_text / content
    if (normToolName === 'editor') {
      if (args.new_text === undefined) {
        args.new_text = args.content !== undefined ? args.content :
                        args.text !== undefined ? args.text :
                        args.code !== undefined ? args.code :
                        args.file_text !== undefined ? args.file_text :
                        args.body !== undefined ? args.body :
                        args.input !== undefined ? args.input :
                        '';
      }
      delete args.content;
      delete args.file;
      delete args.filePath;
    } else {
      if (args.content === undefined) {
        args.content = args.new_text !== undefined ? args.new_text :
                       args.text !== undefined ? args.text :
                       args.code !== undefined ? args.code :
                       args.file_text !== undefined ? args.file_text :
                       args.body !== undefined ? args.body :
                       args.input !== undefined ? args.input :
                       '';
      }
    }
  }

  // 2. File reading / inspection tools
  if (normToolName === 'read_files') {
    if (!args.files || !Array.isArray(args.files) || args.files.length === 0) {
      let targetPath = args.path || args.file || args.filePath || args.target_file;
      if (!targetPath) {
        targetPath = findRecentFilePath(messages, rawText);
      }
      if (targetPath) {
        console.warn(`[Parser] Auto-resolved target path for read_files to: ${targetPath}`);
        args.files = [{ path: targetPath }];
      } else {
        args.files = [];
      }
    } else {
      args.files = args.files.map(f => (typeof f === 'string' ? { path: f } : f));
    }
    delete args.path;
    delete args.file;
  } else if (normToolName === 'read_file') {
    if (!args.path) {
      args.path = args.file || args.filePath || args.target_file;
    }
    if (!args.path) {
      const fallbackPath = findRecentFilePath(messages, rawText);
      if (fallbackPath) {
        console.warn(`[Parser] Auto-resolved target path for read_file to: ${fallbackPath}`);
        args.path = fallbackPath;
      }
    }
  }

  // 3. Command execution tools
  if (normToolName === 'run_commands') {
    if (!args.commands) {
      if (args.command) {
        args.commands = Array.isArray(args.command) ? args.command : [args.command];
        delete args.command;
      } else if (args.cmd) {
        args.commands = Array.isArray(args.cmd) ? args.cmd : [args.cmd];
        delete args.cmd;
      } else {
        args.commands = [];
      }
    } else if (typeof args.commands === 'string') {
      args.commands = [args.commands];
    }
  } else if (normToolName === 'execute_command') {
    if (!args.command) {
      if (Array.isArray(args.commands) && args.commands.length > 0) {
        args.command = args.commands.join(' && ');
      } else if (args.cmd) {
        args.command = args.cmd;
      }
    }
  }

  // 4. Question tools
  if (normToolName === 'ask_followup_question' || normToolName === 'ask_question') {
    if (!args.question) {
      args.question = args.prompt || args.message || args.text || 'Please confirm how you would like to proceed:';
    }
    if (!args.options || !Array.isArray(args.options) || args.options.length === 0) {
      args.options = args.choices || [
        'Proceed with recommended options',
        'Let me specify custom requirements'
      ];
    }
  }

  return args;
}

function applyNormalizedToolCall(toolCall, tools, rawText, messages) {
  if (!toolCall || !toolCall.function) return toolCall;
  let args = {};
  if (typeof toolCall.function.arguments === 'string') {
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch (e) {
      args = {};
    }
  } else if (typeof toolCall.function.arguments === 'object') {
    args = toolCall.function.arguments || {};
  }

  const normArgs = normalizeToolArgs(toolCall.function.name, args, tools, rawText, messages);
  toolCall.function.arguments = JSON.stringify(normArgs);
  return toolCall;
}

/**
 * Handles all variations of <tool_call> tags emitted by GLM, Qwen, and custom agent prompts:
 * - <tool_call>tool_name\nkey: val\n...</tool_call>
 * - <tool_call>tool_name>\n</invoke>\npath\n...\nnew_text\n...
 * - <tool_call name="tool_name">...</tool_call>
 * - <tool_call:tool_name>...</tool_call>
 * - <tool_call>\n<name>...</name><arguments>...</arguments>\n</tool_call>
 * - <tool_call>\n{"name": "...", "arguments": {...}}\n</tool_call>
 * - Bare trailing <tool_call>tool_name
 */
function parseToolCallTag(text, toolList = []) {
  const tagRegex = /<(?:tool_call|tool-call)(?::([a-zA-Z0-9_\-\.]+)|(?:\s+name=["']([^"']+)["']))?>([\s\S]*?)(?:<\/(?:tool_call|tool-call)>|(?=<(?:tool_call|tool-call))|$)/gi;
  const matches = [...text.matchAll(tagRegex)];
  if (matches.length === 0) return null;

  // Extract known parameters from tools list if available
  const defaultKnownParams = [
    'path', 'new_text', 'content', 'command', 'commands',
    'question', 'options', 'file', 'files', 'diff', 'old_text',
    'url', 'query', 'action', 'message', 'text', 'code', 'line'
  ];
  const knownParams = [...defaultKnownParams];
  for (const t of toolList) {
    const fn = t.function || t;
    if (fn.name && fn.parameters?.properties) {
      knownParams.push(...Object.keys(fn.parameters.properties));
    }
  }
  const validParamNames = new Set(knownParams.map(p => p.toLowerCase()));

  // Search matches from newest/last backwards
  for (let m = matches.length - 1; m >= 0; m--) {
    const match = matches[m];
    let toolName = (match[1] || match[2] || '').replace(/>+$/, '').trim();
    let body = match[3].trim();

    // Strip fake tool results if unclosed
    const fakeResultIdx = body.search(/\[(?:Tool Result|System|User|Assistant)/i);
    if (fakeResultIdx !== -1) {
      body = body.slice(0, fakeResultIdx).trim();
    }

    // 1. Check if body has <name>...</name>
    const nameTagMatch = body.match(/<name>([^<]+)<\/name>/i);
    if (nameTagMatch) {
      toolName = nameTagMatch[1].trim();
      const argsTagMatch = body.match(/<arguments>([\s\S]*?)<\/arguments>/i);
      if (argsTagMatch) {
        body = argsTagMatch[1].trim();
      }
    }

    // 2. Check if body has name: tool_name or tool: tool_name
    if (!toolName) {
      const nameLineMatch = body.match(/^(?:name|tool|tool_name|action):\s*([a-zA-Z0-9_\-\.]+)\s*(?:\n|$)([\s\S]*)$/i);
      if (nameLineMatch) {
        toolName = nameLineMatch[1].trim();
        body = nameLineMatch[2].trim();
      }
    }

    // 3. Check if first line is simply the tool name: e.g. <tool_call>ask_question\n or <tool_call>editor>\n or bare <tool_call>read_files
    if (!toolName) {
      const firstLineMatch = body.match(/^<?([a-zA-Z0-9_\-\.]+)>?(?:\s*\n|\s*$)([\s\S]*)$/);
      if (firstLineMatch) {
        toolName = firstLineMatch[1].trim();
        body = firstLineMatch[2].trim();
      }
    }

    // 4. Check if body is a JSON object with name property
    if (!toolName) {
      try {
        const parsedJson = JSON.parse(body);
        if (parsedJson.name || parsedJson.tool || parsedJson.action) {
          toolName = parsedJson.name || parsedJson.tool || parsedJson.action;
          body = JSON.stringify(parsedJson.arguments || parsedJson.parameters || parsedJson);
        }
      } catch (e) {}
    }

    if (!toolName) continue;

    // Now parse arguments from body
    let args = {};

    // A. Check if body contains XML child tags: e.g. <path>...</path>
    const childTagRegex = /<([a-zA-Z0-9_\-]+)>([\s\S]*?)<\/\1>/gi;
    let cMatch;
    let xmlCount = 0;
    while ((cMatch = childTagRegex.exec(body)) !== null) {
      const tag = cMatch[1].toLowerCase();
      if (validParamNames.has(tag)) {
        xmlCount++;
        args[cMatch[1]] = cMatch[2].trim();
      }
    }

    // B. Check if body is JSON
    if (xmlCount === 0) {
      const trimmedBody = body.trim();
      if ((trimmedBody.startsWith('{') && trimmedBody.endsWith('}')) || (trimmedBody.startsWith('[') && trimmedBody.endsWith(']'))) {
        try {
          const parsed = JSON.parse(trimmedBody);
          args = parsed.arguments || parsed.parameters || parsed;
        } catch (e) {}
      }
    }

    // C. If args still empty, parse Key-Value / Bare Params / YAML
    if (Object.keys(args).length === 0 && body.length > 0) {
      args = parseKvOrYaml(body, knownParams);
    }

    return {
      toolCall: {
        id: `call_${crypto.randomBytes(8).toString('hex')}`,
        type: 'function',
        function: {
          name: toolName,
          arguments: JSON.stringify(args),
        },
      },
      index: match.index,
    };
  }

  return null;
}

/**
 * Parses XML-based tool call formats commonly used by Cline and agent frameworks:
 * 1. <invoke name="tool_name"><parameter name="...">val</parameter></invoke>
 * 2. <tool_call>...</tool_call> (YAML, JSON, XML tags, or key-value format)
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

  // 2. Match <tool_call> ... (supports JSON, XML, or Key-Value / Bare Params / YAML)
  const toolCallResult = parseToolCallTag(text, toolList);
  if (toolCallResult) {
    return toolCallResult;
  }

  // 3. Match direct tool tags: e.g. <write_to_file>, <execute_command>, <read_file>, <editor>, <run_commands>
  const dynamicToolNames = (toolList || []).map(t => t.function?.name || t.name).filter(Boolean);
  const commonTools = [
    'write_to_file', 'execute_command', 'read_file', 'replace_in_file',
    'editor', 'read_files', 'run_commands',
    'attempt_completion', 'ask_question', 'ask_followup_question', 'apply_diff', 'list_dir', 'search_files',
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
      const validParamNames = new Set([
        'path', 'new_text', 'content', 'command', 'commands',
        'question', 'options', 'file', 'files', 'diff', 'old_text',
        'url', 'query', 'action', 'message', 'text', 'code', 'line'
      ]);
      while ((cMatch = childRegex.exec(body)) !== null) {
        if (validParamNames.has(cMatch[1].toLowerCase())) {
          count++;
          args[cMatch[1]] = cMatch[2].trim();
        }
      }
      if (count === 0) {
        if (toolName.toLowerCase() === 'editor') {
          args.new_text = body.trim();
        } else {
          args.content = body.trim();
        }
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
export function parseResponse(rawText, tools = [], messages = []) {
  if (!rawText || typeof rawText !== 'string') {
    return { isToolCall: false, content: rawText || '' };
  }

  const trimmed = rawText.trim();

  // Helper to clean preText of dangling unclosed tool tags
  const cleanPreText = (text) => {
    return text.replace(/<(?:tool_call|tool-call)[^>]*>[\s\S]*$/i, '').trim();
  };

  // 1. Check XML format first
  const xmlResult = parseXmlToolCall(trimmed, tools);
  if (xmlResult) {
    const preText = cleanPreText(trimmed.slice(0, xmlResult.index));
    const normalizedToolCall = applyNormalizedToolCall(xmlResult.toolCall, tools, trimmed, messages);
    return {
      isToolCall: true,
      toolCalls: [normalizedToolCall],
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
      const preText = cleanPreText(trimmed.slice(0, match.index));
      const normalizedToolCall = applyNormalizedToolCall(toolCall, tools, trimmed, messages);
      return {
        isToolCall: true,
        toolCalls: [normalizedToolCall],
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
      const preText = cleanPreText(trimmed.slice(0, firstBrace));
      const normalizedToolCall = applyNormalizedToolCall(toolCall, tools, trimmed, messages);
      return {
        isToolCall: true,
        toolCalls: [normalizedToolCall],
        content: preText || null,
      };
    }
  }

  // 4. Fallback: Check if the model stalled on a question or decision prompt without calling the question tool
  const questionTool = (tools || []).find(t => {
    const name = (t.function?.name || t.name || '').toLowerCase();
    return name === 'ask_followup_question' || name === 'ask_question';
  });

  if (questionTool) {
    const isQuestionStall = (
      /\?\s*$/.test(trimmed) ||
      /(?:decision|question|clarification|choice|preference|confirmation)(?:\s+(?:needed|required|is needed))?(?:\s+(?:from|for)\s+you)?[\s:]*$/i.test(trimmed) ||
      /(?:please\s+(?:let me know|choose|select|confirm|specify|tell me))[\s\S]{0,80}:?\s*$/i.test(trimmed)
    );

    if (isQuestionStall) {
      const qToolName = questionTool.function?.name || questionTool.name;
      console.warn(`[Parser] Detected conversational question stall without tool call. Auto-synthesizing ${qToolName}...`);
      const { question, options } = extractQuestionAndOptions(trimmed);
      return {
        isToolCall: true,
        toolCalls: [
          {
            id: `call_${crypto.randomBytes(8).toString('hex')}`,
            type: 'function',
            function: {
              name: qToolName,
              arguments: JSON.stringify({ question, options }),
            },
          },
        ],
        content: trimmed.length > 50 ? trimmed : null,
      };
    }
  }

  // Standard plain text
  return { isToolCall: false, content: rawText };
}

/**
 * Extracts question text and selectable options from conversational stall text.
 */
function extractQuestionAndOptions(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let question = 'Please confirm how you would like to proceed with this task:';
  const options = [];

  // Check for bullet or numbered options
  for (const line of lines) {
    const optMatch = line.match(/^(?:[-*•]|\d+[\.)])\s+(.*)$/);
    if (optMatch && optMatch[1].length < 120 && !line.includes('**Implement') && !line.includes('**Verify') && !line.includes('**Decide')) {
      options.push(optMatch[1].trim());
    }
  }

  // Find the question line or decision prompt
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.includes('?') || /(?:decision|question|where|which|confirm|stack|location)/i.test(line)) {
      const cleaned = line
        .replace(/^[#*\-•\d\.\)]+\s*/, '')
        .replace(/^(?:One quick decision needed from you|Quick question for you|Please let me know|A quick question for you)[\s:]*/i, '')
        .trim();
      if (cleaned.length > 5 && cleaned.length < 200) {
        question = cleaned;
      }
      break;
    }
  }

  if (question.endsWith(':')) question = question.slice(0, -1).trim();
  if (!question.endsWith('?')) question += '?';

  if (options.length === 0) {
    if (/(?:location|folder|directory|where)/i.test(text)) {
      options.push(
        'New dedicated folder in workspace (Recommended)',
        'Current workspace root directory',
        "Different location — I'll specify path"
      );
    } else if (/(?:stack|language|framework|version)/i.test(text)) {
      options.push(
        'HTML5 / CSS / JavaScript (runs in any browser)',
        'Python',
        'Standard default stack'
      );
    } else {
      options.push(
        'Proceed with recommended configuration',
        'Let me customize details'
      );
    }
  }

  return { question, options };
}
