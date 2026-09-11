/**
 * Wraps tools definitions and chat history into a strictly enforced prompt
 * for the GLM model on chat.z.ai to support both JSON and XML tool invocation patterns,
 * avoid conversational dead-ends, and prevent hallucinated tool results.
 */

export function buildPromptWithTools({ messages = [], tools = [] }) {
  let prompt = '';
  const hasTools = Array.isArray(tools) && tools.length > 0;

  // 1. Tool schemas & strict execution constraints
  let toolInstruction = '';
  if (hasTools) {
    const formattedTools = tools.map(t => {
      if (t.function) {
        return {
          name: t.function.name,
          description: t.function.description || '',
          parameters: t.function.parameters || {},
        };
      }
      return t;
    });

    toolInstruction = `[CRITICAL SYSTEM DIRECTIVE: TOOL CALLING]
You have access to the following tools:
\`\`\`json
${JSON.stringify(formattedTools, null, 2)}
\`\`\`

EXECUTION RULES:
1. To invoke a tool, output ONE tool call using standard JSON or XML format:

FORMAT A (Tool JSON):
\`\`\`json
{
  "name": "tool_name",
  "arguments": {
    "param1": "value"
  }
}
\`\`\`
OR flat parameters:
\`\`\`json
{
  "name": "tool_name",
  "param1": "value"
}
\`\`\`

FORMAT B (XML Invoke):
<invoke name="tool_name">
<parameter name="param1">value</parameter>
</invoke>

FORMAT C (Tool Call Tag):
<tool_call>tool_name
param1: value
param2: ["value1", "value2"]
</tool_call>

2. CRITICAL - STOP IMMEDIATELY AFTER CLOSING THE TOOL CALL:
Once you finish writing the tool call (closing \`\`\`, </invoke>, or </tool_call>), YOU MUST STOP GENERATING IMMEDIATELY.
DO NOT write fake tool results.
DO NOT invent or pretend you ran the command or edited the file.
The IDE environment executes the tool in the real OS file system and returns the actual result in the next turn.

3. You may provide a short 1-sentence thought before invoking the tool.
4. MANDATORY: When the user request requires creating, reading, editing, or executing files or commands, you MUST ALWAYS output the tool call block. NEVER say you will create or edit a file without outputting the tool call block in the same message.
5. If and only if no tool or command is required (e.g. general conversation, pure explanation), respond normally with standard text.`;
  }

  // 2. Process conversation messages
  const formattedMessages = [];

  for (const msg of messages) {
    const role = msg.role || 'user';
    let content = '';
    if (Array.isArray(msg.content)) {
      content = msg.content
        .map(part => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object') {
            if (part.type === 'text') return part.text || '';
            if (part.type === 'image_url') return '[Attached Image]';
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    } else {
      content = msg.content || '';
    }

    if (role === 'system') {
      formattedMessages.push(`[System Context]\n${content}`);
    } else if (role === 'user') {
      formattedMessages.push(`User: ${content}`);
    } else if (role === 'assistant') {
      if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const calls = msg.tool_calls.map(tc => {
          const fn = tc.function || {};
          let args = fn.arguments;
          try {
            if (typeof args === 'string') args = JSON.parse(args);
          } catch (e) {}
          return { name: fn.name, arguments: args };
        });
        const callContent = content ? `${content}\n\n` : '';
        formattedMessages.push(`Assistant: ${callContent}\`\`\`json\n${JSON.stringify(calls[0], null, 2)}\n\`\`\``);
      } else {
        formattedMessages.push(`Assistant: ${content}`);
      }
    } else if (role === 'tool') {
      const toolId = msg.tool_call_id || msg.name || 'tool';
      formattedMessages.push(`[Real Tool Execution Result (${toolId})]:\n${content}`);
    }
  }

  // Combine instructions and messages
  const sections = [];
  if (toolInstruction) {
    sections.push(toolInstruction);
  }

  if (formattedMessages.length > 0) {
    sections.push(formattedMessages.join('\n\n'));
  }

  if (hasTools) {
    sections.push('[Reminder: If an action, file operation, question, or command is requested, invoke the appropriate tool immediately in ```json, <invoke>, or <tool_call> and STOP.]');
  }

  prompt = sections.join('\n\n---\n\n');
  return prompt;
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
