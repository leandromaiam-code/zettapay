import { describe, expect, it } from 'vitest';
import {
  compressedPubKeyToBtcAddress,
  compressedPubKeyToEthAddress,
  deriveBitcoinAddress,
  deriveEthereumAddress,
  deriveUsdcEvmAddress,
  toEip55,
  USDC_EVM_CONTRACTS,
} from '../src/crosschain.js';

const G_COMPRESSED = Uint8Array.from(
  Buffer.from(
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    'hex',
  ),
);

describe('BTC P2PKH encoding', () => {
  it('encodes the generator point as the well-known "private key 1" address (compressed form)', () => {
    // Bitcoin's two famous "private key 1" addresses: 1EHNa6Q4... is
    // the uncompressed form, 1BgGZ9tc... is the compressed form. Our
    // hash160 input is the 33-byte compressed pubkey, so the compressed
    // form is the correct expectation.
    expect(compressedPubKeyToBtcAddress(G_COMPRESSED, 'mainnet')).toBe(
      '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
    );
  });

  it('emits a testnet address for testnet version byte', () => {
    const addr = compressedPubKeyToBtcAddress(G_COMPRESSED, 'testnet');
    expect(addr.startsWith('m') || addr.startsWith('n')).toBe(true);
  });

  it('rejects malformed compressed pubkeys', () => {
    expect(() =>
      compressedPubKeyToBtcAddress(new Uint8Array(32)),
    ).toThrow();
    const badPrefix = new Uint8Array(33);
    badPrefix[0] = 0x05;
    expect(() => compressedPubKeyToBtcAddress(badPrefix)).toThrow();
  });
});

describe('ETH EIP-55 encoding', () => {
  it('encodes the generator point as the well-known "private key 1" EOA', () => {
    expect(compressedPubKeyToEthAddress(G_COMPRESSED)).toBe(
      '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
    );
  });

  it('matches the canonical EIP-55 vectors from the spec', () => {
    const samples = [
      '5aaeb6053f3e94c9b9a09f33669435e7ef1beaed',
      'fb6916095ca1df60bb79ce92ce3ea74c37c5d359',
      'dbf03b407c01e7cd3cbea99509d93f8dddc8c6fb',
      'd1220a0cf47c7b9be7a2e6ba89f429762e7b9adb',
    ];
    const expected = [
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
      '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    ];
    for (let i = 0; i < samples.length; i++) {
      expect(toEip55(samples[i]!)).toBe(expected[i]);
    }
  });

  it('rejects non-40-char hex inputs', () => {
    expect(() => toEip55('not hex')).toThrow();
    expect(() => toEip55('a'.repeat(39))).toThrow();
    expect(() => toEip55('A'.repeat(40))).toThrow();
  });
});

describe('xpub-rooted address derivation', () => {
  // BIP39 mnemonic "abandon abandon abandon abandon abandon abandon abandon
  // abandon abandon abandon abandon about", BIP44 BTC account xpub
  // (m/44'/0'/0'). Canonical test vector; first receive address (0/0) is
  // documented in every wallet's compatibility matrix.
  const BTC_ACCOUNT_XPUB =
    'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj';

  it('derives the canonical first receive address from the BTC account xpub', () => {
    const { address, derivationPath } = deriveBitcoinAddress(
      BTC_ACCOUNT_XPUB,
      0,
      { pathPrefix: [0] }, // account xpub already past the hardened prefix
    );
    expect(address).toBe('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
    expect(derivationPath).toBe('m/0/0');
  });

  it('derives consecutive BTC addresses deterministically', () => {
    const a0 = deriveBitcoinAddress(BTC_ACCOUNT_XPUB, 0, { pathPrefix: [0] }).address;
    const a1 = deriveBitcoinAddress(BTC_ACCOUNT_XPUB, 1, { pathPrefix: [0] }).address;
    const a0Again = deriveBitcoinAddress(BTC_ACCOUNT_XPUB, 0, { pathPrefix: [0] }).address;
    expect(a0).not.toBe(a1);
    expect(a0).toBe(a0Again);
  });

  it('produces stable ETH addresses from a BIP32 ETH account xpub', () => {
    // Round-trip: derive twice and confirm equality + checksum shape.
    const xpub =
      'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj';
    const first = deriveEthereumAddress(xpub, 0, { pathPrefix: [0] });
    const again = deriveEthereumAddress(xpub, 0, { pathPrefix: [0] });
    expect(first.address).toBe(again.address);
    expect(first.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(first.derivationPath).toBe('m/0/0');
  });

  it('USDC EVM derivation reuses the ETH address scheme', () => {
    const xpub =
      'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj';
    const eth = deriveEthereumAddress(xpub, 7, { pathPrefix: [0] });
    const onBase = deriveUsdcEvmAddress(xpub, 7, { pathPrefix: [0], chain: 'base' });
    const onPolygon = deriveUsdcEvmAddress(xpub, 7, { pathPrefix: [0], chain: 'polygon' });
    expect(onBase.address).toBe(eth.address);
    expect(onPolygon.address).toBe(eth.address);
    expect(onBase.tokenContract).toBe(USDC_EVM_CONTRACTS.base);
    expect(onPolygon.tokenContract).toBe(USDC_EVM_CONTRACTS.polygon);
    expect(onBase.chain).toBe('base');
  });

  it('defaults to the spec path m/44/60/0/0/{index} for ETH when no prefix is given', () => {
    // A consumer that genuinely owns m (the master) can pass the full
    // BIP44-shaped non-hardened path verbatim — same xpub, no prefix
    // override. The output just needs to be a valid checksummed addr.
    const xpub =
      'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';
    const { address, derivationPath } = deriveEthereumAddress(xpub, 0);
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(derivationPath).toBe('m/44/60/0/0/0');
  });
});
