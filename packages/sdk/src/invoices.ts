/**
 * Multi-chain invoice surface — ZettaPay watches BTC + USDC across EVM
 * (Base / Polygon / Ethereum). Customers send to a per-invoice receive
 * address derived by Z45's HD wallet allocator; the listener detects the
 * inbound tx and fires the webhook.
 *
 * The `chain` field is required at creation time and travels with every
 * invoice + webhook payload thereafter.
 */

export const SUPPORTED_CHAINS = ['btc', 'base', 'polygon', 'ethereum'] as const;

export type Chain = (typeof SUPPORTED_CHAINS)[number];

/** Backward-compat: invoices created before Z52 lack `chain` and report 'unknown'. */
export type WebhookChain = Chain | 'unknown';

export type InvoiceStatus =
  | 'pending'
  | 'detected'
  | 'confirming'
  | 'confirmed'
  | 'expired'
  | 'canceled';

export interface CreateInvoiceInput {
  amount_usd: number;
  chain: Chain;
  merchant_id?: string;
  ttl_seconds?: number;
  metadata?: Record<string, unknown>;
}

export interface Invoice {
  invoice_id: string;
  chain: Chain;
  receive_address: string;
  amount_usd: number;
  amount_native: string;
  qr_uri: string;
  expires_at: number;
  status: InvoiceStatus;
  verify_url: string;
  merchant_id?: string;
  metadata?: Record<string, unknown>;
}

export interface WebhookInvoicePayload {
  invoice_id: string;
  status: InvoiceStatus;
  chain: WebhookChain;
  tx_hash: string | null;
  amount_native: string;
  confirmations: number;
  receive_address: string;
  merchant_id: string;
  metadata?: Record<string, unknown>;
}

export function isSupportedChain(value: unknown): value is Chain {
  return typeof value === 'string' && (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

/** Normalize a webhook payload's `chain`, returning 'unknown' when absent. */
export function normalizeWebhookChain(value: unknown): WebhookChain {
  if (isSupportedChain(value)) return value;
  return 'unknown';
}

export interface InvoiceTransport {
  request<T>(method: 'POST' | 'GET', path: string, body?: unknown): Promise<T>;
}

/**
 * `client.invoices` namespace.
 *
 * @example
 *   const invoice = await zp.invoices.create({
 *     amount_usd: 29,
 *     chain: 'base',
 *     metadata: { order_id: 'xyz' },
 *   });
 */
export class InvoicesResource {
  constructor(private readonly transport: InvoiceTransport) {}

  async create(input: CreateInvoiceInput): Promise<Invoice> {
    if (typeof input.amount_usd !== 'number' || !Number.isFinite(input.amount_usd) || input.amount_usd <= 0) {
      throw new Error('invoices.create: amount_usd must be a positive number');
    }
    if (!isSupportedChain(input.chain)) {
      throw new Error(
        `invoices.create: chain must be one of ${SUPPORTED_CHAINS.join(', ')} (got ${String(
          input.chain,
        )})`,
      );
    }
    const body: Record<string, unknown> = {
      amount_usd: input.amount_usd,
      chain: input.chain,
    };
    if (input.merchant_id !== undefined) body.merchant_id = input.merchant_id;
    if (input.ttl_seconds !== undefined) body.ttl_seconds = input.ttl_seconds;
    if (input.metadata !== undefined) body.metadata = input.metadata;
    return this.transport.request<Invoice>('POST', '/api/invoices', body);
  }

  async get(invoiceId: string): Promise<Invoice> {
    if (!invoiceId || typeof invoiceId !== 'string') {
      throw new Error('invoices.get: invoiceId is required');
    }
    return this.transport.request<Invoice>('GET', `/api/invoices/${encodeURIComponent(invoiceId)}`);
  }
}
