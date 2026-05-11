/**
 * Solana Pay URI scheme + QR generator (Z27.3).
 *
 * Two URI flavours ship side-by-side:
 *
 *  1. The canonical ZettaPay scheme — `zettapay:invoice/<pda>?amount=29&currency=USDC`
 *     keyed on the deterministic invoice PDA. Used by ZettaPay-aware wallets
 *     and the embed.js polling client; the PDA alone is enough to look up
 *     status without trusting the page.
 *
 *  2. The Solana Pay transfer-request scheme (`solana:<recipient>?...`) per
 *     the spec at https://docs.solanapay.com/spec — emitted alongside so any
 *     wallet (Phantom, Solflare, Backpack, Glow, …) that already speaks
 *     Solana Pay can settle the same invoice without app-specific code.
 *
 * Pair either URI with {@link generateInvoiceQrSvg} or
 * {@link generateInvoiceQrDataUrl} to render the QR a payer scans.
 */
import { PublicKey } from '@solana/web3.js';
import QRCode, {
  type QRCodeToDataURLOptions,
  type QRCodeToStringOptions,
} from 'qrcode';

/** URI scheme for ZettaPay-aware wallets. */
export const ZETTAPAY_URI_SCHEME = 'zettapay';
/** URI scheme defined by the Solana Pay spec. */
export const SOLANA_PAY_URI_SCHEME = 'solana';
/** Default currency symbol — V1 ships USDC only (premissa I.2). */
export const DEFAULT_CURRENCY = 'USDC';

// ---------------------------------------------------------------------------
// ZettaPay URI — proprietary scheme keyed on the invoice PDA
// ---------------------------------------------------------------------------

export interface BuildZettaPayUriParams {
  /**
   * The deterministic invoice PDA (Z26) as a base58 string or a
   * `PublicKey`. Becomes the only path segment — `zettapay:invoice/<pda>`.
   */
  invoicePda: string | PublicKey;
  /**
   * Human-readable amount (e.g. `"29"`, `"1.5"`). Encoded verbatim — the
   * Solana Pay spec accepts decimal strings, not base units, so payers see
   * the same number their wallet quotes them.
   */
  amount?: string | number | bigint;
  /** Currency symbol. Defaults to `"USDC"`. */
  currency?: string;
  /** Optional label surfaced by wallets ("Acme Coffee"). */
  label?: string;
  /** Optional human-readable message ("Order #4421"). */
  message?: string;
  /** Optional memo persisted alongside the on-chain transfer. */
  memo?: string;
}

function normaliseAmount(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('amount must be a finite number');
    }
    return value.toString(10);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('amount must be a non-empty decimal string');
  }
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`amount "${value}" is not a valid decimal`);
  }
  return trimmed;
}

function assertPositiveAmount(amount: string): void {
  if (amount.startsWith('-') || /^0+(\.0+)?$/.test(amount)) {
    throw new Error('amount must be strictly greater than zero');
  }
}

function toBase58(value: string | PublicKey): string {
  if (typeof value === 'string') {
    // Round-trip validation: PublicKey throws for malformed input.
    return new PublicKey(value).toBase58();
  }
  return value.toBase58();
}

function appendParam(
  params: URLSearchParams,
  key: string,
  value: string | undefined,
): void {
  if (value === undefined || value === '') return;
  params.append(key, value);
}

/**
 * Build the canonical ZettaPay URI for an invoice. Compatible with the
 * embed.js scanner and any future ZettaPay-native wallet integration.
 *
 * @example
 *   buildZettaPayUri({ invoicePda, amount: 29 })
 *   // => "zettapay:invoice/8x...?amount=29&currency=USDC"
 */
export function buildZettaPayUri(params: BuildZettaPayUriParams): string {
  const pda = toBase58(params.invoicePda);
  const currency = (params.currency ?? DEFAULT_CURRENCY).trim();
  if (currency.length === 0) {
    throw new Error('currency must not be empty');
  }

  const search = new URLSearchParams();
  if (params.amount !== undefined) {
    const amount = normaliseAmount(params.amount);
    assertPositiveAmount(amount);
    search.append('amount', amount);
  }
  search.append('currency', currency);
  appendParam(search, 'label', params.label);
  appendParam(search, 'message', params.message);
  appendParam(search, 'memo', params.memo);

  return `${ZETTAPAY_URI_SCHEME}:invoice/${pda}?${search.toString()}`;
}

export interface ParsedZettaPayUri {
  invoicePda: string;
  amount: string | null;
  currency: string;
  label: string | null;
  message: string | null;
  memo: string | null;
}

/**
 * Parse a ZettaPay URI back into its component fields. Throws on any
 * structural violation — callers should treat a thrown error as an
 * untrusted/corrupt URI.
 */
export function parseZettaPayUri(uri: string): ParsedZettaPayUri {
  const colon = uri.indexOf(':');
  if (colon === -1) {
    throw new Error('zettapay URI must contain a scheme delimiter');
  }
  const scheme = uri.slice(0, colon).toLowerCase();
  if (scheme !== ZETTAPAY_URI_SCHEME) {
    throw new Error(
      `expected scheme "${ZETTAPAY_URI_SCHEME}", got "${scheme}"`,
    );
  }
  const rest = uri.slice(colon + 1);
  const queryIdx = rest.indexOf('?');
  const path = queryIdx === -1 ? rest : rest.slice(0, queryIdx);
  const query = queryIdx === -1 ? '' : rest.slice(queryIdx + 1);

  const slash = path.indexOf('/');
  if (slash === -1) {
    throw new Error('zettapay URI must have shape "zettapay:invoice/<pda>"');
  }
  const resource = path.slice(0, slash);
  if (resource !== 'invoice') {
    throw new Error(
      `unsupported zettapay resource "${resource}" — expected "invoice"`,
    );
  }
  const pdaStr = path.slice(slash + 1);
  if (pdaStr.length === 0) {
    throw new Error('zettapay URI is missing the invoice PDA');
  }
  const invoicePda = new PublicKey(pdaStr).toBase58();

  const search = new URLSearchParams(query);
  return {
    invoicePda,
    amount: search.get('amount'),
    currency: search.get('currency') ?? DEFAULT_CURRENCY,
    label: search.get('label'),
    message: search.get('message'),
    memo: search.get('memo'),
  };
}

