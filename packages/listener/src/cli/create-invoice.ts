// `zettapay-listener create-invoice` — allocate the next BIP-84 child
// address, persist a pending Invoice in the configured StorageAdapter, and
// print the address + BIP-21 URI for QR-code rendering.
//
// Flags:
//   --amount-sats <N>  Required. BTC amount in satoshis (positive integer).
//   --memo <s>         Optional label embedded in the BIP-21 URI.
//   --expires-in <s>   TTL in seconds. Default 3600 (1 hour).
//
// HR-WALLET-LESS: produces only a destination address. The listener never
// touches a signing key, even in runtime.
// HR-STORAGE-ADAPTER: writes via the same storage interface the watcher
// reads from, so a `zettapay-listener start` running in another shell will
// immediately pick the new invoice up.
// HR-PHONE-HOME: no network calls.

import { randomUUID } from 'node:crypto';
import { createStorage } from '../storage/index.js';
import { deriveBip84Address } from '../derive-bip84.js';
import {
  c,
  flagBool,
  flagString,
  parseFlags,
  validateXpubFormat,
  XpubFormatError,
} from './util.js';

export interface CreateInvoiceOptions {
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_EXPIRES_SECONDS = 3600;
const SATS_PER_BTC = 100_000_000;

function helpText(): string {
  return [
    `${c.bold('zettapay-listener create-invoice')} — allocate next address + persist invoice`,
    '',
    '  --amount-sats <N>   Required. Positive integer satoshis',
    '  --memo <s>          Optional label embedded in the BIP-21 URI',
    '  --expires-in <s>    TTL in seconds (default 3600)',
    '',
    'Output:',
    '  invoice_id, address, amount_sats, child_index, bip21_uri',
    '',
  ].join('\n');
}

function formatBtcAmount(sats: number): string {
  // Avoid scientific notation. Fixed-point with up to 8 decimals, trailing
  // zeros stripped (but not the integer side).
  const whole = Math.floor(sats / SATS_PER_BTC);
  const frac = sats % SATS_PER_BTC;
  if (frac === 0) return `${whole}`;
  const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

function buildBip21Uri(address: string, sats: number, memo?: string): string {
  const params: string[] = [];
  if (sats > 0) params.push(`amount=${formatBtcAmount(sats)}`);
  if (memo) params.push(`label=${encodeURIComponent(memo)}`);
  return params.length > 0
    ? `bitcoin:${address}?${params.join('&')}`
    : `bitcoin:${address}`;
}

export async function runCreateInvoice(
  argv: readonly string[],
  opts: CreateInvoiceOptions = {},
): Promise<number> {
  const { flags } = parseFlags(argv);
  if (flagBool(flags, 'help')) {
    process.stdout.write(helpText());
    return 0;
  }

  const env = opts.env ?? process.env;

  const amountRaw = flagString(flags, 'amount-sats');
  if (!amountRaw) {
    process.stderr.write(c.red('create-invoice: --amount-sats is required\n'));
    return 2;
  }
  const amountSats = Number.parseInt(amountRaw, 10);
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    process.stderr.write(c.red('create-invoice: --amount-sats must be a positive integer\n'));
    return 2;
  }

  const xpubRaw = env.MERCHANT_XPUB;
  if (!xpubRaw) {
    process.stderr.write(
      c.red('create-invoice: MERCHANT_XPUB missing. Run `zettapay-listener init` first.\n'),
    );
    return 2;
  }
  try {
    validateXpubFormat(xpubRaw);
  } catch (err) {
    const msg = err instanceof XpubFormatError ? err.message : (err as Error).message;
    process.stderr.write(c.red(`create-invoice: ${msg}\n`));
    return 2;
  }

  const memo = flagString(flags, 'memo');
  const expiresInRaw = flagString(flags, 'expires-in');
  let expiresInSeconds = DEFAULT_EXPIRES_SECONDS;
  if (expiresInRaw != null) {
    const n = Number.parseInt(expiresInRaw, 10);
    if (!Number.isInteger(n) || n <= 0) {
      process.stderr.write(c.red('create-invoice: --expires-in must be a positive integer\n'));
      return 2;
    }
    expiresInSeconds = n;
  }

  const storage = createStorage(env);
  try {
    const merchant = await storage.getMerchant(env.MERCHANT_ID ?? 'default');
    if (!merchant) {
      process.stderr.write(
        c.red(
          'create-invoice: no merchant found in storage. Run `zettapay-listener init` to seed one.\n',
        ),
      );
      return 1;
    }

    // Atomically allocate the next child index — this is the only place
    // next_child_index advances.
    const childIndex = await storage.nextChildIndex(merchant.id);
    const derived = deriveBip84Address({ xpub: merchant.xpub, index: childIndex });

    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    const invoice = await storage.createInvoice({
      id: `inv_${randomUUID()}`,
      merchant_id: merchant.id,
      chain: 'btc',
      asset: 'BTC',
      amount: formatBtcAmount(amountSats),
      address: derived.address,
      child_index: childIndex,
      expires_at: expiresAt,
    });

    const uri = buildBip21Uri(invoice.address, amountSats, memo);
    process.stdout.write(
      [
        `${c.bold('invoice_id:')}  ${invoice.id}`,
        `${c.bold('address:')}     ${invoice.address}`,
        `${c.dim('path:')}        ${derived.path}`,
        `${c.dim('network:')}     ${derived.network}`,
        `${c.dim('child_index:')} ${childIndex}`,
        `${c.dim('amount_sats:')} ${amountSats}`,
        `${c.dim('amount_btc:')}  ${invoice.amount}`,
        `${c.dim('expires_at:')}  ${expiresAt}`,
        memo ? `${c.dim('memo:')}        ${memo}` : null,
        '',
        `${c.bold('bip21_uri:')}   ${uri}`,
        '',
      ]
        .filter((s) => s !== null)
        .join('\n'),
    );
    return 0;
  } finally {
    if (storage.close) await storage.close();
  }
}
