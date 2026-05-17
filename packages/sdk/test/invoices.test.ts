import { describe, it, expect, vi } from 'vitest';
import {
  InvoicesResource,
  SUPPORTED_CHAINS,
  isSupportedChain,
  normalizeWebhookChain,
  type Chain,
  type Invoice,
  type WebhookInvoicePayload,
} from '../src/invoices.js';

function fakeTransport(invoice: Invoice) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  return {
    calls,
    transport: {
      request: vi.fn(async (method: 'POST' | 'GET', path: string, body?: unknown) => {
        calls.push({ method, path, body });
        return invoice as unknown;
      }),
    },
  };
}

function sampleInvoice(chain: Chain): Invoice {
  return {
    invoice_id: 'inv_abc123',
    chain,
    receive_address: chain === 'btc' ? 'bc1qexampleexample' : '0xExampleExampleExample',
    amount_usd: 29,
    amount_native: chain === 'btc' ? '0.00045' : '29.00',
    qr_uri: 'bitcoin:bc1q...?amount=0.00045',
    expires_at: 1_700_000_000,
    status: 'pending',
    verify_url: 'https://mempool.space/address/bc1qexample',
    metadata: { order_id: 'xyz' },
  };
}

describe('SUPPORTED_CHAINS', () => {
  it('exactly enumerates btc + 3 evm chains', () => {
    expect([...SUPPORTED_CHAINS]).toEqual(['btc', 'base', 'polygon', 'ethereum']);
  });

  it('isSupportedChain accepts only known chains', () => {
    expect(isSupportedChain('btc')).toBe(true);
    expect(isSupportedChain('base')).toBe(true);
    expect(isSupportedChain('polygon')).toBe(true);
    expect(isSupportedChain('ethereum')).toBe(true);
    expect(isSupportedChain('solana')).toBe(false);
    expect(isSupportedChain('SOLANA')).toBe(false);
    expect(isSupportedChain(42)).toBe(false);
    expect(isSupportedChain(undefined)).toBe(false);
  });
});

describe('invoices.create', () => {
  it('posts chain + amount_usd + metadata to /api/invoices', async () => {
    const fake = fakeTransport(sampleInvoice('base'));
    const invoices = new InvoicesResource(fake.transport);
    const result = await invoices.create({
      amount_usd: 29,
      chain: 'base',
      metadata: { order_id: 'xyz' },
    });

    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call?.method).toBe('POST');
    expect(call?.path).toBe('/api/invoices');
    expect(call?.body).toEqual({
      amount_usd: 29,
      chain: 'base',
      metadata: { order_id: 'xyz' },
    });
    expect(result.chain).toBe('base');
    expect(result.receive_address).toMatch(/^0x/);
  });

  it('omits optional fields when not provided', async () => {
    const fake = fakeTransport(sampleInvoice('btc'));
    const invoices = new InvoicesResource(fake.transport);
    await invoices.create({ amount_usd: 5, chain: 'btc' });

    expect(fake.calls[0]?.body).toEqual({ amount_usd: 5, chain: 'btc' });
  });

  it('rejects unknown chains client-side (matches API 400)', async () => {
    const fake = fakeTransport(sampleInvoice('base'));
    const invoices = new InvoicesResource(fake.transport);
    await expect(
      invoices.create({ amount_usd: 10, chain: 'solana' as Chain }),
    ).rejects.toThrow(/chain must be one of/);
    expect(fake.transport.request).not.toHaveBeenCalled();
  });

  it('rejects non-positive amounts client-side', async () => {
    const fake = fakeTransport(sampleInvoice('base'));
    const invoices = new InvoicesResource(fake.transport);
    await expect(invoices.create({ amount_usd: 0, chain: 'base' })).rejects.toThrow();
    await expect(invoices.create({ amount_usd: -1, chain: 'base' })).rejects.toThrow();
    await expect(
      invoices.create({ amount_usd: Number.NaN, chain: 'base' }),
    ).rejects.toThrow();
  });

  it('forwards merchant_id + ttl_seconds when provided', async () => {
    const fake = fakeTransport(sampleInvoice('ethereum'));
    const invoices = new InvoicesResource(fake.transport);
    await invoices.create({
      amount_usd: 100,
      chain: 'ethereum',
      merchant_id: 'mer_42',
      ttl_seconds: 600,
    });
    expect(fake.calls[0]?.body).toEqual({
      amount_usd: 100,
      chain: 'ethereum',
      merchant_id: 'mer_42',
      ttl_seconds: 600,
    });
  });
});

describe('webhook payload chain field', () => {
  it('parses a multi-chain webhook payload with chain field', () => {
    const payload: WebhookInvoicePayload = {
      invoice_id: 'inv_001',
      status: 'confirmed',
      chain: 'base',
      tx_hash: '0xabc',
      amount_native: '29.00',
      confirmations: 3,
      receive_address: '0xMerchantReceive',
      merchant_id: 'mer_42',
    };
    expect(payload.chain).toBe('base');
  });

  it('normalizes legacy payloads (no chain) to "unknown" for backward compat', () => {
    expect(normalizeWebhookChain(undefined)).toBe('unknown');
    expect(normalizeWebhookChain(null)).toBe('unknown');
    expect(normalizeWebhookChain('solana')).toBe('unknown');
    expect(normalizeWebhookChain('btc')).toBe('btc');
    expect(normalizeWebhookChain('ethereum')).toBe('ethereum');
  });
});
