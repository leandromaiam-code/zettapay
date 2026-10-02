/**
 * Wire types for the current ZettaPay HTTP API — the self-hosted listener
 * (`POST /invoice`, `GET /invoice/:id`, `GET /health`) and ZettaPay Cloud (the
 * same routes under `/api/v1`). Field names are the ones the servers return;
 * nothing is renamed or re-cased by the SDK.
 */

/** Chain stored on an invoice. The supported product surface is `btc` and `base`. */
export type ZettaPayChain = 'btc' | 'base' | 'polygon' | 'eth';

export type ZettaPayInvoiceStatus = 'pending' | 'partial' | 'confirmed' | 'expired' | 'failed';

/** Stablecoin accepted on Base. */
export type BaseAsset = 'usdc' | 'usdt';

/** Fields present on every invoice, on create and on read. */
export interface ZettaPayInvoice {
  invoice_id: string;
  merchant_id: string;
  chain: ZettaPayChain;
  /** `BTC`, `USDC` or `USDT`. */
  asset: string;
  /**
   * The stored invoice amount. For BTC this is the decimal BTC amount. For
   * stablecoin invoices the server puts the integer token base units here —
   * read `amount_usdc` / `amount_usdc_units` instead.
   */
  amount_btc: string;
  /** On-chain address the payer sends to. */
  receive_address: string;
  /** HD child index for xpub-derived addresses; `null` in fixed-address mode. */
  child_index: number | null;
  status: ZettaPayInvoiceStatus;
  tx_hash: string | null;
  paid_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  /** Stablecoin invoices only: amount in 6-decimal base units. */
  amount_usdc_units?: number;
  /** Stablecoin invoices only: decimal amount the payer must send, e.g. `"29.000042"`. */
  amount_usdc?: string;
}

/** Response of creating a BTC invoice. */
export interface BtcInvoiceCreated extends ZettaPayInvoice {
  chain: 'btc';
  derivation_path: string;
  network: 'mainnet' | 'testnet';
  amount_sats: number;
  /** BIP-21 payment URI — render it as a QR code. */
  qr_uri: string;
  /** Block-explorer link for the receive address. */
  verify_url: string;
  /** Hosted checkout link. Cloud only, and only when the service has a checkout origin configured. */
  checkout_url?: string;
}

/** Response of creating a USDC/USDT invoice on Base. */
export interface BaseInvoiceCreated extends ZettaPayInvoice {
  amount_usd: number;
  amount_usdc: string;
  amount_usdc_units: number;
  /** EIP-681 payment URI — render it as a QR code. */
  qr_uri: string;
  /** Present in xpub mode (one derived address per invoice). */
  derivation_path?: string;
  /** Block-explorer link for the receive address. Present in xpub mode. */
  verify_url?: string;
  /** Present in fixed-address mode (one shared address, nonce in the low decimals). */
  mode?: 'fixed-address';
  /** Fixed-address mode: the per-invoice nonce encoded in the amount. */
  nonce?: number;
  /** Fixed-address mode: ERC-20 contract the payer must send. */
  token_address?: string;
  /** Hosted checkout link. Cloud only, and only when the service has a checkout origin configured. */
  checkout_url?: string;
}

export interface CreateBtcInvoiceInput {
  /** Amount in satoshis — a positive integer. */
  amountSats: number;
  /** Optional label (truncated to 200 chars by the server), surfaced in the BIP-21 URI. */
  memo?: string;
  /** Invoice TTL in seconds. Honoured by the self-hosted listener; Cloud ignores it. */
  expiresInSeconds?: number;
}

export interface CreateBaseInvoiceInput {
  /** Amount in USD — a positive number. */
  amountUsd: number;
  /**
   * Stablecoin to charge. Defaults to `usdc`. `usdt` is only served in
   * fixed-address mode; the client rejects a response whose asset differs from
   * the one requested (see `asset_mismatch`).
   */
  asset?: BaseAsset;
  /** Invoice TTL in seconds. Honoured by the self-hosted listener in xpub mode only. */
  expiresInSeconds?: number;
}

/** `GET /health` on the self-hosted listener. */
export interface ListenerHealth {
  /** Mirrors `ws_connected`. */
  ok: boolean;
  ws_connected: boolean;
  subscribed_count: number;
  /** Epoch milliseconds of the last chain event, or `null`. */
  last_event_at: number | null;
  last_block_height: number | null;
  uptime_s: number;
}

/** `GET /api/v1/health` on ZettaPay Cloud. */
export interface CloudHealth {
  ok: boolean;
  service: string;
  /** ISO-8601 server time. */
  ts: string;
}

export type ZettaPayHealth = ListenerHealth | CloudHealth;

/** Error envelope both servers use: `{ error: { code, message? , ...extra } }`. */
export interface ZettaPayApiErrorBody {
  error: {
    code: string;
    message?: string;
    [extra: string]: unknown;
  };
}
