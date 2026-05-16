import { describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import {
  deriveAddress,
  deriveBitcoinAddress,
  deriveEthereumAddress,
  deriveUsdcAddress,
} from '../src/index.js';

const SEED = new Uint8Array([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
]);

function masterXpub(): string {
  return HDKey.fromMasterSeed(SEED).publicExtendedKey;
}

describe('fixed test vectors (seed = 0x00..1f)', () => {
  it('locks BTC mainnet index 0', () => {
    expect(deriveBitcoinAddress({ xpub: masterXpub(), index: 0 })).toEqual({
      chain: 'btc',
      path: 'm/44/0/0/0/0',
      index: 0,
      publicKey: '03a3832f9b99982617cb8a5ea2676ba11ae0c8f161fa4855bd00f8a308467fcf6e',
      address: 'bc1qsgqzgsjunj26ap8z2vxued5hnfuthxwz7nnren',
    });
  });

  it('locks BTC testnet index 0', () => {
    expect(deriveBitcoinAddress({ xpub: masterXpub(), index: 0, network: 'testnet' }).address).toBe(
      'tb1qsgqzgsjunj26ap8z2vxued5hnfuthxwz54gszq',
    );
  });

  it('locks ETH + USDC index 0', () => {
    const eth = deriveEthereumAddress({ xpub: masterXpub(), index: 0 });
    expect(eth.publicKey).toBe('023c7976712b2b9a49143c57836a3090f3cf39680a9c2191b05b8a6a3ca655ff8a');
    expect(eth.address).toBe('0x8c94Da449Ecd24D2f1f595A37e95257e30Ff03F9');
    expect(deriveUsdcAddress({ xpub: masterXpub(), index: 0 }).address).toBe(eth.address);
  });
});

describe('deriveBitcoinAddress', () => {
  it('encodes a bech32 P2WPKH mainnet address', () => {
    const xpub = masterXpub();
    const out = deriveBitcoinAddress({ xpub, index: 0 });
    expect(out.chain).toBe('btc');
    expect(out.index).toBe(0);
    expect(out.path).toBe('m/44/0/0/0/0');
    expect(out.address.startsWith('bc1q')).toBe(true);
    expect(out.address.length).toBeGreaterThanOrEqual(42);
    expect(out.publicKey).toMatch(/^(02|03)[0-9a-f]{64}$/);
  });

  it('switches HRP for testnet', () => {
    const xpub = masterXpub();
    const out = deriveBitcoinAddress({ xpub, index: 0, network: 'testnet' });
    expect(out.address.startsWith('tb1q')).toBe(true);
  });

  it('is deterministic', () => {
    const xpub = masterXpub();
    const a = deriveBitcoinAddress({ xpub, index: 7 });
    const b = deriveBitcoinAddress({ xpub, index: 7 });
    expect(a).toEqual(b);
  });

  it('produces distinct addresses per index', () => {
    const xpub = masterXpub();
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      seen.add(deriveBitcoinAddress({ xpub, index: i }).address);
    }
    expect(seen.size).toBe(5);
  });
});

describe('deriveEthereumAddress', () => {
  it('returns an EIP-55 checksummed 0x address', () => {
    const xpub = masterXpub();
    const out = deriveEthereumAddress({ xpub, index: 0 });
    expect(out.chain).toBe('eth');
    expect(out.path).toBe('m/44/60/0/0/0');
    expect(out.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(out.address.toLowerCase()).not.toBe(out.address.toUpperCase());
  });

  it('is deterministic and unique per index', () => {
    const xpub = masterXpub();
    const a = deriveEthereumAddress({ xpub, index: 3 });
    const b = deriveEthereumAddress({ xpub, index: 3 });
    expect(a.address).toBe(b.address);
    const c = deriveEthereumAddress({ xpub, index: 4 });
    expect(a.address).not.toBe(c.address);
  });
});

describe('deriveUsdcAddress', () => {
  it('reuses the ETH address scheme (EVM USDC ERC-20)', () => {
    const xpub = masterXpub();
    const usdc = deriveUsdcAddress({ xpub, index: 11 });
    const eth = deriveEthereumAddress({ xpub, index: 11 });
    expect(usdc.address).toBe(eth.address);
    expect(usdc.publicKey).toBe(eth.publicKey);
    expect(usdc.chain).toBe('usdc');
    expect(usdc.path).toBe('m/44/60/0/0/11');
  });
});

describe('deriveAddress', () => {
  it('routes by chain', () => {
    const xpub = masterXpub();
    expect(deriveAddress({ chain: 'btc', xpub, index: 0 }).address).toBe(
      deriveBitcoinAddress({ xpub, index: 0 }).address,
    );
    expect(deriveAddress({ chain: 'eth', xpub, index: 0 }).address).toBe(
      deriveEthereumAddress({ xpub, index: 0 }).address,
    );
    expect(deriveAddress({ chain: 'usdc', xpub, index: 0 }).address).toBe(
      deriveUsdcAddress({ xpub, index: 0 }).address,
    );
  });

  it('rejects hardened indices and invalid uint32', () => {
    const xpub = masterXpub();
    expect(() => deriveBitcoinAddress({ xpub, index: -1 })).toThrow(/non-hardened/);
    expect(() => deriveBitcoinAddress({ xpub, index: 0x80000000 })).toThrow(/non-hardened/);
    expect(() => deriveBitcoinAddress({ xpub, index: 1.5 })).toThrow(/non-hardened/);
  });

  it('rejects malformed xpub', () => {
    expect(() => deriveBitcoinAddress({ xpub: '', index: 0 })).toThrow(/non-empty/);
    expect(() => deriveBitcoinAddress({ xpub: 'not-an-xpub', index: 0 })).toThrow(/invalid xpub/);
  });
});
