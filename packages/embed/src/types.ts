/**
 * Public types for `@zettapay/embed`. The lean embed.js is a separate
 * artifact from `@zettapay/widget`: it talks directly to Solana public
 * RPC, has no backend dependency, and ships in a ~5 KB bundle.
 */

export type Cluster = 'mainnet-beta' | 'devnet';

export interface EmbedConfig {
  /**
   * Recipient SPL token account (base58). For Z26 invoices, this is the
   * ATA owned by the deterministic invoice PDA. Funds land here when the
   * payer settles.
   */
  recipient: string;

  /**
   * Amount in human units (e.g. `10.5` for 10.50 USDC). Converted to
   * base units using `decimals` (default 6 for USDC).
   */
  amount: number | string;

  /**
   * Solana Pay reference key (base58). The payer must include this key
   * as a read-only account on the transfer instruction so embed.js can
   * locate the settlement signature via `getSignaturesForAddress`.
   *
   * When omitted, the embed falls back to watching the recipient ATA
   * directly — works, but is noisier on busy accounts.
   */
  reference?: string;

  /** SPL mint base58. Defaults to canonical USDC for the chosen cluster. */
  mint?: string;

  /** Token decimals. Defaults to 6 (USDC). */
  decimals?: number;

  /**
   * Solana cluster. Drives the default RPC endpoint and the default
   * USDC mint. Ignored if `rpcUrl` is explicit.
   */
  cluster?: Cluster;

  /** Explicit RPC endpoint. Overrides the cluster default. */
  rpcUrl?: string;

  /** Polling interval in ms. Default 30000 (30 s) per Z27 spec. */
  pollIntervalMs?: number;

  /**
   * QR rendering endpoint. The embed forms `${qrRenderer}${urlencoded payload}`
   * and assigns it to an `<img>` src. Default is a public QR API; pass a
   * self-hosted renderer for stricter privacy.
   */
  qrRenderer?: string;

  /** Optional UI theme. `dark` is the default and matches the ZettaPay brand. */
  theme?: 'dark' | 'light';

  /** Optional memo to surface in the QR payload (Solana Pay `message`). */
  label?: string;

  /** Callback fired when a settlement signature is confirmed on-chain. */
  onSuccess?: (event: EmbedSuccessEvent) => void;

  /** Callback fired on terminal failure (RPC, validation, etc.). */
  onError?: (event: EmbedErrorEvent) => void;
}

export interface EmbedSuccessEvent {
  /** Confirmed transaction signature (base58). */
  signature: string;
  /** Block time in unix seconds, when available. */
  blockTime: number | null;
}

export interface EmbedErrorEvent {
  code: 'rpc-error' | 'validation' | 'unsupported';
  message: string;
}

export interface EmbedHandle {
  /** Stop polling and remove the rendered DOM. */
  destroy(): void;
}

/**
 * `postMessage` shape. The `source` discriminator lets iframe parents
 * filter foreign traffic safely.
 */
export type EmbedPostMessage =
  | { source: 'zettapay-embed'; type: 'ready'; recipient: string; amount: string }
  | { source: 'zettapay-embed'; type: 'success'; signature: string; blockTime: number | null }
  | { source: 'zettapay-embed'; type: 'error'; code: EmbedErrorEvent['code']; message: string };
