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

    toolInstruction = `[SYSTEM: AVAILABLE TOOLS]
\`\`\`json
${JSON.stringify(formattedTools)}
\`\`\`

[TOOL INVOCATION DIRECTIVE]
To execute an action, output EXACTLY ONE tool call and STOP immediately. Formats accepted:

Option 1 (JSON Block):
\`\`\`json
{"name": "tool_name", "arguments": {"param1": "value1"}}
\`\`\`

Option 2 (XML Tag):
<invoke name="tool_name">
<parameter name="param1">value1</parameter>
</invoke>

Option 3 (Tool Tag):
<tool_call>tool_name
param1: value1
</tool_call>

STRICT RULES:
1. NEVER fabricate simulated tool outputs, file contents, or shell results. Real execution occurs in the host environment.
2. STOP generation immediately upon closing the tool block (\`\`\`, </invoke>, or </tool_call>).
3. If an action, inspection, or file modification is needed, emit the tool call IMMEDIATELY with ZERO conversational filler.
4. If no tool is needed, respond with standard plain text.`;
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
    sections.push('[FINAL DIRECTIVE: If a tool or command is required, emit the tool call NOW and STOP. Do not output explanatory chatter before or after.]');
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
