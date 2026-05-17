// Lock the Z45 HD-wallet derivation against the canonical BIP-39/44/84
// test vectors. These addresses match what Sparrow / Electrum / Metamask
// produce for the same mnemonic — so anyone holding the paper backup can
// recover funds independent of ZettaPay infrastructure.

import { describe, expect, it } from 'vitest';
import {
  KeyManager,
  InMemoryIndexAllocator,
  mnemonicToMasterKey,
  deriveBtcAddressFromMaster,
  deriveEvmAddressFromMaster,
  pathFor,
  chainToNamespace,
} from '../src/index.js';

// BIP-39 canonical "all-abandon" mnemonic. Public, never used on mainnet.
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// BIP-84 §"Test vectors" — m/84'/0'/0'/0/{0,1}.
//   https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki
const BIP84_BTC = {
  0: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
  1: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
};

// BIP-44 SLIP-44 coin type 60 (Ethereum). m/44'/60'/0'/0/0 for the
// "all-abandon" mnemonic is the de-facto Metamask reference address —
// every BIP-39 wallet ever shipped agrees on this value.
const BIP44_ETH = {
  0: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
};

describe('mnemonicToMasterKey', () => {
  it('accepts the canonical 12-word mnemonic', () => {
    const master = mnemonicToMasterKey(TEST_MNEMONIC);
    expect(master.publicKey).toBeTruthy();
  });

  it('normalizes redundant whitespace', () => {
    const noisy = `  ${TEST_MNEMONIC.replace(/ /g, '   ')}  `;
    const expected = mnemonicToMasterKey(TEST_MNEMONIC);
    const got = mnemonicToMasterKey(noisy);
    expect(got.publicExtendedKey).toBe(expected.publicExtendedKey);
  });

  it('rejects a checksum-broken mnemonic without leaking it', () => {
    const broken = 'abandon '.repeat(11) + 'zoo';
    let err: unknown;
    try {
      mnemonicToMasterKey(broken);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('KeyManager: invalid BIP39 mnemonic (checksum failed)');
    expect((err as Error).message).not.toContain('abandon');
    expect((err as Error).message).not.toContain('zoo');
  });

  it('rejects a non-string mnemonic', () => {
    expect(() => mnemonicToMasterKey(undefined as unknown as string)).toThrow(/must be a string/);
  });
});

describe('BIP-84 BTC vectors', () => {
  const master = mnemonicToMasterKey(TEST_MNEMONIC);

  it('m/84\'/0\'/0\'/0/0 → bc1qcr8...', () => {
    const got = deriveBtcAddressFromMaster(master, 0, 'mainnet');
    expect(got.address).toBe(BIP84_BTC[0]);
    expect(got.path).toBe("m/84'/0'/0'/0/0");
    expect(got.chain).toBe('btc');
    expect(got.namespace).toBe('btc');
    expect(got.index).toBe(0);
  });

  it('m/84\'/0\'/0\'/0/1 → bc1qnjg...', () => {
    const got = deriveBtcAddressFromMaster(master, 1, 'mainnet');
    expect(got.address).toBe(BIP84_BTC[1]);
    expect(got.path).toBe("m/84'/0'/0'/0/1");
  });

  it('switches HRP to tb on testnet', () => {
    const got = deriveBtcAddressFromMaster(master, 0, 'testnet');
    expect(got.address.startsWith('tb1q')).toBe(true);
  });
});

describe('BIP-44 EVM vectors', () => {
  const master = mnemonicToMasterKey(TEST_MNEMONIC);

  it('m/44\'/60\'/0\'/0/0 → 0x9858EfFD... (EIP-55 checksummed)', () => {
    const got = deriveEvmAddressFromMaster(master, 'ethereum', 0);
    expect(got.address).toBe(BIP44_ETH[0]);
    expect(got.path).toBe("m/44'/60'/0'/0/0");
    expect(got.namespace).toBe('evm');
  });

  it('same address across base / polygon / ethereum at the same index', () => {
    const eth = deriveEvmAddressFromMaster(master, 'ethereum', 7);
    const base = deriveEvmAddressFromMaster(master, 'base', 7);
    const polygon = deriveEvmAddressFromMaster(master, 'polygon', 7);
    expect(base.address).toBe(eth.address);
    expect(polygon.address).toBe(eth.address);
    expect(base.path).toBe(eth.path);
    expect(base.chain).toBe('base');
    expect(polygon.chain).toBe('polygon');
  });
});

describe('chainToNamespace + pathFor', () => {
  it('maps EVM chains to the shared evm namespace', () => {
    expect(chainToNamespace('base')).toBe('evm');
    expect(chainToNamespace('polygon')).toBe('evm');
    expect(chainToNamespace('ethereum')).toBe('evm');
    expect(chainToNamespace('btc')).toBe('btc');
  });

  it('builds the correct path string', () => {
    expect(pathFor('btc', 3)).toBe("m/84'/0'/0'/0/3");
    expect(pathFor('base', 12)).toBe("m/44'/60'/0'/0/12");
  });
});

describe('KeyManager', () => {
  it('deriveNext allocates fresh indexes per call', async () => {
    const allocator = new InMemoryIndexAllocator();
    const km = new KeyManager({ mnemonic: TEST_MNEMONIC, allocator });
    const first = await km.deriveNext('btc');
    const second = await km.deriveNext('btc');
    expect(first.index).toBe(0);
    expect(second.index).toBe(1);
    expect(first.address).toBe(BIP84_BTC[0]);
    expect(second.address).toBe(BIP84_BTC[1]);
  });

  it('deriveByPath is idempotent and matches deriveNext', async () => {
    const allocator = new InMemoryIndexAllocator();
    const km = new KeyManager({ mnemonic: TEST_MNEMONIC, allocator });
    const next = await km.deriveNext('ethereum');
    const replay = km.deriveByPath('ethereum', next.path);
    expect(replay.address).toBe(next.address);
    expect(replay.index).toBe(next.index);
    // deriveByPath must not touch the allocator.
    expect(allocator.peek('evm')).toBe(1);
  });

  it('deriveByPath rejects mismatched chain path', () => {
    const km = new KeyManager({
      mnemonic: TEST_MNEMONIC,
      allocator: new InMemoryIndexAllocator(),
    });
    expect(() => km.deriveByPath('btc', "m/44'/60'/0'/0/0")).toThrow(/does not match/);
  });

  it('keeps btc + evm namespaces independent', async () => {
    const allocator = new InMemoryIndexAllocator();
    const km = new KeyManager({ mnemonic: TEST_MNEMONIC, allocator });
    await km.deriveNext('btc');
    await km.deriveNext('btc');
    const evmFirst = await km.deriveNext('base');
    expect(evmFirst.index).toBe(0);
    expect(allocator.peek('btc')).toBe(2);
    expect(allocator.peek('evm')).toBe(1);
  });

  it('10 parallel deriveNext calls yield indexes 0..9 with no collisions', async () => {
    const allocator = new InMemoryIndexAllocator();
    const km = new KeyManager({ mnemonic: TEST_MNEMONIC, allocator });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => km.deriveNext('base')),
    );
    const indexes = results.map((r) => r.index).sort((a, b) => a - b);
    expect(indexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const addresses = new Set(results.map((r) => r.address));
    expect(addresses.size).toBe(10);
  });

  it('rejects construction without allocator', () => {
    expect(() => new KeyManager({ mnemonic: TEST_MNEMONIC } as unknown as never)).toThrow(
      /allocator required/,
    );
  });

  it('never includes mnemonic in stringified state', () => {
    const km = new KeyManager({
      mnemonic: TEST_MNEMONIC,
      allocator: new InMemoryIndexAllocator(),
    });
    const serialized = JSON.stringify(km);
    expect(serialized).not.toContain('abandon');
    expect(serialized).not.toContain('about');
  });
});
