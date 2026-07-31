import { build } from 'esbuild';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = resolve(root, 'dist');
const minify = !process.argv.includes('--dev');

mkdirSync(resolve(dist, 'main'), { recursive: true });
mkdirSync(resolve(dist, 'preload'), { recursive: true });
mkdirSync(resolve(dist, 'renderer'), { recursive: true });

const shared = {
  bundle: true,
  minify,
  legalComments: 'none',
};

async function main() {
  await build({
    ...shared,
    entryPoints: [resolve(root, 'src/main/index.ts')],
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: resolve(dist, 'main/index.js'),
    external: ['electron', 'chokidar', 'electron-store'],
  });

  await build({
    ...shared,
    entryPoints: [resolve(root, 'src/preload/index.ts')],
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: resolve(dist, 'preload/index.js'),
    external: ['electron'],
  });

  await build({
    ...shared,
    entryPoints: [resolve(root, 'src/renderer/main.ts')],
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    outfile: resolve(dist, 'renderer/main.js'),
  });

  copyFileSync(resolve(root, 'src/renderer/index.html'), resolve(dist, 'renderer/index.html'));
  copyFileSync(resolve(root, 'src/renderer/styles.css'), resolve(dist, 'renderer/styles.css'));

  const worker = ['pdf.worker.min.mjs', 'pdf.worker.min.js']
    .map(f => resolve(root, 'node_modules/pdfjs-dist/build', f))
    .find(p => existsSync(p));
  if (worker) copyFileSync(worker, resolve(dist, 'renderer/pdf.worker.min.js'));
  else console.warn('⚠ pdf worker not found');

  if (!existsSync(resolve(root, 'assets/icon.ico'))) {
    console.warn('⚠ No icon.ico in assets/');
  }

  console.log(`✅ Build ${minify ? '(minified)' : '(dev)'}`);
}

main().catch(err => { console.error(err); process.exit(1); });
