/**
 * Download and extract TinyTeX for local development.
 * Usage: node scripts/setup-tex.mjs
 */
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const texDir = resolve(root, 'texlive');
const tinytexDir = join(texDir, 'TinyTeX');
const xelatex = join(tinytexDir, 'bin', 'windows', 'xelatex.exe');

// Windows 7za (already a devDependency via 7zip-bin)
const sevenZip = resolve(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

const API = 'https://api.github.com/repos/rstudio/tinytex-releases/releases/latest';

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'livelatex-setup' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function download(url, outPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(outPath);
    https.get(url, { headers: { 'User-Agent': 'livelatex-setup' } }, (res) => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (e) => { rmSync(outPath, { force: true }); reject(e); });
  });
}

async function main() {
  console.log('Checking for existing TinyTeX...');
  if (existsSync(xelatex)) {
    console.log('  Already installed:', xelatex);
    console.log('  Done.');
    return;
  }

  console.log('Fetching latest TinyTeX release info...');
  const release = await httpGetJson(API);
  const asset = (release.assets || []).find((a) => /^TinyTeX-1-windows-.+\.exe$/.test(a.name));
  if (!asset) throw new Error('TinyTeX-1 windows asset not found');

  const exePath = resolve(root, 'tinytex-setup.exe');
  console.log(`Downloading ${asset.name} (${(asset.size / 1048576).toFixed(1)} MB)...`);
  await download(asset.browser_download_url, exePath);

  console.log('Extracting...');
  mkdirSync(texDir, { recursive: true });
  if (existsSync(tinytexDir)) rmSync(tinytexDir, { recursive: true, force: true });
  execFileSync(sevenZip, ['x', exePath, `-o${texDir}`, '-y'], { stdio: 'inherit' });
  rmSync(exePath, { force: true });

  if (existsSync(xelatex)) {
    console.log('  TinyTeX extracted OK');
    console.log('  xelatex:', xelatex);
  } else {
    throw new Error('Extraction failed: xelatex.exe not found');
  }

  console.log('\nDone. Run `npm run dev` to start the editor.');
}

main().catch((e) => {
  console.error('setup failed:', e.message);
  process.exit(1);
});
