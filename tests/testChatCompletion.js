import http from 'http';

async function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function testModels() {
  console.log('--- Testing GET /v1/models ---');
  const res = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/v1/models',
    method: 'GET',
  });
  console.log('Status:', res.status);
  console.log('Response:', res.body);
}

async function testNonStreamingChat() {
  console.log('\n--- Testing POST /v1/chat/completions (Non-Streaming) ---');
  const payload = {
    model: 'glm-5.3-flash',
    messages: [
      { role: 'user', content: 'Say "Antigravity Proxy Test OK" in exactly 4 words.' }
    ],
    stream: false,
  };

  const res = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  }, payload);

  console.log('Status:', res.status);
  console.log('Response:', JSON.stringify(JSON.parse(res.body), null, 2));
}

async function testStreamingChat() {
  console.log('\n--- Testing POST /v1/chat/completions (Streaming) ---');
  const payload = {
    model: 'glm-5.3-flash',
    messages: [
      { role: 'user', content: 'Count from 1 to 5.' }
    ],
    stream: true,
  };

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3000,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      console.log('Streaming Status:', res.statusCode);
      let streamedContent = '';
      res.on('data', (chunk) => {
        const text = chunk.toString();
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const data = JSON.parse(line.slice(6));
              const delta = data.choices?.[0]?.delta;
              if (delta?.content) {
                process.stdout.write(delta.content);
                streamedContent += delta.content;
              }
            } catch (e) {}
          }
        }
      });
      res.on('end', () => {
        console.log('\n[Stream Finished]');
        resolve(streamedContent);
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

async function runAll() {
  await testModels();
  await testNonStreamingChat();
  await testStreamingChat();
}

runAll().catch(console.error);
