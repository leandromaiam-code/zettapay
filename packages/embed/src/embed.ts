/**
 * Public entrypoint — `mount(target, config)` renders the embed into a
 * host element and wires up the on-chain payment poller.
 */
import { startPoller } from './poll.js';
import { RPC_URL, USDC_MINT } from './rpc.js';
import { render } from './ui.js';
import type {
  Cluster,
  EmbedConfig,
  EmbedErrorEvent,
  EmbedHandle,
  EmbedSuccessEvent,
} from './types.js';

const DEFAULT_QR = 'https://api.qrserver.com/v1/create-qr-code/?size=440x440&data=';
const DEFAULT_DECIMALS = 6;
const DEFAULT_INTERVAL_MS = 30_000;

export function mount(target: HTMLElement, config: EmbedConfig): EmbedHandle {
  const cluster: Cluster = config.cluster === 'devnet' ? 'devnet' : 'mainnet-beta';
  const decimals = config.decimals ?? DEFAULT_DECIMALS;
  const mint = config.mint ?? USDC_MINT[cluster];
  const rpcUrl = config.rpcUrl ?? RPC_URL[cluster];
  const qrRenderer = config.qrRenderer ?? DEFAULT_QR;
  const interval = config.pollIntervalMs ?? DEFAULT_INTERVAL_MS;

  const amountStr = String(config.amount);
  const amountBaseUnits = toBaseUnits(amountStr, decimals);
  if (amountBaseUnits <= 0n) {
    throw new Error('embed: amount must be greater than zero');
  }
  if (!config.recipient) {
    throw new Error('embed: recipient is required');
  }

  const payUri = buildSolanaPayUri({
    recipient: config.recipient,
    amount: amountStr,
    mint,
    reference: config.reference,
    label: config.label,
  });
  const qrUrl = qrRenderer + encodeURIComponent(payUri);

  const ui = render(target, {
    recipient: config.recipient,
    amount: amountStr,
    currency: config.mint ? 'TOKEN' : 'USDC',
    cluster,
    payUri,
    qrUrl,
    theme: config.theme ?? 'dark',
    label: config.label,
  });

  postMessage({
    source: 'zettapay-embed',
    type: 'ready',
    recipient: config.recipient,
    amount: amountStr,
  });

  const watchAddress = config.reference ?? config.recipient;
  const poller = startPoller({
    rpcUrl,
    watch: watchAddress,
    recipient: config.recipient,
    mint,
    amountBaseUnits,
    intervalMs: interval,
    onMatch: (signature, blockTime) => {
      ui.setStatus('Payment confirmed', 'success');
      const evt: EmbedSuccessEvent = { signature, blockTime };
      ui.root.dispatchEvent(
        new CustomEvent('zettapay:success', { detail: evt, bubbles: true }),
      );
      postMessage({
        source: 'zettapay-embed',
        type: 'success',
        signature,
        blockTime,
      });
      config.onSuccess?.(evt);
    },
    onError: (err) => {
      const evt: EmbedErrorEvent = { code: 'rpc-error', message: err.message };
      ui.setStatus('Reconnecting…', 'pending');
      ui.root.dispatchEvent(
        new CustomEvent('zettapay:error', { detail: evt, bubbles: true }),
      );
      postMessage({
        source: 'zettapay-embed',
        type: 'error',
        code: evt.code,
        message: evt.message,
      });
      config.onError?.(evt);
    },
  });

  return {
    destroy() {
      poller.stop();
      ui.root.remove();
    },
  };
}

function postMessage(msg: unknown): void {
  if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
    try {
      window.parent.postMessage(msg, '*');
    } catch {
      // cross-origin failures are non-fatal; the host can still use callbacks
    }
  }
}

interface PayUriParams {
  recipient: string;
  amount: string;
  mint: string;
  reference?: string;
  label?: string;
}

/**
 * Build a Solana Pay URL per the official spec
 * (https://docs.solanapay.com/spec). The QR encodes this string and
 * Phantom / Solflare deeplinks handle it on tap.
 */
export function buildSolanaPayUri(params: PayUriParams): string {
  const qs = new URLSearchParams();
  qs.set('amount', params.amount);
  qs.set('spl-token', params.mint);
  if (params.reference) qs.set('reference', params.reference);
  if (params.label) qs.set('label', params.label);
  return `solana:${params.recipient}?${qs.toString()}`;
}

/**
 * Convert a decimal string ("1.5", "0.25") to base units with the given
 * `decimals`. We avoid `Number` math entirely so 6-dp USDC stays exact
 * across 2^53+ values.
 */
export function toBaseUnits(amount: string, decimals: number): bigint {
  if (!/^[0-9]+(\.[0-9]+)?$/.test(amount)) {
    throw new Error(`embed: invalid amount "${amount}"`);
  }
  const [whole, frac = ''] = amount.split('.');
  if (frac.length > decimals) {
    throw new Error(`embed: amount has more precision than mint decimals`);
  }
  const padded = (frac + '0'.repeat(decimals - frac.length));
  const merged = (whole ?? '0').replace(/^0+(?=\d)/, '') + padded;
  return BigInt(merged.length === 0 ? '0' : merged);
}
