import assert from 'assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { createApp } from '../src/server/app.js';
import { authManager } from '../src/server/authManager.js';
import { apiKeysManager } from '../src/server/apiKeysManager.js';
import { config } from '../src/config.js';

console.log('=====================================================');
console.log('            Testing API Keys Management              ');
console.log('=====================================================\n');

const API_KEYS_FILE = path.resolve(config.projectRoot, 'api_keys.json');

function request(server, options, body = null) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const reqOptions = {
      hostname: '127.0.0.1',
      port: address.port,
      path: options.path,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, data, json });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  // Backup existing api_keys.json if present
  let originalKeysBackup = null;
  if (fs.existsSync(API_KEYS_FILE)) {
    originalKeysBackup = fs.readFileSync(API_KEYS_FILE, 'utf-8');
  }

  const app = createApp();
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`[Test Server] Listening on port ${port}\n`);

  try {
    const sessionToken = authManager.createSession();

    // 1. Unauthenticated access to /api/keys rejected
    {
      const res = await request(server, { path: '/api/keys', method: 'GET' });
      assert.strictEqual(res.status, 401, 'Unauthenticated /api/keys must return 401');
      console.log('✓ Test 1 Passed: Unauthenticated /api/keys rejected with 401');
    }

    // 2. Create API key
    let createdKey = null;
    {
      const res = await request(server, {
        path: '/api/keys',
        method: 'POST',
        headers: { 'X-Dashboard-Token': sessionToken },
      }, { name: 'Cursor Extension Test' });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.success, true);
      assert.ok(res.json.key.id);
      assert.strictEqual(res.json.key.name, 'Cursor Extension Test');
      assert.ok(res.json.key.key.startsWith('sk-zai-'));
      assert.strictEqual(res.json.key.active, true);
      createdKey = res.json.key;
      console.log('✓ Test 2 Passed: Created API key with auto-generated sk-zai-... secret');
    }

    // 3. List API keys
    {
      const res = await request(server, {
        path: '/api/keys',
        method: 'GET',
        headers: { 'X-Dashboard-Token': sessionToken },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.success, true);
      assert.ok(Array.isArray(res.json.keys));
      const found = res.json.keys.find(k => k.id === createdKey.id);
      assert.ok(found, 'Created key must be listed');
      console.log('✓ Test 3 Passed: List API keys includes newly created key');
    }

    // 4. OpenAI endpoint rejected with missing key when keys are configured
    {
      const res = await request(server, { path: '/v1/models', method: 'GET' });
      assert.strictEqual(res.status, 401, 'Request without key must return 401 when keys exist');
      console.log('✓ Test 4 Passed: Client call to /v1/models rejected without key');
    }

    // 5. OpenAI endpoint rejected with invalid key
    {
      const res = await request(server, {
        path: '/v1/models',
        method: 'GET',
        headers: { Authorization: 'Bearer sk-invalid-key-12345' },
      });
      assert.strictEqual(res.status, 401);
      console.log('✓ Test 5 Passed: Client call to /v1/models rejected with invalid key');
    }

    // 6. OpenAI endpoint succeeds with valid API key
    {
      const res = await request(server, {
        path: '/v1/models',
        method: 'GET',
        headers: { Authorization: `Bearer ${createdKey.key}` },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.object, 'list');
      console.log('✓ Test 6 Passed: Client call to /v1/models succeeds with valid API key');
    }

    // 7. Update API key (Rename and Disable)
    {
      const res = await request(server, {
        path: `/api/keys/${createdKey.id}`,
        method: 'PUT',
        headers: { 'X-Dashboard-Token': sessionToken },
      }, { name: 'Cursor Extension (Renamed)', active: false });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.key.name, 'Cursor Extension (Renamed)');
      assert.strictEqual(res.json.key.active, false);
      console.log('✓ Test 7 Passed: Successfully renamed and disabled API key');
    }

    // 8. Disabled API key is rejected on /v1/models
    {
      const res = await request(server, {
        path: '/v1/models',
        method: 'GET',
        headers: { Authorization: `Bearer ${createdKey.key}` },
      });
      assert.strictEqual(res.status, 401, 'Disabled key must be rejected');
      console.log('✓ Test 8 Passed: Disabled key correctly rejected');
    }

    // 9. Re-enable API key
    {
      const res = await request(server, {
        path: `/api/keys/${createdKey.id}`,
        method: 'PUT',
        headers: { 'X-Dashboard-Token': sessionToken },
      }, { active: true });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.key.active, true);
      console.log('✓ Test 9 Passed: Successfully re-enabled API key');
    }

    // 10. Delete API key
    {
      const res = await request(server, {
        path: `/api/keys/${createdKey.id}`,
        method: 'DELETE',
        headers: { 'X-Dashboard-Token': sessionToken },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.success, true);
      assert.strictEqual(res.json.removedId, createdKey.id);

      const listRes = await request(server, {
        path: '/api/keys',
        method: 'GET',
        headers: { 'X-Dashboard-Token': sessionToken },
      });
      const found = listRes.json.keys.find(k => k.id === createdKey.id);
      assert.strictEqual(found, undefined, 'Deleted key must no longer exist');
      console.log('✓ Test 10 Passed: Successfully deleted API key');
    }

    console.log('\n=====================================================');
    console.log('     ALL 10 API KEY TESTS PASSED SUCCESSFULLY!       ');
    console.log('=====================================================\n');
  } finally {
    server.close();
    // Restore original api_keys.json or clean up
    if (originalKeysBackup !== null) {
      fs.writeFileSync(API_KEYS_FILE, originalKeysBackup, 'utf-8');
    } else if (fs.existsSync(API_KEYS_FILE)) {
      fs.unlinkSync(API_KEYS_FILE);
    }
  }
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
