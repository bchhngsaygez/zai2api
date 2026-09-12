import { browserController } from '../src/browser/browserController.js';

(async () => {
  try {
    console.log('[Test] Initializing browserController...');
    await browserController.initialize();

    console.log('[Test] Browser initialized. Preparing to send message...');
    let fullContent = '';
    let fullReasoning = '';

    await browserController.sendMessage({
      prompt: 'Say "CloakBrowser Live Test OK" in exactly 4 words.',
      model: 'glm-5.3-flash',
      thinkingMode: 'max',
      onDelta: (chunk) => {
        process.stdout.write(chunk);
        fullContent += chunk;
      },
      onReasoning: (chunk) => {
        fullReasoning += chunk;
      },
      onDone: async ({ answer, reasoning, usage }) => {
        console.log('\n[Test] onDone fired!');
        console.log('[Test] Answer:', answer || fullContent);
        console.log('[Test] Reasoning length:', (reasoning || fullReasoning).length);
        console.log('[Test] Usage:', usage);
        await browserController.close();
        process.exit(0);
      },
      onError: async (err) => {
        console.error('\n[Test] onError fired:', err);
        await browserController.close();
        process.exit(1);
      }
    });
  } catch (err) {
    console.error('[Test] Exception:', err);
    await browserController.close();
    process.exit(1);
  }
})();
