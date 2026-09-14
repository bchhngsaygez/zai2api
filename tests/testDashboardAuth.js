import assert from 'assert';
import http from 'http';
import { createApp } from '../src/server/app.js';
import { authManager } from '../src/server/authManager.js';
import { config } from '../src/config.js';

console.log('=====================================================');
console.log('      Testing Dashboard Password Authentication      ');
console.log('=====================================================\n');

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
  const app = createApp();
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`[Test Server] Listening on port ${port}\n`);

  try {
    const initialPassword = authManager.getPassword();

    // 1. Initial auth status
    {
      const res = await request(server, { path: '/api/auth/status', method: 'GET' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.authenticated, false, 'Should not be authenticated initially');
      console.log('✓ Test 1 Passed: Initial auth status returns unauthenticated');
    }

    // 2. Protected route rejected without token
    {
      const resStats = await request(server, { path: '/api/stats', method: 'GET' });
      assert.strictEqual(resStats.status, 401, 'Protected /api/stats must return 401 without auth');
      const resTokens = await request(server, { path: '/api/tokens', method: 'GET' });
      assert.strictEqual(resTokens.status, 401, 'Protected /api/tokens must return 401 without auth');
      console.log('✓ Test 2 Passed: Protected dashboard routes (/api/stats, /api/tokens) reject unauthenticated requests');
    }

    // 3. Login with wrong password
    {
      const res = await request(server, { path: '/api/auth/login', method: 'POST' }, { password: 'wrongPassword_not_matching_123!' });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.json.success, false);
      console.log('✓ Test 3 Passed: Login with incorrect password returns 401');
    }

    // 4. Login with configured password
    let sessionToken = '';
    {
      const res = await request(server, { path: '/api/auth/login', method: 'POST' }, { password: initialPassword });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.success, true);
      assert.ok(res.json.token, 'Should receive session token');
      sessionToken = res.json.token;
      console.log('✓ Test 4 Passed: Login with configured password succeeds and returns session token');
    }

    // 5. Auth status with token in header
    {
      const res = await request(server, {
        path: '/api/auth/status',
        method: 'GET',
        headers: { 'X-Dashboard-Token': sessionToken },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.authenticated, true);
      console.log('✓ Test 5 Passed: Auth status returns authenticated=true with valid session token');
    }

    // 6. Access protected routes with X-Dashboard-Token and Bearer authorization
    {
      const resStats = await request(server, {
        path: '/api/stats',
        method: 'GET',
        headers: { 'X-Dashboard-Token': sessionToken },
      });
      assert.strictEqual(resStats.status, 200);
      assert.strictEqual(resStats.json.success, true);

      const resTokens = await request(server, {
        path: '/api/tokens',
        method: 'GET',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      assert.strictEqual(resTokens.status, 200);
      assert.strictEqual(resTokens.json.success, true);
      console.log('✓ Test 6 Passed: Protected routes accessible with session token (via X-Dashboard-Token or Bearer)');
    }

    // 7. Change password
    let updatedToken = '';
    const tempPassword = 'newSecretPass123_temp!';
    {
      // A. Wrong current password fails
      const failRes = await request(server, {
        path: '/api/auth/change-password',
        method: 'POST',
        headers: { 'X-Dashboard-Token': sessionToken },
      }, { currentPassword: 'notTheCurrentPassword', newPassword: tempPassword });
      assert.strictEqual(failRes.status, 401);

      // B. Correct current password succeeds
      const okRes = await request(server, {
        path: '/api/auth/change-password',
        method: 'POST',
        headers: { 'X-Dashboard-Token': sessionToken },
      }, { currentPassword: initialPassword, newPassword: tempPassword });
      assert.strictEqual(okRes.status, 200);
      assert.strictEqual(okRes.json.success, true);
      assert.ok(okRes.json.token);
      updatedToken = okRes.json.token;
      console.log('✓ Test 7 Passed: Change password validates current password and returns new session token');
    }

    // 8. Verify old password fails and new password works
    {
      const oldLogin = await request(server, { path: '/api/auth/login', method: 'POST' }, { password: initialPassword });
      assert.strictEqual(oldLogin.status, 401, 'Old password should now be invalid');

      const newLogin = await request(server, { path: '/api/auth/login', method: 'POST' }, { password: tempPassword });
      assert.strictEqual(newLogin.status, 200, 'New password should succeed');
      console.log('✓ Test 8 Passed: Old password rejected, new password verified');
    }

    // 9. Restore password to initial password for clean environment
    {
      const restoreRes = await request(server, {
        path: '/api/auth/change-password',
        method: 'POST',
        headers: { 'X-Dashboard-Token': updatedToken },
      }, { currentPassword: tempPassword, newPassword: initialPassword });
      assert.strictEqual(restoreRes.status, 200);
      assert.strictEqual(authManager.getPassword(), initialPassword);
      console.log('✓ Test 9 Passed: Password safely restored to initial configured password');
    }

    // 10. Logout invalidates session
    {
      const loginRes = await request(server, { path: '/api/auth/login', method: 'POST' }, { password: initialPassword });
      const testToken = loginRes.json.token;

      const logoutRes = await request(server, {
        path: '/api/auth/logout',
        method: 'POST',
        headers: { 'X-Dashboard-Token': testToken },
      });
      assert.strictEqual(logoutRes.status, 200);

      const checkRes = await request(server, {
        path: '/api/stats',
        method: 'GET',
        headers: { 'X-Dashboard-Token': testToken },
      });
      assert.strictEqual(checkRes.status, 401, 'Revoked session must be rejected');
      console.log('✓ Test 10 Passed: Logout revokes session token');
    }

    // 11. OpenAI endpoints remain open
    {
      const modelsRes = await request(server, { path: '/v1/models', method: 'GET' });
      assert.strictEqual(modelsRes.status, 200, 'OpenAI /v1/models must remain open for coding agents');
      console.log('✓ Test 11 Passed: OpenAI /v1/models remains open without dashboard auth');
    }

    console.log('\n=====================================================');
    console.log('   ALL 11 AUTHENTICATION TESTS PASSED SUCCESSFULLY!   ');
    console.log('=====================================================\n');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
