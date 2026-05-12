/**
 * `@zettapay/embed` — lean ~5 KB drop-in that reads Solana on-chain
 * invoices via public RPC, renders a QR + address, and polls every
 * 30 s for settlement. Zero runtime dependencies.
 *
 * Two consumption modes:
 *
 *   1. Drop-in `<script>` with `data-recipient` + `data-amount` — the
 *      script auto-discovers itself and renders the embed right after
 *      its own tag.
 *
 *   2. Programmatic `mount(target, config)` for SPA frameworks that
 *      prefer JS wiring.
 */
import { mount } from './embed.js';
import type { EmbedConfig } from './types.js';

const VERSION = (globalThis.__ZETTAPAY_EMBED_VERSION__ ?? 'dev') as string;

export { mount };
export { buildSolanaPayUri, toBaseUnits } from './embed.js';
export { matchesTransfer } from './poll.js';
export { RPC_URL, USDC_MINT } from './rpc.js';
export {
  WALLETS,
  buildWalletDeeplink,
  detectWallets,
  getWalletMeta,
  isMobile,
} from './wallets.js';
export type {
  Cluster,
  EmbedConfig,
  EmbedSuccessEvent,
  EmbedErrorEvent,
  EmbedHandle,
  EmbedPostMessage,
  WalletDetection,
  WalletId,
  WalletMeta,
} from './types.js';
export const version = VERSION;

function readConfigFromScript(el: HTMLScriptElement): EmbedConfig | null {
  const ds = el.dataset;
  const recipient = ds.recipient;
  const amountRaw = ds.amount;
  if (!recipient || !amountRaw) return null;
  const cluster = ds.cluster === 'devnet' ? 'devnet' : 'mainnet-beta';
  const cfg: EmbedConfig = {
    recipient,
    amount: amountRaw,
    cluster,
  };
  if (ds.reference) cfg.reference = ds.reference;
  if (ds.mint) cfg.mint = ds.mint;
  if (ds.decimals) {
    const dec = Number(ds.decimals);
    if (Number.isFinite(dec) && dec >= 0) cfg.decimals = dec;
  }
  if (ds.rpcUrl) cfg.rpcUrl = ds.rpcUrl;
  if (ds.qrRenderer) cfg.qrRenderer = ds.qrRenderer;
  if (ds.theme === 'light' || ds.theme === 'dark') cfg.theme = ds.theme;
  if (ds.label) cfg.label = ds.label;
  if (ds.pollIntervalMs) {
    const ms = Number(ds.pollIntervalMs);
    if (Number.isFinite(ms) && ms >= 1000) cfg.pollIntervalMs = ms;
  }
  return cfg;
}

function autoInit(): void {
  if (typeof document === 'undefined') return;
  const scripts = document.querySelectorAll<HTMLScriptElement>(
    'script[data-recipient][data-amount]:not([data-zettapay-embed-mounted])',
  );
  scripts.forEach((script) => {
    const cfg = readConfigFromScript(script);
    if (!cfg) return;
    script.setAttribute('data-zettapay-embed-mounted', '');
    const target = document.createElement('div');
    target.setAttribute('data-zettapay-embed-target', '');
    script.parentNode?.insertBefore(target, script.nextSibling);
    try {
      mount(target, cfg);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[zettapay-embed] auto-init failed:', (e as Error).message);
    }
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit, { once: true });
  } else {
    autoInit();
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __ZETTAPAY_EMBED_VERSION__: string | undefined;
}
