import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync, spawnSync } from 'child_process';

const PLATFORM_CHROMIUM_VERSIONS = {
  'linux-x64': '146.0.7680.177.5',
  'linux-arm64': '146.0.7680.177.3',
  'darwin-arm64': '145.0.7632.109.2',
  'darwin-x64': '145.0.7632.109.2',
  'win32-x64': '146.0.7680.177.5',
};

const PLATFORM_TAGS = {
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
  'darwin-arm64': 'macos-arm64',
  'darwin-x64': 'macos-x64',
  'win32-x64': 'windows-x64',
};

export function getPlatformInfo() {
  const platform = process.platform;
  const arch = process.arch;
  const key = `${platform}-${arch}`;

  const tag = PLATFORM_TAGS[key];
  const version = PLATFORM_CHROMIUM_VERSIONS[key];
  const ext = platform === 'win32' ? '.zip' : '.tar.gz';

  if (!tag || !version) {
    throw new Error(`Unsupported platform/architecture: ${platform} ${arch}`);
  }

  const cacheDir = process.env.CLOAKBROWSER_CACHE_DIR || path.join(os.homedir(), '.cloakbrowser');
  const binaryDir = path.join(cacheDir, `chromium-${version}`);
  const binaryFile = platform === 'win32'
    ? 'chrome.exe'
    : (platform === 'darwin' ? path.join('Chromium.app', 'Contents', 'MacOS', 'Chromium') : 'chrome');
  const binaryPath = path.join(binaryDir, binaryFile);

  const archiveName = `cloakbrowser-${tag}${ext}`;
  const urls = [
    `https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v${version}/${archiveName}`,
    `https://cloakbrowser.dev/chromium-v${version}/${archiveName}`,
  ];

  return { platform, arch, tag, version, ext, cacheDir, binaryDir, binaryFile, binaryPath, archiveName, urls };
}

