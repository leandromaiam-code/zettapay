import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WALLETS,
  buildSolanaPayUri,
  buildWalletDeeplink,
  detectWallets,
  getWalletMeta,
  isMobile,
  mount,
} from '../src/index.js';

const RECIPIENT = '7vYAYP6sH5DEKpzCRYAYn5dShGE1LdgqHCT9KuExJgWY';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

describe('isMobile', () => {
  it('flags common mobile user agents', () => {
    expect(isMobile('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15')).toBe(true);
    expect(isMobile('Mozilla/5.0 (Linux; Android 13; Pixel 7)')).toBe(true);
    expect(isMobile('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe(true);
  });

  it('returns false for typical desktop user agents', () => {
    expect(isMobile('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')).toBe(false);
    expect(isMobile('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120')).toBe(false);
  });

  it('returns false when no UA is available', () => {
    expect(isMobile('')).toBe(false);
  });
});

describe('detectWallets', () => {
  it('returns an empty list when no providers are injected', () => {
    const result = detectWallets({ navigator: { userAgent: 'desktop' } });
    expect(result.installed).toEqual([]);
    expect(result.isMobile).toBe(false);
  });

  it('detects Phantom via window.phantom.solana.isPhantom', () => {
    const result = detectWallets({ phantom: { solana: { isPhantom: true } } });
    expect(result.installed).toEqual(['phantom']);
  });

  it('detects Phantom via legacy window.solana.isPhantom', () => {
    const result = detectWallets({ solana: { isPhantom: true } });
    expect(result.installed).toEqual(['phantom']);
  });

  it('detects Solflare via window.solflare.isSolflare', () => {
    const result = detectWallets({ solflare: { isSolflare: true } });
    expect(result.installed).toEqual(['solflare']);
  });

  it('detects Backpack via window.backpack.isBackpack', () => {
    const result = detectWallets({ backpack: { isBackpack: true } });
    expect(result.installed).toEqual(['backpack']);
  });

  it('detects Backpack via window.xnft', () => {
    const result = detectWallets({ xnft: {} });
    expect(result.installed).toEqual(['backpack']);
  });

  it('detects Glow via window.glow', () => {
    const result = detectWallets({ glow: {} });
    expect(result.installed).toEqual(['glow']);
  });

  it('detects Trust via the Solana sub-provider', () => {
    const result = detectWallets({ trustwallet: { solana: {} } });
    expect(result.installed).toEqual(['trust']);
  });

  it('detects Coinbase Wallet via window.coinbaseSolana', () => {
    const result = detectWallets({ coinbaseSolana: {} });
    expect(result.installed).toEqual(['coinbase']);
  });

  it('detects multiple wallets at once and preserves declared order', () => {
    const result = detectWallets({
      coinbaseSolana: {},
      phantom: { solana: { isPhantom: true } },
      solflare: { isSolflare: true },
    });
    expect(result.installed).toEqual(['phantom', 'solflare', 'coinbase']);
  });

  it('flags mobile from the supplied navigator', () => {
    const result = detectWallets({
      navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' },
    });
    expect(result.isMobile).toBe(true);
  });

  it('never invokes a method on the injected provider', () => {
    // If `detectWallets` ever upgrades to `connect()`-style probing this test
    // catches it — the rule is read-only inspection only.
    const calls: string[] = [];
    const trap = new Proxy(
      {},
      {
        get(target, prop) {
          calls.push(String(prop));
          if (prop === 'isPhantom') return true;
          return undefined;
        },
      },
    );
    detectWallets({ phantom: { solana: trap as never } });
    expect(calls).toContain('isPhantom');
    expect(calls).not.toContain('connect');
    expect(calls).not.toContain('signMessage');
    expect(calls).not.toContain('request');
  });
});

describe('buildWalletDeeplink', () => {
  const payUri = buildSolanaPayUri({ recipient: RECIPIENT, amount: '10.5', mint: USDC });

  it('wraps the URI in a Phantom universal link', () => {
    const link = buildWalletDeeplink('phantom', payUri);
    expect(link.startsWith('https://phantom.app/ul/browse/')).toBe(true);
    expect(decodeURIComponent(link)).toContain(payUri);
  });

  it('appends ref when a dapp URL is provided', () => {
    const link = buildWalletDeeplink('phantom', payUri, { dappUrl: 'https://merchant.example' });
    expect(link).toContain('?ref=https%3A%2F%2Fmerchant.example');
  });

  it('wraps the URI in a Solflare universal link', () => {
    const link = buildWalletDeeplink('solflare', payUri);
    expect(link.startsWith('https://solflare.com/ul/v1/browse/')).toBe(true);
  });

  it('routes Backpack/Glow/Trust through the solana: URI', () => {
    expect(buildWalletDeeplink('backpack', payUri)).toBe(payUri);
    expect(buildWalletDeeplink('glow', payUri)).toBe(payUri);
    expect(buildWalletDeeplink('trust', payUri)).toBe(payUri);
  });

  it('builds a Coinbase Wallet dapp link with cb_url', () => {
    const link = buildWalletDeeplink('coinbase', payUri);
    expect(link.startsWith('https://go.cb-w.com/dapp?cb_url=')).toBe(true);
    expect(decodeURIComponent(link)).toContain(payUri);
  });
});

describe('WALLETS / getWalletMeta', () => {
  it('declares metadata for every supported wallet id', () => {
    const ids = WALLETS.map((w) => w.id).sort();
    expect(ids).toEqual(['backpack', 'coinbase', 'glow', 'phantom', 'solflare', 'trust']);
    for (const wallet of WALLETS) {
      expect(wallet.installUrl.startsWith('https://')).toBe(true);
      expect(wallet.brand).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('looks up wallet metadata by id', () => {
    expect(getWalletMeta('phantom')?.name).toBe('Phantom');
    expect(getWalletMeta('coinbase')?.name).toBe('Coinbase Wallet');
  });
});

describe('mount() wallet UX', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
      new Promise<Response>(() => {})) as typeof fetch;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not render a wallet hint band on desktop with no providers', () => {
    const target = document.createElement('div');
    mount(target, { recipient: RECIPIENT, amount: '1', cluster: 'devnet' });
    expect(target.querySelector('[data-zettapay-wallets]')).toBeNull();
  });

  it('does not call wallet.connect / window.solana.connect anywhere in the DOM tree', () => {
    const target = document.createElement('div');
    mount(target, { recipient: RECIPIENT, amount: '1', cluster: 'devnet' });
    // The rendered embed must never include any "Connect Wallet" affordance.
    const html = target.innerHTML.toLowerCase();
    expect(html).not.toContain('connect wallet');
    expect(html).not.toContain('connect phantom');
    expect(html).not.toContain('wallet.connect');
  });
});
