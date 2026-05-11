// Bundles the lean embed for CDN distribution (IIFE, minified, single file)
// and ESM consumers (npm imports). The CDN path is the canonical drop-in
// surface — `<script src=".../embed.js" data-recipient data-amount>` reads
// its own dataset and renders the embed right after the tag.
//
// Size budget: ~5 KB gzipped. The build prints the gzipped size so the
// budget is visible at every build, not just CI.

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const outdir = resolve(root, 'dist');
mkdirSync(outdir, { recursive: true });

const banner = {
  js: `/*! @zettapay/embed v${pkg.version} | MIT | https://zettapay.io */`,
};

const define = {
  __ZETTAPAY_EMBED_VERSION__: JSON.stringify(pkg.version),
};

const shared = {
  bundle: true,
  platform: 'browser',
  target: ['es2020', 'chrome88', 'firefox86', 'safari14', 'edge88'],
  banner,
  define,
  legalComments: 'none',
  logLevel: 'warning',
};

await build({
  ...shared,
  entryPoints: [resolve(root, 'src/index.ts')],
  format: 'iife',
  globalName: 'ZettaPayEmbed',
  minify: true,
  sourcemap: true,
  outfile: resolve(outdir, 'embed.js'),
});

await build({
  ...shared,
  entryPoints: [resolve(root, 'src/index.ts')],
  format: 'esm',
  minify: false,
  sourcemap: true,
  outfile: resolve(outdir, 'embed.esm.js'),
});

const sizeKb = (path) => (statSync(path).size / 1024).toFixed(2);
const gzipKb = (path) =>
  (gzipSync(readFileSync(path)).length / 1024).toFixed(2);

const iifePath = resolve(outdir, 'embed.js');
const esmPath = resolve(outdir, 'embed.esm.js');

console.log(`✓ embed.js     ${sizeKb(iifePath)} kb raw · ${gzipKb(iifePath)} kb gzip (IIFE, minified)`);
console.log(`✓ embed.esm.js ${sizeKb(esmPath)} kb raw (ESM)`);

const manifest = {
  name: pkg.name,
  version: pkg.version,
  files: {
    iife: 'embed.js',
    esm: 'embed.esm.js',
    types: 'index.d.ts',
  },
  cdn: {
    jsdelivr: `https://cdn.jsdelivr.net/npm/${pkg.name}@${pkg.version}/dist/embed.js`,
    unpkg: `https://unpkg.com/${pkg.name}@${pkg.version}/dist/embed.js`,
  },
};
writeFileSync(resolve(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