function hasCommand(cmd) {
  try {
    const isWin = process.platform === 'win32';
    const checkCmd = isWin ? `where ${cmd}` : `which ${cmd}`;
    execSync(checkCmd, { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

async function downloadWithCurl(urls, destPath) {
  console.log('[Downloader] Utilizing curl with auto-resume (-C -) and retry logic...');
  for (const url of urls) {
    console.log(`[Downloader] Connecting to: ${url}`);
    // -C - enables resuming interrupted downloads (crucial for 500MB archives)
    // -L follows redirects
    // --retry 10 retries on transient connection resets
    const args = [
      '-L',
      '-C', '-',
      '--retry', '10',
      '--retry-delay', '2',
      '--retry-max-time', '600',
      '-o', destPath,
      url,
    ];

    const res = spawnSync('curl', args, { stdio: 'inherit' });
    if (res.status === 0 && fs.existsSync(destPath) && fs.statSync(destPath).size > 10 * 1024 * 1024) {
      return true;
    }
    console.warn(`[Downloader] Download from ${url} exited with status ${res.status}. Trying next source...`);
  }
  return false;
}

async function downloadWithNode(urls, destPath) {
  console.log('[Downloader] curl not available; falling back to Node HTTP resume stream...');
  const https = await import('https');
  const http = await import('http');

  for (const initialUrl of urls) {
    let success = false;
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        const existingSize = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
        console.log(`[Downloader] Attempt ${attempt}/10: Requesting from byte ${existingSize}...`);

        await new Promise((resolve, reject) => {
          const makeReq = (targetUrl) => {
            const parsed = new URL(targetUrl);
            const client = parsed.protocol === 'https:' ? https : http;
            const headers = {};
            if (existingSize > 0) {
              headers['Range'] = `bytes=${existingSize}-`;
            }

            const req = client.get(targetUrl, { headers }, (res) => {
              if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                return makeReq(res.headers.location);
              }

              if (res.statusCode !== 200 && res.statusCode !== 206) {
                return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage}`));
              }

              const totalBytes = (res.statusCode === 206)
                ? existingSize + Number(res.headers['content-length'] || 0)
                : Number(res.headers['content-length'] || 0);

              const out = fs.createWriteStream(destPath, { flags: existingSize > 0 ? 'a' : 'w' });
              let currentDownloaded = existingSize;
              let lastLoggedPct = -1;

              res.on('data', (chunk) => {
                out.write(chunk);
                currentDownloaded += chunk.length;
                if (totalBytes > 0) {
                  const pct = Math.floor((currentDownloaded / totalBytes) * 100);
                  if (pct >= lastLoggedPct + 10) {
                    lastLoggedPct = pct;
                    const curMB = Math.floor(currentDownloaded / (1024 * 1024));
                    const totMB = Math.floor(totalBytes / (1024 * 1024));
                    console.log(`[Downloader] Progress: ${pct}% (${curMB}/${totMB} MB)`);
                  }
                }
              });

              res.on('end', () => {
                out.end();
                out.on('close', resolve);
              });

              res.on('error', (err) => {
                out.destroy();
                reject(err);
              });
            });

            req.on('error', reject);
          };

          makeReq(initialUrl);
        });

        if (fs.existsSync(destPath) && fs.statSync(destPath).size > 10 * 1024 * 1024) {
          success = true;
          break;
        }
      } catch (err) {
        console.warn(`[Downloader] Connection drop on attempt ${attempt}: ${err.message}. Retrying in 3s...`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    if (success) return true;
  }

  return false;
}

function extractArchive(archivePath, destDir, isZip) {
  console.log(`[Downloader] Extracting archive to ${destDir}...`);
  fs.mkdirSync(destDir, { recursive: true });

  if (isZip) {
    if (process.platform === 'win32') {
      try {
        console.log('[Downloader] Extracting via tar.exe or PowerShell...');
        if (hasCommand('tar')) {
          execSync(`tar -xf "${archivePath}" -C "${destDir}"`, { stdio: 'inherit' });
        } else {
          execSync(
            `powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`,
            { stdio: 'inherit' }
          );
        }
      } catch (err) {
        console.warn('[Downloader] PowerShell expansion warning:', err.message);
      }
    } else {
      execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: 'inherit' });
    }
  } else {
    execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: 'inherit' });
  }

  // Flatten single subdirectory if archive had a wrapping root folder
  try {
    const entries = fs.readdirSync(destDir);
    if (entries.length === 1) {
      const subdir = path.join(destDir, entries[0]);
      if (fs.statSync(subdir).isDirectory() && !entries[0].endsWith('.app')) {
        console.log(`[Downloader] Flattening subfolder: ${entries[0]}...`);
        const subFiles = fs.readdirSync(subdir);
        for (const f of subFiles) {
          fs.renameSync(path.join(subdir, f), path.join(destDir, f));
        }
        fs.rmdirSync(subdir);
      }
    }
  } catch (e) {}
}

export async function ensureCloakBrowser() {
  const info = getPlatformInfo();

  console.log('=====================================================');
  console.log('          CloakBrowser Resilient Installer           ');
  console.log('=====================================================');
  console.log(`Platform:      ${info.platform} (${info.arch})`);
  console.log(`Version:       Chromium ${info.version}`);
  console.log(`Target Dir:    ${info.binaryDir}`);
  console.log(`Executable:    ${info.binaryPath}`);
  console.log('=====================================================\n');

  if (fs.existsSync(info.binaryPath)) {
    console.log(`✓ CloakBrowser binary is already installed and ready at:\n  ${info.binaryPath}\n`);
    return info.binaryPath;
  }

  fs.mkdirSync(info.cacheDir, { recursive: true });
  const archivePath = path.join(info.cacheDir, info.archiveName);

  console.log(`[Downloader] Downloading CloakBrowser (${info.archiveName}, ~535 MB)...`);
  console.log('[Downloader] Supports automatic HTTP Range resume if connection drops.\n');

  let downloaded = false;
  if (hasCommand('curl')) {
    downloaded = await downloadWithCurl(info.urls, archivePath);
  } else {
    downloaded = await downloadWithNode(info.urls, archivePath);
  }

  if (!downloaded || !fs.existsSync(archivePath) || fs.statSync(archivePath).size < 10 * 1024 * 1024) {
    throw new Error(
      `Failed to download CloakBrowser archive from all mirrors.\n` +
      `Manual download option:\n` +
      `1. Download: ${info.urls[0]}\n` +
      `2. Extract into: ${info.binaryDir}\n` +
      `3. Ensure ${info.binaryFile} is inside ${info.binaryDir}\n`
    );
  }

  extractArchive(archivePath, info.binaryDir, info.ext === '.zip');

  if (process.platform !== 'win32' && fs.existsSync(info.binaryPath)) {
    try {
      fs.chmodSync(info.binaryPath, 0o755);
    } catch (e) {}
  }

  if (fs.existsSync(info.binaryPath)) {
    console.log('\n=====================================================');
    console.log('   ✓ CloakBrowser installed successfully!            ');
    console.log(`   Path: ${info.binaryPath}`);
    console.log('=====================================================\n');

    // Clean up archive to save disk space
    try {
      fs.unlinkSync(archivePath);
    } catch (e) {}

    return info.binaryPath;
  } else {
    throw new Error(
      `Extraction completed but executable was not found at expected path: ${info.binaryPath}\n` +
      `Please check ${info.binaryDir}`
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureCloakBrowser().catch((err) => {
    console.error('\n[Error]', err.message);
    process.exit(1);
  });
}
