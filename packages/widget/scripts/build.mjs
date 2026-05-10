// Bundles the embed widget for both CDN distribution (IIFE, minified, single
// file) and ESM consumers (npm imports). The CDN path is the canonical drop-in
// surface — `<script src="https://cdn.jsdelivr.net/npm/@zettapay/widget/dist/widget.js" data-merchant data-amount>`
// auto-discovers itself, reads its own dataset, and renders a Pay button right
// after the script tag.
//
// Why a single bundled file: merchants integrating ZettaPay copy/paste exactly
// one tag. Multiple chunks would either need a manifest or break offline-first
// integrations (WordPress, Shopify snippet, static sites).

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const outdir = resolve(root, 'dist');
mkdirSync(outdir, { recursive: true });

const banner = {
  js: `/*! @zettapay/widget v${pkg.version} | MIT | https://zettapay.io */`,
};

const define = {
  __ZETTAPAY_WIDGET_VERSION__: JSON.stringify(pkg.version),
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
  globalName: 'ZettaPay',
  minify: true,
  sourcemap: true,
  outfile: resolve(outdir, 'widget.js'),
});

await build({
  ...shared,
  entryPoints: [resolve(root, 'src/index.ts')],
  format: 'esm',
  minify: false,
  sourcemap: true,
  outfile: resolve(outdir, 'widget.esm.js'),
});

const sizeKb = (path) => (statSync(path).size / 1024).toFixed(1);
console.log(`✓ widget.js     ${sizeKb(resolve(outdir, 'widget.js'))} kb (IIFE, minified)`);
console.log(`✓ widget.esm.js ${sizeKb(resolve(outdir, 'widget.esm.js'))} kb (ESM)`);

// Emit a static manifest so jsdelivr / unpkg consumers can integrity-pin a
// known release without parsing package.json themselves.
const manifest = {
  name: pkg.name,
  version: pkg.version,
  files: {
    iife: 'widget.js',
    esm: 'widget.esm.js',
    types: 'index.d.ts',
  },
  cdn: {
    jsdelivr: `https://cdn.jsdelivr.net/npm/${pkg.name}@${pkg.version}/dist/widget.js`,
    unpkg: `https://unpkg.com/${pkg.name}@${pkg.version}/dist/widget.js`,
  },
};
writeFileSync(resolve(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
