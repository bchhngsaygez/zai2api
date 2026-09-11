import http from 'http';

async function testSubagentApi() {
  console.log('=====================================================');
  console.log('   Testing Subagent API /v1/subagent/task');
  console.log('=====================================================\n');

  const payload = {
    prompt: 'Create a simple TypeScript calculator module with two files: math.ts containing add and subtract functions, and index.ts importing and demonstrating them.',
    outputDir: './generated_calculator',
    stream: false,
  };

  const reqData = JSON.stringify(payload);
  const options = {
    hostname: '127.0.0.1',
    port: 3000,
    path: '/v1/subagent/task',
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
          console.log('\nSubagent Response:');
          console.log(JSON.stringify(json, null, 2));
          resolve(json);
        } catch (e) {
          console.error('Failed to parse response:', e);
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

testSubagentApi().catch(console.error);
