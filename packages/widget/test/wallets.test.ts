import { describe, expect, it } from 'vitest';
import {
  WIDGET_WALLETS,
  buildWalletBrowseLink,
  detectWallets,
  discoverWalletStandard,
  isMobile,
} from '../src/wallets.js';

const CHECKOUT_URL = 'https://pay.zettapay.io/c/pay_abc123';

describe('isMobile', () => {
  it('flags common mobile user agents', () => {
    expect(isMobile('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe(true);
    expect(isMobile('Mozilla/5.0 (Linux; Android 13; Pixel 7)')).toBe(true);
  });
  it('returns false for desktop UAs', () => {
    expect(isMobile('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false);
  });
});

describe('detectWallets', () => {
  it('returns empty by default', () => {
    const r = detectWallets({}, false);
    expect(r.installed).toEqual([]);
  });

  it('detects Phantom via window.solana legacy global', () => {
    const r = detectWallets({ solana: { isPhantom: true } }, false);
    expect(r.installed).toEqual(['phantom']);
  });

  it('preserves canonical wallet order across detections', () => {
    const r = detectWallets(
      {
        coinbaseSolana: {},
        phantom: { solana: { isPhantom: true } },
        backpack: { isBackpack: true },
      },
      false,
    );
    // Order matches WIDGET_WALLETS: phantom, solflare, backpack, glow, trust, coinbase
    expect(r.installed).toEqual(['phantom', 'backpack', 'coinbase']);
  });
});

describe('discoverWalletStandard', () => {
  it('collects wallets via the wallet-standard handshake', () => {
    const bus = new EventTarget();
    bus.addEventListener('wallet-standard:app-ready', (e) => {
      const detail = (e as CustomEvent<{ register: (w: unknown) => void }>).detail;
      detail.register({ name: 'Phantom' });
      detail.register({ name: 'Glow Wallet' });
    });
    expect(discoverWalletStandard(bus).sort()).toEqual(['glow', 'phantom']);
  });

  it('does not invoke methods on registered wallet objects', () => {
    const bus = new EventTarget();
    const calls: string[] = [];
    const trap = new Proxy(
      {},
      {
        get(_t, prop) {
          calls.push(String(prop));
          if (prop === 'name') return 'Solflare';
          return undefined;
        },
      },
    );
    bus.addEventListener('wallet-standard:app-ready', (e) => {
      (e as CustomEvent<{ register: (w: unknown) => void }>).detail.register(trap);
    });
    discoverWalletStandard(bus);
    expect(calls).not.toContain('connect');
    expect(calls).not.toContain('features');
  });
});

describe('buildWalletBrowseLink', () => {
  it('wraps in a Phantom universal browse link with ref', () => {
    const url = buildWalletBrowseLink('phantom', CHECKOUT_URL);
    expect(url.startsWith('https://phantom.app/ul/browse/')).toBe(true);
    expect(url).toContain('?ref=');
  });

  it('wraps in a Solflare universal browse link', () => {
    expect(buildWalletBrowseLink('solflare', CHECKOUT_URL).startsWith(
      'https://solflare.com/ul/v1/browse/',
    )).toBe(true);
  });

  it('falls back to the checkout URL for wallets without a browse spec', () => {
    expect(buildWalletBrowseLink('backpack', CHECKOUT_URL)).toBe(CHECKOUT_URL);
    expect(buildWalletBrowseLink('glow', CHECKOUT_URL)).toBe(CHECKOUT_URL);
    expect(buildWalletBrowseLink('trust', CHECKOUT_URL)).toBe(CHECKOUT_URL);
  });

  it('builds a Coinbase cb_url dapp link', () => {
    const url = buildWalletBrowseLink('coinbase', CHECKOUT_URL);
    expect(url.startsWith('https://go.cb-w.com/dapp?cb_url=')).toBe(true);
  });
});

describe('WIDGET_WALLETS', () => {
  it('declares metadata for every supported wallet id', () => {
    const ids = WIDGET_WALLETS.map((w) => w.id).sort();
    expect(ids).toEqual(['backpack', 'coinbase', 'glow', 'phantom', 'solflare', 'trust']);
    for (const wallet of WIDGET_WALLETS) {
      expect(wallet.installUrl.startsWith('https://')).toBe(true);
    }
  });
});
