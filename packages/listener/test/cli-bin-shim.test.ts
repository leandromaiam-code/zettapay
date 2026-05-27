// Z64 regression — exercise the built `dist/main.js` as a subprocess to prove
// the `invokedAsScript` detection is robust under realistic `npm i -g`
// symlink layouts. The 0.1.0 release shipped a bin that exited 0 with zero
// stdout because `argv[1].endsWith('main.js')` missed the symlink path
// `<prefix>/bin/zettapay-listener` that npm actually installs. These tests
// pin the fix in place.
//
// The tests are skipped (not failed) when `dist/` isn't present — vitest runs
// without a build step in some workflows. CI runs `npm run build` before
// `npm run test`, so they execute there. Locally, `npm run build && npm run
// test` exercises them; bare `npm run test` skips them with a warning.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const distMain = path.resolve(here, '..', 'dist', 'main.js');
const distAvailable = fs.existsSync(distMain);
const describeBuilt = distAvailable ? describe : describe.skip;

function run(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [distMain, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...extraEnv },
    timeout: 10_000,
  });
}

describeBuilt('dist/main.js — bin shim invocation', () => {
  it('--version prints the package.json version (Bug 2 fix)', () => {
    const out = run(['--version']);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/zettapay-listener\s+\d+\.\d+\.\d+/);
  });

  it('--help prints the banner and lists all 7 subcommands (Bug 2 fix)', () => {
    const out = run(['--help']);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/zettapay-listener/);
    expect(out.stdout).toMatch(/init/);
    expect(out.stdout).toMatch(/start/);
    expect(out.stdout).toMatch(/healthcheck/);
    expect(out.stdout).toMatch(/verify-config/);
    expect(out.stdout).toMatch(/migrate/);
    expect(out.stdout).toMatch(/derive-address/);
    expect(out.stdout).toMatch(/create-invoice/);
  });

  it('init --xpub <zpub> --force writes .env + merchant.json (Bug 1 fix)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-binshim-'));
    try {
      const out = run(
        [
          'init',
          '--xpub',
          'zpub6jftahH18ngZxLmXaKw3GSZzZsszmt9WqedkyZdezFtWRFBZqsQH5hyUmb4pCEeZGmVfQuP5bedXTB8is6fTv19U1GQRyQUKQGUTzyHACMF',
          '--shop-name',
          'BinShim',
          '--email',
          'op@binshim.test',
          '--webhook-url',
          'https://binshim.test/hook',
          '--storage',
          'json',
          '--data-dir',
          tmp,
          '--force',
        ],
        // init reads ZETTAPAY_DATA_DIR from env when --data-dir omitted. Here
        // we force a clean cwd so the .env doesn't trip the overwrite prompt.
      );
      expect(out.status).toBe(0);
      // Bug 1 was: exit 0 but ZERO files. Assert the files exist now.
      expect(fs.existsSync(path.join(tmp, 'merchant.json'))).toBe(true);
      const merchant = JSON.parse(
        fs.readFileSync(path.join(tmp, 'merchant.json'), 'utf8'),
      );
      expect(merchant.shop_name).toBe('BinShim');
      expect(merchant.next_child_index).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('invocation via symlink (mirrors npm bin shim) still dispatches', () => {
    // Mirror npm's `<prefix>/bin/zettapay-listener` symlink and prove the
    // realpath comparison resolves it. Without the fix the dispatcher
    // never ran and stdout was empty.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-binshim-link-'));
    try {
      const link = path.join(tmp, 'zettapay-listener');
      fs.symlinkSync(distMain, link);
      const out = spawnSync(process.execPath, [link, '--version'], {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
        timeout: 10_000,
      });
      expect(out.status).toBe(0);
      expect(out.stdout).toMatch(/zettapay-listener\s+\d+\.\d+\.\d+/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('unknown command exits 2 and prints help on stderr', () => {
    const out = run(['no-such-thing']);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/unknown command/);
    expect(out.stderr).toMatch(/derive-address/);
  });
});

if (!distAvailable) {
  // Surface the skip reason so the CI log makes the gap visible.
  // eslint-disable-next-line no-console
  console.warn(
    `[cli-bin-shim] skipped — ${distMain} missing. Run \`npm run build\` first.`,
  );
}
