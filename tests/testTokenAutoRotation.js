import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { browserController } from '../src/browser/browserController.js';
import { tokensManager } from '../src/server/tokensManager.js';
import { statsTracker } from '../src/server/statsTracker.js';

console.log('=====================================================');
console.log('      Testing Automatic Token Rotation on Quota      ');
console.log('=====================================================\n');

async function runTests() {
  // Backup original tokens
  const originalTokens = JSON.parse(JSON.stringify(tokensManager.tokens));
  const initialRotations = statsTracker.getStats().rotationsCount;

  try {
    // ----------------------------------------------------
    // Test 1: Quota & Error Heuristics Detection
    // ----------------------------------------------------
    console.log('1. Testing quota error detection heuristics...');
    const quotaSamples = [
      'Z.ai quota exceeded: daily limit reached',
      'Rate limit: too many requests (429)',
      'RATE_LIMIT_HTTP_429',
      'QUOTA_OR_AUTH_HTTP_402 - HTTP_402: payment required',
      'QUOTA_OR_AUTH_HTTP_401 - Unauthorized',
      'QUOTA_OR_AUTH_HTTP_403 - Forbidden',
      'QUOTA_OR_API_JSON_ERROR: usage limit reached',
      '当前账号额度已用完，请升级',
      '今日提问次数已用尽',
      '请求过于频繁，请稍后再试',
      'Modal dialog blocking chat: upgrade to continue to Pro',
      'Chat input is disabled / locked',
      'account restricted due to abnormal traffic',
      'Token expired, please log in again',
      'Hạn mức sử dụng đã hết hạn',
    ];

    for (const sample of quotaSamples) {
      const detected = browserController.isQuotaOrRateLimitError(sample);
      assert.strictEqual(detected, true, `Should detect quota/rate-limit in: "${sample}"`);
    }

    const safeSamples = [
      'Write a python script to parse CSV files',
      'What is the speed of light in vacuum?',
      'Create an SVG animation of a glowing star',
      'Explain how quicksort works with time complexity',
    ];

    for (const sample of safeSamples) {
      const detected = browserController.isQuotaOrRateLimitError(sample);
      assert.strictEqual(detected, false, `Should NOT falsely detect quota in safe text: "${sample}"`);
    }
    console.log('✓ Test 1 Passed: Quota & rate-limit heuristics accurately detected across English, Chinese, and HTTP codes.\n');

    // ----------------------------------------------------
    // Test 2: TokensManager Multiple Tokens Check & Cooldown
    // ----------------------------------------------------
    console.log('2. Testing token cooldown and availability tracking...');
    tokensManager.tokens = [
      { id: 'tok_test_1', label: 'Token 1', token: 'jwt_mock_token_alpha_1111111111', active: true, createdAt: new Date().toISOString() },
      { id: 'tok_test_2', label: 'Token 2', token: 'jwt_mock_token_beta_2222222222', active: false, createdAt: new Date().toISOString() },
      { id: 'tok_test_3', label: 'Token 3', token: 'jwt_mock_token_gamma_3333333333', active: false, createdAt: new Date().toISOString() },
    ];
    tokensManager.saveToFile();

    assert.strictEqual(tokensManager.hasMultipleTokens(), true, 'Should report having multiple tokens');
    assert.strictEqual(tokensManager.getAvailableTokensCount(), 3, 'All 3 tokens should be available initially');

    // Mark Token 1 as rate limited (10 minutes)
    tokensManager.markTokenRateLimited('tok_test_1', 10 * 60 * 1000);
    const tokensView = tokensManager.getTokens();
    const tok1 = tokensView.find(t => t.id === 'tok_test_1');
    assert.strictEqual(tok1.isRateLimited, true, 'Token 1 should be marked as rate-limited');
    assert.ok(tok1.cooldownRemainingSec > 0, 'Cooldown remaining seconds should be > 0');
    assert.strictEqual(tokensManager.getAvailableTokensCount(), 2, 'Available count should be 2 after 1 token limited');

    console.log('✓ Test 2 Passed: Token cooldown and remaining time correctly tracked.\n');

    // ----------------------------------------------------
    // Test 3: Cyclical Rotation Skipping Cooldown Tokens
    // ----------------------------------------------------
    console.log('3. Testing cyclical rotation skipping rate-limited tokens...');
    // Token 1 is active but rate limited. Rotate should switch to Token 2
    const rot1 = await tokensManager.rotateToNextToken('quota_test');
    assert.strictEqual(rot1.rotated, true);
    assert.strictEqual(rot1.token.id, 'tok_test_2');
    assert.strictEqual(tokensManager.getActiveTokenObject().id, 'tok_test_2');

    // Now mark Token 3 as rate-limited as well, so only Token 2 is non-limited
    tokensManager.markTokenRateLimited('tok_test_3', 10 * 60 * 1000);

    // Now rotate again using rotateOnQuotaExceeded from Token 2
    // Token 2 gets marked limited, all 3 are limited, so fallback picks earliest expiring
    const rot2 = await tokensManager.rotateOnQuotaExceeded('quota_exhausted_test', 30 * 60 * 1000);
    assert.strictEqual(rot2.rotated, true);
    assert.ok(rot2.token.id, 'Should still rotate safely even when tokens have cooldowns');

    console.log('✓ Test 3 Passed: Cyclical rotation correctly skips cooldown tokens and rotates smoothly.\n');

    // ----------------------------------------------------
    // Test 4: Stats Recording on Rotation
    // ----------------------------------------------------
    console.log('4. Testing rotation stats tracking...');
    const updatedRotations = statsTracker.getStats().rotationsCount;
    assert.ok(updatedRotations > initialRotations, `Rotations count should increase (was ${initialRotations}, now ${updatedRotations})`);
    console.log(`✓ Test 4 Passed: Stats tracker recorded rotation events (Total rotations: ${updatedRotations}).\n`);

    // ----------------------------------------------------
    // Test 5: Simulated Transparent Auto-Rotate Failover Loop
    // ----------------------------------------------------
    console.log('5. Testing transparent multi-token retry simulation...');
    let attempts = 0;
    const executionTrace = [];

    // Mock runner simulating sendMessage's handleAutoRotateAndRetry logic
    async function simulateRunner(rotationAttempt = 0) {
      attempts++;
      const current = tokensManager.getActiveTokenObject();
      executionTrace.push({ attempt: rotationAttempt, token: current.label });

      // First attempt on Token 1 hits quota
      if (rotationAttempt === 0) {
        // Auto-rotation triggered
        const canRotate = tokensManager.hasMultipleTokens();
        if (canRotate && rotationAttempt < tokensManager.tokens.length) {
          tokensManager.markTokenRateLimited(current.id, 30 * 60 * 1000);
          const rotResult = await tokensManager.rotateToNextToken('simulated_quota_exceeded');
          if (rotResult.rotated) {
            return await simulateRunner(rotationAttempt + 1);
          }
        }
        throw new Error('Quota exceeded without rotation');
      }

      // Second attempt on Token 2 succeeds
      return { success: true, answeredBy: current.label, content: 'Seamless AI response completed!' };
    }

    tokensManager.clearRateLimits();
    await tokensManager.activateToken('tok_test_1');

    const result = await simulateRunner(0);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.answeredBy, 'Token 2', 'Request should be seamlessly completed by Token 2');
    assert.strictEqual(executionTrace.length, 2, 'Should have made 2 attempts');
    assert.strictEqual(executionTrace[0].token, 'Token 1');
    assert.strictEqual(executionTrace[1].token, 'Token 2');

    console.log('✓ Test 5 Passed: Transparent failover simulation successfully switched tokens and resolved response.\n');

    console.log('=====================================================');
    console.log('   ALL 5 AUTO-ROTATION TESTS PASSED SUCCESSFULLY!    ');
    console.log('=====================================================\n');
  } finally {
    // Restore original tokens
    tokensManager.tokens = originalTokens;
    tokensManager.saveToFile();
  }
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
