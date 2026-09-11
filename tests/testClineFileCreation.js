import http from 'http';

async function testClineFileCreation() {
  console.log('Testing Cline tool calling via /v1/chat/completions (stream=true)...');

  const payload = {
    model: 'glm-5.3-flash',
    thinking_mode: 'low',
    stream: true,
    messages: [
      {
        role: 'system',
        content: 'You are Cline, a coding assistant with access to tools. If you need to create or write a file, use the write_to_file tool.',
      },
      {
        role: 'user',
        content: 'Create a new file named /tmp/test_snake.html with a simple HTML5 boilerplate.',
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'write_to_file',
          description: 'Write or create a file on disk',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'The absolute file path' },
              content: { type: 'string', description: 'The full file content' },
            },
            required: ['path', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'execute_command',
          description: 'Execute a terminal command',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'The CLI command' },
            },
            required: ['command'],
          },
        },
      },
    ],
  };

  const reqData = JSON.stringify(payload);
  const options = {
    hostname: '127.0.0.1',
    port: 3000,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(reqData),
    },
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let buffer = '';
      let receivedToolCalls = [];
      let receivedContent = '';

      res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (trimmed.startsWith('data: ')) {
            try {
              const json = JSON.parse(trimmed.slice(6));
              const delta = json.choices?.[0]?.delta;
              if (delta?.content) {
                receivedContent += delta.content;
              }
              if (delta?.tool_calls) {
                receivedToolCalls.push(...delta.tool_calls);
              }
              const finishReason = json.choices?.[0]?.finish_reason;
              if (finishReason) {
                console.log('Stream finished with finish_reason:', finishReason);
              }
            } catch (e) {}
          }
        }
      });

      res.on('end', () => {
        console.log('\n--- Stream Complete ---');
        console.log('Assistant content before tool call:', receivedContent);
        console.log('Received tool calls count:', receivedToolCalls.length);
        if (receivedToolCalls.length > 0) {
          console.log('\n>>> SUCCESS: Real tool call emitted to client!');
          console.log('Tool call details:', JSON.stringify(receivedToolCalls, null, 2));
          resolve(true);
        } else {
          console.warn('\n>>> FAILURE: No tool call emitted in stream');
          resolve(false);
        }
      });
    });

    req.on('error', reject);
    req.write(reqData);
    req.end();
  });
}

testClineFileCreation().catch(console.error);
