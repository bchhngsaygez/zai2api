import http from 'http';
import { config } from './config.js';
import { createApp } from './server/app.js';
import { browserController } from './browser/browserController.js';

async function startServer() {
  console.log('=====================================================');
  console.log('                 zai2api Proxy Server');
  console.log('=====================================================');
  console.log(`Port:           ${config.port}`);
  console.log(`Host:           ${config.host}`);
  console.log(`Default Model:  ${config.defaultModel}`);
  console.log(`Engine:         Camoufox (Gecko stealth)`);
  console.log(`Profile Dir:    ${config.userDataDir}`);
  console.log(`Headless:       ${config.headless}`);
  console.log('=====================================================\n');

  // Pre-flight check: see if zai2api is already running on this port
  try {
    const isAlreadyRunning = await new Promise(resolve => {
      const tester = http.get(`http://${config.host}:${config.port}/health`, { timeout: 1000 }, (res) => {
        resolve(res.statusCode === 200);
      });
      tester.on('error', () => resolve(false));
      tester.on('timeout', () => { tester.destroy(); resolve(false); });
    });

    if (isAlreadyRunning) {
      console.log(`\n⚠️  zai2api is ALREADY running and healthy at http://${config.host}:${config.port}`);
      console.log('You do not need to start it again — your API is already active.');
      console.log('To restart, stop the existing process first:');
      console.log('  pkill -f "node src/index.js" && npm start\n');
      process.exit(0);
    }
  } catch (e) {}

  // 1. Initialize Browser Controller
  console.log('[Init] Launching in-browser stealth controller...');
  try {
    await browserController.initialize();
  } catch (err) {
    console.error('[Init Error] Failed to start browser:', err.message);
    process.exit(1);
  }

  // 2. Start Express API Server
  const app = createApp();
  const server = http.createServer(app);

  server.listen(config.port, config.host, () => {
    console.log(`\n>>> Proxy server running at http://${config.host}:${config.port}`);
    console.log('>>> Available endpoints:');
    console.log(`    GET  http://${config.host}:${config.port}/v1/models`);
    console.log(`    POST http://${config.host}:${config.port}/v1/chat/completions (OpenAI Compatible)`);
    console.log(`    POST http://${config.host}:${config.port}/v1/subagent/task     (Multi-file Subagents)`);
    console.log(`    GET  http://${config.host}:${config.port}/v1/queue/status     (FIFO Queue Status)`);
    console.log(`    GET  http://${config.host}:${config.port}/health\n`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[Shutdown] Stopping proxy server and browser...');
    server.close();
    await browserController.close();
    console.log('[Shutdown] Completed. Bye!');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startServer().catch(err => {
  console.error('[Fatal] Server crash:', err);
  process.exit(1);
});
