// MERCHANT_NETWORK enum + xpub-compat regression.
//
// One env var picks the mempool.space cluster, the bech32 HRP, and (via the
// CLI guard) which xpub the operator is allowed to install. Drift in any of
// those mappings has historically meant a vpub silently subscribed to a
// mainnet WebSocket — invisible until a real BTC tx never arrives. We pin
// every cell of the table here.

import { describe, expect, it } from 'vitest';
import {
  ALL_NETWORKS,
  defaultNetworkForXpubKind,
  getNetworkConfig,
  isNetwork,
  isNetworkCompatibleWithXpub,
  readNetwork,
  type Network,
} from '../src/network.js';

describe('getNetworkConfig', () => {
  it('mainnet → mempool.space root + bc1 prefix + bip84Coin=0 + isMainnet', () => {
    const cfg = getNetworkConfig('mainnet');
    expect(cfg.ws).toBe('wss://mempool.space/api/v1/ws');
    expect(cfg.rest).toBe('https://mempool.space/api');
    expect(cfg.addressPrefix).toBe('bc1');
    expect(cfg.bip84Coin).toBe(0);
    expect(cfg.isMainnet).toBe(true);
  });

  it('testnet → /testnet/ subpath + tb1 prefix + bip84Coin=1', () => {
    const cfg = getNetworkConfig('testnet');
    expect(cfg.ws).toBe('wss://mempool.space/testnet/api/v1/ws');
    expect(cfg.rest).toBe('https://mempool.space/testnet/api');
    expect(cfg.addressPrefix).toBe('tb1');
    expect(cfg.bip84Coin).toBe(1);
    expect(cfg.isMainnet).toBe(false);
  });

  it('signet → /signet/ subpath + tb1 prefix (reuses testnet rules)', () => {
    const cfg = getNetworkConfig('signet');
    expect(cfg.ws).toBe('wss://mempool.space/signet/api/v1/ws');
    expect(cfg.rest).toBe('https://mempool.space/signet/api');
    expect(cfg.addressPrefix).toBe('tb1');
    expect(cfg.bip84Coin).toBe(1);
    expect(cfg.isMainnet).toBe(false);
  });

  it('regtest → operator-local endpoints + bcrt1 prefix', () => {
    const cfg = getNetworkConfig('regtest', {} as NodeJS.ProcessEnv);
    expect(cfg.ws).toBe('ws://localhost:50001');
    expect(cfg.rest).toBe('http://localhost:50001');
    expect(cfg.addressPrefix).toBe('bcrt1');
    expect(cfg.bip84Coin).toBe(1);
  });

  it('regtest honors REGTEST_WS_URL / REGTEST_REST_URL overrides', () => {
    const cfg = getNetworkConfig('regtest', {
      REGTEST_WS_URL: 'ws://my-electrs.lan:60002',
      REGTEST_REST_URL: 'http://my-electrs.lan:3000',
    } as NodeJS.ProcessEnv);
    expect(cfg.ws).toBe('ws://my-electrs.lan:60002');
    expect(cfg.rest).toBe('http://my-electrs.lan:3000');
  });
});

describe('isNetwork', () => {
  it.each(['mainnet', 'testnet', 'signet', 'regtest'])('accepts %s', (name) => {
    expect(isNetwork(name)).toBe(true);
  });
  it('rejects unknowns', () => {
    expect(isNetwork('liquid')).toBe(false);
    expect(isNetwork('')).toBe(false);
    expect(isNetwork('SIGNET')).toBe(false); // case-sensitive at this layer
  });
});

describe('readNetwork', () => {
  it('defaults to "mainnet" when MERCHANT_NETWORK is absent', () => {
    expect(readNetwork({} as NodeJS.ProcessEnv)).toBe('mainnet');
  });
  it('honors fallback override (e.g., infer from xpub kind)', () => {
    expect(readNetwork({} as NodeJS.ProcessEnv, 'signet')).toBe('signet');
  });
  it('throws on unknown value', () => {
    expect(() => readNetwork({ MERCHANT_NETWORK: 'liquid' } as NodeJS.ProcessEnv)).toThrow(
      /unknown MERCHANT_NETWORK/,
    );
  });
  it('is case-insensitive on accepted values', () => {
    expect(readNetwork({ MERCHANT_NETWORK: 'SIGNET' } as NodeJS.ProcessEnv)).toBe('signet');
  });
});

describe('isNetworkCompatibleWithXpub', () => {
  it('mainnet xpub kind allows only mainnet', () => {
    expect(isNetworkCompatibleWithXpub('mainnet', 'mainnet')).toBe(true);
    expect(isNetworkCompatibleWithXpub('signet', 'mainnet')).toBe(false);
    expect(isNetworkCompatibleWithXpub('testnet', 'mainnet')).toBe(false);
    expect(isNetworkCompatibleWithXpub('regtest', 'mainnet')).toBe(false);
  });

  it('testnet xpub kind allows signet|testnet|regtest, rejects mainnet', () => {
    expect(isNetworkCompatibleWithXpub('mainnet', 'testnet')).toBe(false);
    expect(isNetworkCompatibleWithXpub('signet', 'testnet')).toBe(true);
    expect(isNetworkCompatibleWithXpub('testnet', 'testnet')).toBe(true);
    expect(isNetworkCompatibleWithXpub('regtest', 'testnet')).toBe(true);
  });
});

describe('defaultNetworkForXpubKind', () => {
  it('mainnet kind → mainnet', () => {
    expect(defaultNetworkForXpubKind('mainnet')).toBe('mainnet');
  });
  it('testnet kind → signet (cheapest "test before mainnet" path)', () => {
    expect(defaultNetworkForXpubKind('testnet')).toBe('signet');
  });
});

describe('ALL_NETWORKS', () => {
  it('lists exactly the 4 supported networks', () => {
    expect([...ALL_NETWORKS].sort()).toEqual<Network[]>(
      ['mainnet', 'regtest', 'signet', 'testnet'],
    );
  });
});
