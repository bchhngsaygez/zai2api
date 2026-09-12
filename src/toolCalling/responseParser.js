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
    // Pattern 1b: attribute syntax key="value" or key='value' or key=value
    const attrMatch = !kvMatch ? line.match(/^([a-zA-Z0-9_\-]+)=(?:["']([\s\S]*?)["']|(\S+))$/) : null;
    // Pattern 1c: multiline attribute start key="...
    const attrStartMatch = !kvMatch && !attrMatch ? line.match(/^([a-zA-Z0-9_\-]+)=["']([\s\S]*)$/) : null;
    // Pattern 2: bare parameter name on its own line (e.g. "path" or "new_text")
    const isBareParam = allKnownParams.includes(trimmedLine.toLowerCase());

    if (kvMatch && !trimmedLine.startsWith('<')) {
      if (currentKey) {
        saveParsedArg(args, currentKey, currentValue);
      }
      currentKey = kvMatch[1].trim();
      currentValue = kvMatch[2];
    } else if (attrMatch && !trimmedLine.startsWith('<')) {
      if (currentKey) {
        saveParsedArg(args, currentKey, currentValue);
      }
      currentKey = attrMatch[1].trim();
      currentValue = attrMatch[2] !== undefined ? attrMatch[2] : attrMatch[3] || '';
    } else if (attrStartMatch && !trimmedLine.startsWith('<')) {
      if (currentKey) {
        saveParsedArg(args, currentKey, currentValue);
      }
      currentKey = attrStartMatch[1].trim();
      currentValue = attrStartMatch[2];
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
  let trimmed = rawVal.trim();
  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    trimmed === 'true' || trimmed === 'false' ||
    /^-?\d+(?:\.\d+)?$/.test(trimmed)
  ) {
    try {
      args[key] = JSON.parse(trimmed);
      return;
    } catch (e) {}
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)) {
    try {
      args[key] = JSON.parse(trimmed);
      return;
    } catch (e) {
      trimmed = trimmed.slice(1, -1);
    }
  }
  args[key] = trimmed;
}

const KNOWN_EXTS = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'md',
  'py', 'sh', 'bash', 'yml', 'yaml', 'txt', 'svg', 'xml', 'c', 'cpp', 'h',
  'hpp', 'rs', 'go', 'java', 'rb', 'php', 'sql', 'toml', 'ini', 'env'
]);

/**
 * Scans conversation history and current response text to locate the most recently referenced file path.
 */
export function findRecentFilePath(messages = [], rawText = '') {
  // 1. First check rawText for explicit paths
  if (rawText && typeof rawText === 'string') {
    const textMatches = [
      ...rawText.matchAll(/(?:create(?: a)? new file:?|at|in|file|path|to|folder|create|edit|inspect|read|write)\s+[`"']?(\/?[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,10})[`"']?/gi),
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

      // Check standard OpenAI tool_calls in assistant message
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

      // Check Anthropic/Cline style tool_use and tool_result blocks in msg.content
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part === 'object') {
            if (part.type === 'tool_use' && part.input) {
              const inp = part.input;
              if (inp.path && isValidCandidatePath(inp.path)) return inp.path;
              if (inp.file && isValidCandidatePath(inp.file)) return inp.file;
              if (Array.isArray(inp.files) && inp.files[0]) {
                const fp = typeof inp.files[0] === 'string' ? inp.files[0] : inp.files[0].path;
                if (isValidCandidatePath(fp)) return fp;
              }
            }
            if (part.type === 'tool_result' && part.content) {
              const contentStr = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
              const m = contentStr.match(/(?:edit|create|file|path):\s*(\/?[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/i);
              if (m && isValidCandidatePath(m[1])) return m[1].trim();
            }
          }
        }
      }

      // Check message text content
      let contentStr = '';
      if (typeof msg.content === 'string') {
        contentStr = msg.content;
      } else if (Array.isArray(msg.content)) {
        contentStr = msg.content.map(c => {
          if (typeof c === 'string') return c;
          if (c && typeof c === 'object') {
            if (c.text) return c.text;
            if (c.type === 'tool_result' && c.content) return typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
          }
          return '';
        }).join('\n');
      }

      if (contentStr) {
        // Direct Cline creation log format: "Cline wants to create a new file:\n\ncelestial-almanac/index.html"
        const clineCreateMatch = contentStr.match(/(?:wants to create a new file:?|wants to edit:?)\s*[`"']?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)[`"']?/i);
        if (clineCreateMatch && isValidCandidatePath(clineCreateMatch[1])) {
          return clineCreateMatch[1].trim();
        }

        const contentMatches = [
          ...contentStr.matchAll(/"path"\s*:\s*"([^"]+)"/g),
          ...contentStr.matchAll(/(?:oldTextPath|newTextPath|targetPath|Path)\s*=\s*["']([^"']+)["']/gi),
          ...contentStr.matchAll(/(?:create(?: a)? new file:?|at|in|file|path|to|folder|create|edit|inspect|read|write)\s+[`"']?(\/?[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,10})[`"']?/gi),
          ...contentStr.matchAll(/[`"'](\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,10})[`"']/gi),
          ...contentStr.matchAll(/(\/[a-zA-Z0-9_\-./]+(?:\/[a-zA-Z0-9_\-./]+)+\.[a-zA-Z0-9]{1,10})/g),
          ...contentStr.matchAll(/[`"']([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,10})[`"']/g),
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
  p = p.trim().replace(/^['"`]+|['"`]+$/g, '');
  if (p.length < 3 || p.length > 250) return false;
  // Reject pure numbers, floats, CSS values (e.g. 0.35, 1.5rem, 100%)
  if (/^-?\d+(?:\.\d+)?(?:px|em|rem|%|s|ms|vw|vh)?$/i.test(p)) return false;
  if (p.startsWith('http://') || p.startsWith('https://')) return false;
  if (p.includes('node_modules') || p.startsWith('data:')) return false;

  const extMatch = p.match(/\.([a-zA-Z0-9]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  if (!ext || /^\d+$/.test(ext)) return false; // missing or pure-digit extension e.g. .35

  // If bare filename without slashes, must be in known extension list
  if (!p.includes('/') && !p.includes('\\')) {
    return KNOWN_EXTS.has(ext);
  }

  // With slashes, must have an alphabetic extension
  return /[a-zA-Z]/.test(ext);
}

/**
 * Normalizes tool arguments across aliases and fills in missing paths or parameters
 * required by agent environments like Cline and OpenCode Desktop.
 */
export function normalizeToolArgs(toolName, args = {}, tools = [], rawText = '', messages = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    args = {};
  }

  const normToolName = (toolName || '').toLowerCase().trim();

  // 1. File modification / creation tools (Cline: editor, OpenCode: write, edit)
  if (['editor', 'write', 'edit', 'write_to_file', 'new_file', 'create_file', 'edit_file', 'replace_in_file'].includes(normToolName)) {
    // Normalise path / filePath
    let targetPath = args.filePath || args.path || args.file_path || args.target_file ||
                     args.targetFile || args.target_path || args.targetPath || args.file ||
                     args.filename || args.name || args.oldTextPath || args.old_text_path || args.newTextPath;

    if (!targetPath) {
      const fallbackPath = findRecentFilePath(messages, rawText);
      if (fallbackPath) {
        console.warn(`[Parser] Auto-resolved missing path for ${toolName} to: ${fallbackPath}`);
        targetPath = fallbackPath;
      }
    }
    if (!targetPath) {
      targetPath = 'index.html'; // Safe fallback
    }

    if (normToolName === 'editor') {
      args.path = targetPath;
      if (args.new_text === undefined) {
        args.new_text = args.newText !== undefined ? args.newText :
                        args.newtext !== undefined ? args.newtext :
                        args.content !== undefined ? args.content :
                        args.text !== undefined ? args.text :
                        args.code !== undefined ? args.code :
                        args.file_text !== undefined ? args.file_text :
                        args.body !== undefined ? args.body :
                        args.input !== undefined ? args.input :
                        '';
      }
      if (typeof args.new_text !== 'string') {
        args.new_text = String(args.new_text || '');
      }
      if (args.old_text === undefined && args.oldText !== undefined) {
        args.old_text = args.oldText;
      }
      delete args.newText;
      delete args.newtext;
      delete args.oldText;
      delete args.oldTextPath;
      delete args.newTextPath;
      delete args.content;
      delete args.file;
      delete args.filePath;
      delete args.target_file;
      delete args.targetFile;
      delete args.target_path;
      delete args.targetPath;
    } else if (normToolName === 'write') {
      // OpenCode write tool expects filePath and content
      args.filePath = targetPath;
      if (args.content === undefined) {
        args.content = args.new_text !== undefined ? args.new_text :
                       args.newText !== undefined ? args.newText :
                       args.text !== undefined ? args.text :
                       args.code !== undefined ? args.code :
                       args.file_text !== undefined ? args.file_text :
                       args.body !== undefined ? args.body :
                       args.input !== undefined ? args.input :
                       '';
      }
      if (typeof args.content !== 'string') {
        args.content = String(args.content || '');
      }
      delete args.path;
      delete args.new_text;
      delete args.newText;
      delete args.file;
      delete args.target_file;
    } else if (normToolName === 'edit') {
      // OpenCode edit tool expects filePath, oldString, newString
      args.filePath = targetPath;
      if (args.oldString === undefined) {
        args.oldString = args.old_string !== undefined ? args.old_string :
                         args.old_text !== undefined ? args.old_text :
                         args.oldText !== undefined ? args.oldText :
                         args.old !== undefined ? args.old :
                         '';
      }
      if (args.newString === undefined) {
        args.newString = args.new_string !== undefined ? args.new_string :
                         args.new_text !== undefined ? args.new_text :
                         args.newText !== undefined ? args.newText :
                         args.content !== undefined ? args.content :
                         args.text !== undefined ? args.text :
                         '';
      }
      if (typeof args.oldString !== 'string') args.oldString = String(args.oldString || '');
      if (typeof args.newString !== 'string') args.newString = String(args.newString || '');
      delete args.path;
      delete args.old_string;
      delete args.old_text;
      delete args.oldText;
      delete args.new_string;
      delete args.new_text;
      delete args.newText;
      delete args.content;
    } else {
      args.path = targetPath;
      if (args.content === undefined) {
        args.content = args.new_text !== undefined ? args.new_text :
                       args.newText !== undefined ? args.newText :
                       args.text !== undefined ? args.text :
                       args.code !== undefined ? args.code :
                       args.file_text !== undefined ? args.file_text :
                       args.body !== undefined ? args.body :
                       args.input !== undefined ? args.input :
                       '';
      }
      if (typeof args.content !== 'string') {
        args.content = String(args.content || '');
      }
      delete args.new_text;
      delete args.newText;
      delete args.file;
      delete args.filePath;
    }
  }

  // 2. File reading / inspection tools (Cline: read_files, OpenCode: read)
  if (normToolName === 'read_files') {
    if (!args.files || !Array.isArray(args.files) || args.files.length === 0) {
      let targetPath = args.path || args.file || args.filePath || args.target_file;
      if (!targetPath && Array.isArray(args.paths) && args.paths[0]) {
        targetPath = args.paths[0];
      }
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
    delete args.paths;
  } else if (normToolName === 'read' || normToolName === 'read_file') {
    let targetPath = args.filePath || args.path || args.file || args.target_file;
    if (!targetPath) {
      targetPath = findRecentFilePath(messages, rawText);
    }
    if (normToolName === 'read') {
      args.filePath = targetPath || '';
      delete args.path;
      delete args.file;
      delete args.target_file;
    } else {
      args.path = targetPath || '';
      delete args.filePath;
      delete args.file;
    }
  }

  // 3. Command execution tools (Cline: run_commands, OpenCode: bash, execute_command)
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
    // If commands array is empty, check if rawText intended a cleanup / file removal or list
    if (!args.commands || args.commands.length === 0) {
      const junkMatch = rawText.match(/(?:junk file named|remove that file|clean up|remove)\s*[`'"]?([a-zA-Z0-9_\-./]+)[`'"]?/i);
      if (junkMatch && junkMatch[1]) {
        console.warn(`[Parser] Auto-populated run_commands with cleanup command: rm -f ${junkMatch[1]}`);
        args.commands = [`rm -f "${junkMatch[1]}"`];
      }
    }
  } else if (['bash', 'execute_command', 'run_command', 'execute_bash'].includes(normToolName)) {
    if (!args.command) {
      if (Array.isArray(args.commands) && args.commands.length > 0) {
        args.command = args.commands.join(' && ');
      } else if (args.cmd) {
        args.command = args.cmd;
      } else if (args.commands && typeof args.commands === 'string') {
        args.command = args.commands;
      }
    }
    if (args.command === undefined) {
      args.command = '';
    }
    delete args.commands;
    delete args.cmd;
  }

  // 4. Search tools (OpenCode: glob, grep)
  if (normToolName === 'glob' || normToolName === 'grep') {
    if (!args.pattern) {
      args.pattern = args.query || args.search || args.regex || '*';
    }
    delete args.query;
    delete args.search;
    delete args.regex;
  }

  // 5. Skills tool (Cline skill execution)
  if (normToolName === 'skills') {
    if (!args.skill && args.name) {
      args.skill = args.name;
      delete args.name;
    }
    if (!args.skill && args.command) {
      args.skill = args.command;
      delete args.command;
    }
    if (!args.args && args.parameters) {
      args.args = typeof args.parameters === 'string' ? args.parameters : JSON.stringify(args.parameters);
      delete args.parameters;
    }
  }

  // 6. Question tools
  if (['ask_followup_question', 'ask_question', 'question'].includes(normToolName)) {
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
    let toolName = (match[1] || match[2] || '').replace(/[>\]:]+$/, '').trim();
    let body = match[3].trim();

    // Clean up partial trailing markers like ](tool call not yet finished) or dangling brackets
    body = body.replace(/\]\s*\(tool call not yet finished\)/gi, '').trim();

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

    // 3. Check if first line or leading token is the tool name: e.g. <tool_call>ask_question\n or <tool_call>editor>\n or <tool_call>editor newText="..."
    if (!toolName) {
      const firstLineMatch = body.match(/^<?([a-zA-Z0-9_\-\.]+)[>\]:]*(?:\s+([\s\S]*)$|\s*\n([\s\S]*)$|\s*$)/);
      if (firstLineMatch) {
        const candidate = firstLineMatch[1].trim();
        const candidateLower = candidate.toLowerCase();
        if (!validParamNames.has(candidateLower)) {
          toolName = candidate;
          body = (firstLineMatch[2] !== undefined ? firstLineMatch[2] : firstLineMatch[3] || '').trim();
        }
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

    // 5. If toolName still missing, infer from parameters in body
    if (!toolName) {
      if (body.includes('new_text') || body.includes('newText') || body.includes('old_text') || body.includes('oldText')) {
        toolName = 'editor';
      } else if (body.includes('commands') || body.includes('command')) {
        toolName = 'run_commands';
      } else if (body.includes('files') || body.includes('file')) {
        toolName = 'read_files';
      } else if (body.includes('question') || body.includes('options')) {
        toolName = 'ask_followup_question';
      } else if (toolList && toolList.length > 0) {
        toolName = toolList[0].function?.name || toolList[0].name;
      }
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

function extractStandaloneCDATA(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/^(?:<|〈)(?:!|！)\[CDATA\[([\s\S]*?)]](?:>|＞|〉)$/i);
  return m ? m[1] : null;
}

export function parseMarkupParameterValue(bodyText, paramName = '') {
  if (bodyText === undefined || bodyText === null) return '';
  const trimmed = String(bodyText).trim();

  // 1. Array parsing with <item>...</item>
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  const items = [];
  let itemMatch;
  while ((itemMatch = itemRegex.exec(trimmed)) !== null) {
    items.push(parseMarkupParameterValue(itemMatch[1].trim(), 'item'));
  }
  if (items.length > 0) {
    return items;
  }

  // 2. Standalone CDATA unwrapping
  const standaloneCDATA = extractStandaloneCDATA(trimmed);
  if (standaloneCDATA !== null) {
    return standaloneCDATA;
  }

  // 3. Partial or embedded CDATA
  const embeddedCDATA = trimmed.match(/(?:<|〈)(?:!|！)\[CDATA\[([\s\S]*?)]](?:>|＞|〉)/i);
  if (embeddedCDATA && trimmed.startsWith(embeddedCDATA[0])) {
    return embeddedCDATA[1];
  }

  const isTextParam = ['new_text', 'old_text', 'content', 'diff', 'code', 'script', 'command', 'path', 'url', 'query', 'message', 'text', 'instructions', 'instruction', 'raw', 'html', 'file', 'prompt', 'input'].includes(paramName?.toLowerCase());
  const isHtmlDocument = /<!doctype\b|<html\b|<head\b|<body\b/i.test(trimmed);

  // 4. Nested XML child elements (for structured object parameters, not code/text)
  if (!isTextParam && !isHtmlDocument) {
    const childTagRegex = /<([a-zA-Z0-9_\-]+)>([\s\S]*?)<\/\1>/gi;
    let cMatch;
    const childObj = {};
    let childCount = 0;
    while ((cMatch = childTagRegex.exec(trimmed)) !== null) {
      childCount++;
      childObj[cMatch[1]] = parseMarkupParameterValue(cMatch[2].trim(), cMatch[1]);
    }
    if (childCount > 0) {
      return childObj;
    }
  }

  // 5. Native JSON literals
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { return JSON.parse(trimmed); } catch (e) {}
  }

  return trimmed;
}

export function normalizeDSMLMarkup(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<(?:\|?DSML\|?|[!！]?DSML[!！]?|dsml-)?tool[-_]?calls[^>]*>/gi, '<tool_calls>')
    .replace(/<\/(?:\|?DSML\|?|[!！]?DSML[!！]?|dsml-)?tool[-_]?calls>/gi, '</tool_calls>')
    .replace(/<(?:\|?DSML\|?|[!！]?DSML[!！]?|dsml-)?invoke\s+/gi, '<invoke ')
    .replace(/<\/(?:\|?DSML\|?|[!！]?DSML[!！]?|dsml-)?invoke>/gi, '</invoke>')
    .replace(/<(?:\|?DSML\|?|[!！]?DSML[!！]?|dsml-)?parameter\s+/gi, '<parameter ')
    .replace(/<\/(?:\|?DSML\|?|[!！]?DSML[!！]?|dsml-)?parameter>/gi, '</parameter>');
}

/**
 * Parses DSML-prefixed or canonical XML tool calls (<|DSML|tool_calls> / <tool_calls>).
 */
export function parseDSMLOrCanonicalToolCalls(text, toolList = []) {
  if (!text || typeof text !== 'string') return null;

  // Find index of first tool_calls, invoke, or parameter
  const firstIdx = text.search(/<(?:\|?DSML\|?|[!！]?DSML[!！]?|dsml-)?(?:tool[-_]?calls|invoke|parameter)\b/i);
  if (firstIdx === -1) return null;

  let norm = normalizeDSMLMarkup(text);

  // Narrow repair 1: If closing </tool_calls> exists but opening <tool_calls> was omitted before <invoke>
  if (norm.includes('</tool_calls>') && !norm.includes('<tool_calls>')) {
    const invokePos = norm.indexOf('<invoke');
    if (invokePos !== -1) {
      norm = norm.slice(0, invokePos) + '<tool_calls>' + norm.slice(invokePos);
    }
  }

  // Narrow repair 2: If parameters exist but <invoke name="..."> was omitted
  if (!/<invoke\s+name=["']/i.test(norm) && /<parameter\s+name=["']/i.test(norm)) {
    let inferredTool = 'editor';
    if (/<parameter\s+name=["'](?:commands|command)["']/i.test(norm)) inferredTool = 'run_commands';
    else if (/<parameter\s+name=["'](?:files|file)["']/i.test(norm)) inferredTool = 'read_files';
    else if (/<parameter\s+name=["'](?:question|prompt)["']/i.test(norm)) inferredTool = 'ask_followup_question';
    else if (/<parameter\s+name=["'](?:skill)["']/i.test(norm)) inferredTool = 'skills';
    else if (toolList && toolList[0]) inferredTool = toolList[0].function?.name || toolList[0].name || 'editor';

    const firstParamPos = norm.indexOf('<parameter');
    let lastParamEnd = norm.lastIndexOf('</parameter>');
    if (lastParamEnd !== -1) lastParamEnd += 12;
    else lastParamEnd = norm.length;

    norm = norm.slice(0, firstParamPos) + `<invoke name="${inferredTool}">` + norm.slice(firstParamPos, lastParamEnd) + '</invoke>' + norm.slice(lastParamEnd);
  }

  const calls = [];
  const invokeRegex = /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/gi;
  let m;

  while ((m = invokeRegex.exec(norm)) !== null) {
    const toolName = m[1].trim();
    const body = m[2];
    const args = {};

    const paramRegex = /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/gi;
    let pm;
    let foundParam = false;
    while ((pm = paramRegex.exec(body)) !== null) {
      foundParam = true;
      const pName = pm[1].trim();
      args[pName] = parseMarkupParameterValue(pm[2], pName);
    }

    // If no <parameter> tags found, check if body is JSON or KV
    if (!foundParam && body.trim()) {
      try {
        const parsedJson = JSON.parse(body.trim());
        if (parsedJson && typeof parsedJson === 'object') {
          Object.assign(args, parsedJson.arguments || parsedJson.parameters || parsedJson);
        }
      } catch (e) {
        Object.assign(args, parseKvOrYaml(body));
      }
    }

    calls.push({
      id: `call_${crypto.randomBytes(8).toString('hex')}`,
      type: 'function',
      function: {
        name: toolName,
        arguments: JSON.stringify(args),
      },
    });
  }

  if (calls.length > 0) {
    return {
      toolCalls: calls,
      toolCall: calls[0],
      index: firstIdx,
    };
  }

  return null;
}

/**
 * Parses XML-based tool call formats commonly used by Cline and agent frameworks:
 * 1. <|DSML|tool_calls> / <tool_calls> (DS2API format with CDATA and <item> array support)
 * 2. <tool_call>...</tool_call> (YAML, JSON, XML tags, or key-value format)
 * 3. Direct tool tags: <write_to_file><path>...</path><content>...</content></write_to_file>
 */
function parseXmlToolCall(text, toolList = []) {
  // 1. Match DSML and canonical XML format (<|DSML|tool_calls> or <tool_calls>)
  const dsmlResult = parseDSMLOrCanonicalToolCalls(text, toolList);
  if (dsmlResult) {
    return dsmlResult;
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
          args[cMatch[1]] = parseMarkupParameterValue(cMatch[2].trim(), cMatch[1]);
        }
      }
      if (count === 0) {
        if (toolName.toLowerCase() === 'editor') {
          args.new_text = parseMarkupParameterValue(body.trim(), 'new_text');
        } else {
          args.content = parseMarkupParameterValue(body.trim(), 'content');
        }
      }
      const tc = {
        id: `call_${crypto.randomBytes(8).toString('hex')}`,
        type: 'function',
        function: { name: toolName, arguments: JSON.stringify(args) },
      };
      return {
        toolCall: tc,
        toolCalls: [tc],
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
    return text
      .replace(/<(?:\|?DSML\|?|[!！]?DSML[!！]?|dsml-)?tool[-_]?calls[^>]*>[\s\S]*$/i, '')
      .replace(/<(?:tool_call|tool-call)[^>]*>[\s\S]*$/i, '')
      .trim();
  };

  // 1. Check XML format first
  const xmlResult = parseXmlToolCall(trimmed, tools);
  if (xmlResult) {
    const preText = cleanPreText(trimmed.slice(0, xmlResult.index));
    const rawCalls = xmlResult.toolCalls || (xmlResult.toolCall ? [xmlResult.toolCall] : []);
    const normalizedCalls = rawCalls.map(tc => applyNormalizedToolCall(tc, tools, trimmed, messages));
    return {
      isToolCall: true,
      toolCalls: normalizedCalls,
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

  // 5. Fallback: Simulated terminal / command execution recovery (e.g. OpenCode 'bash' or Cline 'run_commands')
  const cmdTool = (tools || []).find(t => {
    const name = (t.function?.name || t.name || '').toLowerCase();
    return ['bash', 'execute_command', 'run_commands', 'run_command', 'execute_bash'].includes(name);
  });

  if (cmdTool) {
    const sim = extractSimulatedCommand(trimmed);
    if (sim && sim.command) {
      const toolName = cmdTool.function?.name || cmdTool.name;
      const isRunCommands = toolName.toLowerCase() === 'run_commands';
      const args = isRunCommands ? { commands: [sim.command] } : { command: sim.command };
      console.warn(`[Parser] Intercepted simulated command execution ("${sim.command}"). Auto-synthesizing ${toolName} tool call...`);
      const normalizedToolCall = applyNormalizedToolCall({
        id: `call_${crypto.randomBytes(8).toString('hex')}`,
        type: 'function',
        function: {
          name: toolName,
          arguments: JSON.stringify(args),
        },
      }, tools, trimmed, messages);

      return {
        isToolCall: true,
        toolCalls: [normalizedToolCall],
        content: sim.preText || null,
      };
    }
  }

  // 6. Fallback: File write / code block recovery (OpenCode 'write' / 'edit' / Cline 'editor')
  const fileTool = (tools || []).find(t => {
    const name = (t.function?.name || t.name || '').toLowerCase();
    return ['write', 'editor', 'write_to_file', 'edit'].includes(name);
  });

  if (fileTool) {
    const simFile = extractSimulatedFileWrite(trimmed, messages);
    if (simFile && simFile.path && simFile.content) {
      const toolName = fileTool.function?.name || fileTool.name;
      const lowerTool = toolName.toLowerCase();
      let args = {};
      if (lowerTool === 'editor') {
        args = { path: simFile.path, new_text: simFile.content };
      } else if (lowerTool === 'write') {
        args = { filePath: simFile.path, content: simFile.content };
      } else if (lowerTool === 'edit') {
        args = { filePath: simFile.path, newString: simFile.content };
      } else {
        args = { path: simFile.path, content: simFile.content };
      }
      console.warn(`[Parser] Intercepted raw code block file write for ${simFile.path}. Auto-synthesizing ${toolName}...`);
      const normalizedToolCall = applyNormalizedToolCall({
        id: `call_${crypto.randomBytes(8).toString('hex')}`,
        type: 'function',
        function: {
          name: toolName,
          arguments: JSON.stringify(args),
        },
      }, tools, trimmed, messages);

      return {
        isToolCall: true,
        toolCalls: [normalizedToolCall],
        content: simFile.preText || null,
      };
    }
  }

  // Standard plain text
  return { isToolCall: false, content: rawText };
}

/**
 * Extracts executable command from simulated terminal transcripts or shell code blocks.
 */
export function extractSimulatedCommand(text) {
  if (!text || typeof text !== 'string') return null;

  // 1. Check for markdown shell code blocks: ```bash, ```sh, ```zsh, ```shell
  const codeBlockRegex = /```(?:bash|sh|zsh|shell|console|terminal)\s*([\s\S]*?)\s*```/gi;
  let cbMatch;
  while ((cbMatch = codeBlockRegex.exec(text)) !== null) {
    const blockBody = cbMatch[1].trim();
    const lines = blockBody.split(/\r?\n/)
      .map(l => l.trim().replace(/^[$%#]\s*/, ''))
      .filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
    if (lines.length > 0) {
      const cmdCandidates = lines.filter(l => !/^(?:Compiling|Finished|warning:|error:|test result:|tests::|running\s+\d+|Done in|PASS|FAIL|BUILD SUCCESS)\b/i.test(l));
      if (cmdCandidates.length > 0) {
        return {
          command: cmdCandidates.join(' && '),
          preText: text.slice(0, cbMatch.index).trim(),
        };
      }
    }
  }

  // 2. Check for lines starting with shell prompt: $ or % or #
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const promptMatch = line.match(/^[$%#]\s+(.+)$/);
    if (promptMatch) {
      const rawCmd = promptMatch[1].trim();
      const outputSplit = rawCmd.match(/^(.+?)(?:\s+(?:Compiling|Running|Finished|warning:|error:|test result:|tests::|running\s+\d+\s+test|Done in|BUILD\s|yarn\s|npm\s+(?:warn|err)|stdout:|stderr:).*)$/i);
      const cleanCmd = outputSplit ? outputSplit[1].trim() : rawCmd;
      if (cleanCmd.length > 0) {
        const preText = lines.slice(0, i).join('\n').trim();
        return {
          command: cleanCmd,
          preText: preText || null,
        };
      }
    }
  }

  // 3. Check for text starting directly with $ or % even without newlines:
  const directMatch = text.match(/^\s*[$%#]\s+([\s\S]+)$/);
  if (directMatch) {
    const candidate = directMatch[1].trim();
    const firstLine = candidate.split(/\r?\n/)[0].trim();
    const outputSplit = firstLine.match(/^(.+?)(?:\s+(?:Compiling|Running|Finished|warning:|error:|test result:|tests::|running\s+\d+\s+test|Done in|BUILD\s|yarn\s|npm\s+(?:warn|err)|stdout:|stderr:).*)$/i);
    const cleanCmd = outputSplit ? outputSplit[1].trim() : firstLine;
    if (cleanCmd.length > 0) {
      return {
        command: cleanCmd,
        preText: null,
      };
    }
  }

  return null;
}

/**
 * Extracts intended file path and code content when a model emits raw markdown code blocks
 * instead of invoking write or editor tools.
 */
export function extractSimulatedFileWrite(text, messages = []) {
  if (!text || typeof text !== 'string') return null;

  const writeIntentMatch = text.match(/(?:rewriting|writing|write|creating|create|saving|save|edit|replace|update|full code for)\s+[`'"]?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)[`'"]?/i);
  let targetPath = writeIntentMatch ? writeIntentMatch[1] : null;

  if (!targetPath) {
    targetPath = findRecentFilePath(messages, text);
  }

  if (!targetPath || !isValidCandidatePath(targetPath)) {
    return null;
  }

  const codeBlockRegex = /```(?:[a-zA-Z0-9_\-]+)?\s*([\s\S]*?)\s*```/g;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const code = match[1].trim();
    if (code.length > 15 && !code.startsWith('{') && !code.startsWith('$')) {
      const preText = text.slice(0, match.index).trim();
      return {
        path: targetPath,
        content: code,
        preText: preText || null,
      };
    }
  }

  return null;
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
