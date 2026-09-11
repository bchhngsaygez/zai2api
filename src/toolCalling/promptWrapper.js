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

[CRITICAL DIRECTIVE: TOOL EXECUTION RULES]
You are operating inside an autonomous developer agent (Cline/Cursor).
To perform any file operation, edit, command, or ask the user a question, you MUST output a tool call using the standard JSON format and STOP immediately:

\`\`\`json
{
  "name": "tool_name",
  "arguments": {
    "param1": "value1"
  }
}
\`\`\`

CRITICAL INVOCATION RULES:
1. ALWAYS use the standard \`\`\`json format shown above. DO NOT invent hybrid XML tags like <tool_call> or mix <invoke>.
2. TAKE ACTION IMMEDIATELY: When the user asks you to build, create, or modify code, start coding immediately. Make sensible defaults (e.g. create a dedicated project folder in the workspace) and output the file/command tool call NOW.
3. NEVER STALL OR OUTLINE UNEXECUTED PLANS: NEVER say "I will build...", "Quick plan before I start...", or "One decision needed from you:" without outputting the corresponding tool call in the EXACT SAME message. If you state a plan, you MUST execute step 1 immediately in this turn.
4. NEVER ASK QUESTIONS IN PLAIN TEXT: If you genuinely need user confirmation, clarification, or a decision, you MUST invoke the question tool (e.g. ask_followup_question or ask_question) as a tool call with the question and selectable options. DO NOT write questions in plain conversational text.
5. STOP GENERATION: Stop immediately after the closing \`\`\` of the JSON tool block. NEVER fabricate simulated tool outputs.`;
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
    sections.push('[FINAL DIRECTIVE: If an action, file operation, command, or question is needed, output the tool call NOW and STOP. NEVER output a plan or ask a question without emitting the tool call.]');
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
