import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  DEFAULT_CURRENCY,
  SOLANA_PAY_URI_SCHEME,
  ZETTAPAY_URI_SCHEME,
  buildSolanaPayUri,
  buildZettaPayUri,
  generateInvoiceQrDataUrl,
  generateInvoiceQrSvg,
  parseZettaPayUri,
  USDC_MAINNET_MINT,
} from '../src/index.js';

const SAMPLE_PDA = Keypair.generate().publicKey;
const SAMPLE_RECIPIENT = Keypair.generate().publicKey;

describe('buildZettaPayUri', () => {
  it('produces the canonical "zettapay:invoice/<pda>?amount=29&currency=USDC" shape', () => {
    const uri = buildZettaPayUri({
      invoicePda: SAMPLE_PDA,
      amount: 29,
    });
    expect(uri.startsWith(`${ZETTAPAY_URI_SCHEME}:invoice/${SAMPLE_PDA.toBase58()}?`)).toBe(true);
    const search = new URLSearchParams(uri.split('?')[1]);
    expect(search.get('amount')).toBe('29');
    expect(search.get('currency')).toBe('USDC');
  });

  it('defaults currency to USDC', () => {
    const uri = buildZettaPayUri({ invoicePda: SAMPLE_PDA });
    expect(new URLSearchParams(uri.split('?')[1]).get('currency')).toBe(DEFAULT_CURRENCY);
  });

  it('accepts decimal string amounts verbatim', () => {
    const uri = buildZettaPayUri({ invoicePda: SAMPLE_PDA, amount: '1.5' });
    expect(new URLSearchParams(uri.split('?')[1]).get('amount')).toBe('1.5');
  });

  it('encodes bigint amounts as decimal strings', () => {
    const uri = buildZettaPayUri({ invoicePda: SAMPLE_PDA, amount: 1500000n });
    expect(new URLSearchParams(uri.split('?')[1]).get('amount')).toBe('1500000');
  });

  it('passes through label / message / memo', () => {
    const uri = buildZettaPayUri({
      invoicePda: SAMPLE_PDA,
      amount: 5,
      label: 'Acme Coffee',
      message: 'Order #4421',
      memo: 'invoice-4421',
    });
    const search = new URLSearchParams(uri.split('?')[1]);
    expect(search.get('label')).toBe('Acme Coffee');
    expect(search.get('message')).toBe('Order #4421');
    expect(search.get('memo')).toBe('invoice-4421');
  });

  it('rejects zero or negative amounts', () => {
    expect(() => buildZettaPayUri({ invoicePda: SAMPLE_PDA, amount: 0 })).toThrow();
    expect(() => buildZettaPayUri({ invoicePda: SAMPLE_PDA, amount: '-1' })).toThrow();
  });

  it('rejects malformed decimal strings', () => {
    expect(() => buildZettaPayUri({ invoicePda: SAMPLE_PDA, amount: '1.2.3' })).toThrow();
    expect(() => buildZettaPayUri({ invoicePda: SAMPLE_PDA, amount: 'abc' })).toThrow();
  });

  it('rejects non-finite numeric amounts', () => {
    expect(() => buildZettaPayUri({ invoicePda: SAMPLE_PDA, amount: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => buildZettaPayUri({ invoicePda: SAMPLE_PDA, amount: Number.NaN })).toThrow();
  });

  it('rejects empty currency', () => {
    expect(() => buildZettaPayUri({ invoicePda: SAMPLE_PDA, currency: '   ' })).toThrow();
  });

  it('accepts a base58 string PDA and round-trips through PublicKey validation', () => {
    const uri = buildZettaPayUri({ invoicePda: SAMPLE_PDA.toBase58(), amount: 2 });
    expect(uri).toContain(SAMPLE_PDA.toBase58());
  });

  it('rejects an invalid base58 PDA string', () => {
    expect(() => buildZettaPayUri({ invoicePda: 'not-a-key', amount: 1 })).toThrow();
  });
});

describe('parseZettaPayUri', () => {
  it('round-trips a fully populated URI', () => {
    const uri = buildZettaPayUri({
      invoicePda: SAMPLE_PDA,
      amount: '29.99',
      label: 'Acme',
      message: 'Order #1',
      memo: 'memo-1',
    });
    const parsed = parseZettaPayUri(uri);
    expect(parsed.invoicePda).toBe(SAMPLE_PDA.toBase58());
    expect(parsed.amount).toBe('29.99');
    expect(parsed.currency).toBe('USDC');
    expect(parsed.label).toBe('Acme');
    expect(parsed.message).toBe('Order #1');
    expect(parsed.memo).toBe('memo-1');
  });

  it('returns null for omitted optional fields', () => {
    const parsed = parseZettaPayUri(`zettapay:invoice/${SAMPLE_PDA.toBase58()}?currency=USDC`);
    expect(parsed.amount).toBeNull();
    expect(parsed.label).toBeNull();
    expect(parsed.message).toBeNull();
    expect(parsed.memo).toBeNull();
  });

  it('rejects the wrong scheme', () => {
    expect(() => parseZettaPayUri(`solana:${SAMPLE_PDA.toBase58()}`)).toThrow(/scheme/);
  });

  it('rejects an unknown resource segment', () => {
    expect(() => parseZettaPayUri(`zettapay:order/${SAMPLE_PDA.toBase58()}`)).toThrow(/resource/);
  });

  it('rejects a missing PDA', () => {
    expect(() => parseZettaPayUri('zettapay:invoice/')).toThrow();
  });

  it('rejects an invalid base58 PDA', () => {
    expect(() => parseZettaPayUri('zettapay:invoice/not-a-key?amount=1')).toThrow();
  });
});

describe('buildSolanaPayUri', () => {
  it('produces a standard "solana:<recipient>?..." URI', () => {
    const uri = buildSolanaPayUri({
      recipient: SAMPLE_RECIPIENT,
      amount: 29,
      splToken: USDC_MAINNET_MINT,
      reference: [SAMPLE_PDA],
      label: 'ZettaPay',
      message: 'Pay 29 USDC',
    });
    expect(uri.startsWith(`${SOLANA_PAY_URI_SCHEME}:${SAMPLE_RECIPIENT.toBase58()}?`)).toBe(true);
    const search = new URLSearchParams(uri.split('?')[1]);
    expect(search.get('amount')).toBe('29');
    expect(search.get('spl-token')).toBe(USDC_MAINNET_MINT.toBase58());
    expect(search.get('reference')).toBe(SAMPLE_PDA.toBase58());
    expect(search.get('label')).toBe('ZettaPay');
    expect(search.get('message')).toBe('Pay 29 USDC');
  });

  it('supports multiple reference pubkeys', () => {
    const refA = Keypair.generate().publicKey;
    const refB = Keypair.generate().publicKey;
    const uri = buildSolanaPayUri({
      recipient: SAMPLE_RECIPIENT,
      reference: [refA, refB],
    });
    const search = new URLSearchParams(uri.split('?')[1]);
    const refs = search.getAll('reference');
    expect(refs).toEqual([refA.toBase58(), refB.toBase58()]);
  });

  it('omits the query string when no fields are supplied', () => {
    const uri = buildSolanaPayUri({ recipient: SAMPLE_RECIPIENT });
    expect(uri).toBe(`${SOLANA_PAY_URI_SCHEME}:${SAMPLE_RECIPIENT.toBase58()}`);
  });

  it('rejects an invalid recipient', () => {
    expect(() => buildSolanaPayUri({ recipient: 'nope' })).toThrow();
  });

  it('validates each reference pubkey', () => {
    expect(() => buildSolanaPayUri({
      recipient: SAMPLE_RECIPIENT,
      reference: ['not-a-key'],
    })).toThrow();
  });
});

describe('generateInvoiceQrSvg', () => {
  it('renders the URI as an SVG document', async () => {
    const uri = buildZettaPayUri({ invoicePda: SAMPLE_PDA, amount: 29 });
    const svg = await generateInvoiceQrSvg(uri);
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  it('honours the size option (sets viewBox/width)', async () => {
    const uri = buildZettaPayUri({ invoicePda: SAMPLE_PDA, amount: 1 });
    const svg = await generateInvoiceQrSvg(uri, { size: 512 });
    expect(svg).toMatch(/viewBox="[^"]+"/);
    expect(svg).toContain('width="512"');
  });

  it('rejects an empty URI', async () => {
    await expect(generateInvoiceQrSvg('')).rejects.toThrow();
  });
});

describe('generateInvoiceQrDataUrl', () => {
  it('returns a PNG data URL', async () => {
    const uri = buildZettaPayUri({ invoicePda: SAMPLE_PDA, amount: 5 });
    const dataUrl = await generateInvoiceQrDataUrl(uri);
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(dataUrl.length).toBeGreaterThan(100);
  });

  it('renders the standard Solana Pay URI too — wallet-compatible flow', async () => {
    const uri = buildSolanaPayUri({
      recipient: SAMPLE_RECIPIENT,
      amount: 29,
      splToken: USDC_MAINNET_MINT,
      reference: [SAMPLE_PDA],
    });
    const dataUrl = await generateInvoiceQrDataUrl(uri);
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });
});

describe('integration — Z26 invoice PDA → URI → QR pipeline', () => {
  it('builds both URI flavours from the same invoice PDA', async () => {
    const pda = new PublicKey(SAMPLE_PDA.toBase58());
    const zettaUri = buildZettaPayUri({
      invoicePda: pda,
      amount: '29.00',
      label: 'Acme Coffee',
    });
    const solanaUri = buildSolanaPayUri({
      recipient: SAMPLE_RECIPIENT,
      amount: '29.00',
      splToken: USDC_MAINNET_MINT,
      reference: [pda],
      label: 'Acme Coffee',
    });

    const parsed = parseZettaPayUri(zettaUri);
    expect(parsed.invoicePda).toBe(pda.toBase58());

    const [zettaSvg, solanaSvg] = await Promise.all([
      generateInvoiceQrSvg(zettaUri),
      generateInvoiceQrSvg(solanaUri),
    ]);
    expect(zettaSvg).toContain('<svg');
    expect(solanaSvg).toContain('<svg');
  });
});
