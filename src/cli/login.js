import { Camoufox } from 'camoufox-js';
import readline from 'readline';
import { config } from '../config.js';

async function runLogin() {
  console.log('=====================================================');
  console.log('   Z.ai Interactive Login Helper (Camoufox)');
  console.log('=====================================================');
  console.log(`Profile directory: ${config.userDataDir}`);
  console.log('\nLaunching headful Camoufox browser so you can log in to Z.ai...');

  const browser = await Camoufox({
    headless: false,
    user_data_dir: config.userDataDir,
  });

  const pages = typeof browser.pages === 'function' ? browser.pages() : [];
  const page = pages[0] || (await browser.newPage());

  await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded' });

  console.log('\n>>> Please log in via the browser window if you wish to link an account.');
  console.log('>>> When finished logging in, press ENTER here in the terminal to save and exit.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question('Press ENTER when done logging in...', resolve));
  rl.close();

  console.log('\nSaving profile and closing browser...');
  await browser.close();
  console.log('Done! Session saved in:', config.userDataDir);
}

runLogin().catch(err => {
  console.error('Login script failed:', err);
  process.exit(1);
});