// ---------------------------------------------------------------------------
// Solana Pay URI — wallet-compatible transfer request
// ---------------------------------------------------------------------------

export interface BuildSolanaPayUriParams {
  /**
   * Recipient — the merchant's main wallet pubkey (NOT an ATA). The spec
   * requires a wallet/system account; the wallet derives the SPL token
   * account from `splToken`.
   */
  recipient: string | PublicKey;
  /** Decimal amount in human units (e.g. `"29"`). */
  amount?: string | number | bigint;
  /** SPL mint — pass the USDC mint to settle in USDC. */
  splToken?: string | PublicKey;
  /**
   * One or more reference pubkeys appended to the transfer. The invoice
   * PDA is the canonical reference so the merchant can correlate
   * settlement back to the invoice off-chain.
   */
  reference?: ReadonlyArray<string | PublicKey>;
  label?: string;
  message?: string;
  memo?: string;
}

/**
 * Build a standard Solana Pay transfer-request URI per
 * https://docs.solanapay.com/spec. Any Solana Pay-aware wallet (Phantom,
 * Solflare, Backpack, Glow…) can scan the resulting QR and settle.
 *
 * Use this in tandem with {@link buildZettaPayUri}: render the ZettaPay
 * URI in QR for ZettaPay-native flows, fall back to the Solana Pay URI
 * for generic wallets.
 */
export function buildSolanaPayUri(params: BuildSolanaPayUriParams): string {
  const recipient = toBase58(params.recipient);
  const search = new URLSearchParams();
  if (params.amount !== undefined) {
    const amount = normaliseAmount(params.amount);
    assertPositiveAmount(amount);
    search.append('amount', amount);
  }
  if (params.splToken !== undefined) {
    search.append('spl-token', toBase58(params.splToken));
  }
  if (params.reference) {
    for (const ref of params.reference) {
      search.append('reference', toBase58(ref));
    }
  }
  appendParam(search, 'label', params.label);
  appendParam(search, 'message', params.message);
  appendParam(search, 'memo', params.memo);

  const qs = search.toString();
  return qs.length > 0
    ? `${SOLANA_PAY_URI_SCHEME}:${recipient}?${qs}`
    : `${SOLANA_PAY_URI_SCHEME}:${recipient}`;
}

// ---------------------------------------------------------------------------
// QR generation — backed by the `qrcode` library
// ---------------------------------------------------------------------------

export interface InvoiceQrOptions {
  /** Pixel width (square). Defaults to 256 — large enough for phone scans. */
  size?: number;
  /** Quiet-zone margin in modules. Defaults to 1 (qrcode lib default is 4). */
  margin?: number;
  /**
   * Error-correction level. `M` covers ~15% of code damage and is the
   * sweet spot for ZettaPay's matte print + brass logo overlays. Use `H`
   * (~30%) when overlaying a centred brand mark.
   */
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  /** Foreground colour as a `#RRGGBB[AA]` hex string. */
  dark?: string;
  /** Background colour as a `#RRGGBB[AA]` hex string. */
  light?: string;
}

function buildStringOptions(opts: InvoiceQrOptions): QRCodeToStringOptions {
  return {
    type: 'svg',
    width: opts.size ?? 256,
    margin: opts.margin ?? 1,
    errorCorrectionLevel: opts.errorCorrectionLevel ?? 'M',
    color: {
      dark: opts.dark ?? '#0a1612',
      light: opts.light ?? '#f5e6c8',
    },
  };
}

function buildDataUrlOptions(opts: InvoiceQrOptions): QRCodeToDataURLOptions {
  return {
    type: 'image/png',
    width: opts.size ?? 256,
    margin: opts.margin ?? 1,
    errorCorrectionLevel: opts.errorCorrectionLevel ?? 'M',
    color: {
      dark: opts.dark ?? '#0a1612',
      light: opts.light ?? '#f5e6c8',
    },
  };
}

/**
 * Render the supplied URI as an inline SVG QR code. SVG scales crisply
 * at any DPI and embeds cleanly inside server-rendered HTML.
 */
export function generateInvoiceQrSvg(
  uri: string,
  options: InvoiceQrOptions = {},
): Promise<string> {
  if (uri.length === 0) {
    return Promise.reject(new Error('uri must be non-empty'));
  }
  return QRCode.toString(uri, buildStringOptions(options));
}

/**
 * Render the supplied URI as a PNG data-URL. Useful when embedding in
 * `<img src>` or piping into a PDF receipt generator.
 */
export function generateInvoiceQrDataUrl(
  uri: string,
  options: InvoiceQrOptions = {},
): Promise<string> {
  if (uri.length === 0) {
    return Promise.reject(new Error('uri must be non-empty'));
  }
  return QRCode.toDataURL(uri, buildDataUrlOptions(options));
}
