import http from 'http';

async function testToolCalling() {
  console.log('=====================================================');
  console.log('   Testing Emulated Tool Calling via /v1/chat/completions');
  console.log('=====================================================\n');

  const payload = {
    model: 'glm-5.3-flash',
    messages: [
      { role: 'user', content: 'What is the current weather in Paris?' }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_current_weather',
          description: 'Get current weather conditions for a given location',
          parameters: {
            type: 'object',
            properties: {
              location: {
                type: 'string',
                description: 'The city name or country',
              },
              unit: {
                type: 'string',
                enum: ['celsius', 'fahrenheit'],
              },
            },
            required: ['location'],
          },
        },
      }
    ],
    stream: false,
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
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        console.log('HTTP Status:', res.statusCode);
        try {
          const json = JSON.parse(body);
          console.log('\nResponse Payload:');
          console.log(JSON.stringify(json, null, 2));

          const message = json.choices?.[0]?.message;
          if (message?.tool_calls && message.tool_calls.length > 0) {
            console.log('\n>>> SUCCESS: Tool call received and parsed correctly!');
            console.log('Tool Name:', message.tool_calls[0].function.name);
            console.log('Arguments:', message.tool_calls[0].function.arguments);
          } else {
            console.warn('\n>>> Notice: No tool call detected in response message');
          }
          resolve(json);
        } catch (e) {
          console.error('Failed to parse JSON response:', e);
          console.log('Raw body:', body);
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(reqData);
    req.end();
  });
}

testToolCalling().catch(console.error);
