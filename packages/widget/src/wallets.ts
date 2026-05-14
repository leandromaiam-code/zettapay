/**
 * Read-only wallet detection for the widget modal.
 *
 * ZettaPay never calls `connect()`. The widget's role is only to surface
 * the most relevant "Open in <wallet>" universal link for whichever wallet
 * the customer already has installed, plus a generic copy-link fallback.
 *
 * Detection paths (both read-only, no method invocation on the wallet):
 *   - Legacy window-property heuristics for older wallet builds.
 *   - Solana wallet-standard `register-wallet` event for modern builds.
 *
 * The widget mirrors `@zettapay/embed`'s detection — duplicated on purpose
 * so the widget keeps its zero-dependency CDN bundle profile and the two
 * packages can ship independently. Keep the wallet ids and the canonical
 * order in sync with `packages/embed/src/wallets.ts`.
 */

export type WalletId =
  | 'phantom'
  | 'solflare'
  | 'backpack'
  | 'glow'
  | 'trust'
  | 'coinbase';

export interface WalletMeta {
  id: WalletId;
  name: string;
  installUrl: string;
}

export const WIDGET_WALLETS: readonly WalletMeta[] = [
  { id: 'phantom', name: 'Phantom', installUrl: 'https://phantom.app/download' },
  { id: 'solflare', name: 'Solflare', installUrl: 'https://solflare.com/download' },
  { id: 'backpack', name: 'Backpack', installUrl: 'https://backpack.app/downloads' },
  { id: 'glow', name: 'Glow', installUrl: 'https://glow.app/download' },
  { id: 'trust', name: 'Trust', installUrl: 'https://trustwallet.com/download' },
  { id: 'coinbase', name: 'Coinbase', installUrl: 'https://www.coinbase.com/wallet/downloads' },
];

export interface WalletDetection {
  installed: WalletId[];
  isMobile: boolean;
}

interface DetectionWindow {
  phantom?: { solana?: { isPhantom?: unknown } };
  solana?: { isPhantom?: unknown };
  solflare?: { isSolflare?: unknown };
  backpack?: { isBackpack?: unknown };
  xnft?: unknown;
  glow?: unknown;
  glowSolana?: unknown;
  trustwallet?: { solana?: unknown };
  trustWallet?: { solana?: unknown };
  coinbaseSolana?: unknown;
  coinbaseWalletExtension?: unknown;
  navigator?: { userAgent?: string };
}

export function isMobile(userAgent?: string): boolean {
  const ua = userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  if (!ua) return false;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
}

interface WalletStandardWallet {
  name?: unknown;
}

const NAME_MATCHERS: ReadonlyArray<{ id: WalletId; needle: string }> = [
  { id: 'phantom', needle: 'phantom' },
  { id: 'solflare', needle: 'solflare' },
  { id: 'backpack', needle: 'backpack' },
  { id: 'glow', needle: 'glow' },
  { id: 'trust', needle: 'trust' },
  { id: 'coinbase', needle: 'coinbase' },
];

/**
 * Dispatch `wallet-standard:app-ready` and collect every wallet that
 * registers itself in response. Synchronous, read-only — we only look at
 * each wallet's `name`, never call `features['standard:connect'].connect`
 * or any other method.
 */
export function discoverWalletStandard(target?: EventTarget): WalletId[] {
  const bus = target ?? (typeof window !== 'undefined' ? window : undefined);
  if (!bus || typeof (bus as EventTarget).dispatchEvent !== 'function') return [];

  const seen = new Set<WalletId>();
  const register = (wallet: WalletStandardWallet): undefined => {
    if (!wallet || typeof wallet.name !== 'string') return;
    const haystack = wallet.name.toLowerCase();
    for (const m of NAME_MATCHERS) {
      if (haystack.includes(m.needle)) {
        seen.add(m.id);
        return undefined;
      }
    }
    return undefined;
  };

  let evt: Event;
  try {
    evt = new CustomEvent('wallet-standard:app-ready', { detail: { register } });
  } catch {
    const e = new Event('wallet-standard:app-ready') as Event & {
      detail?: { register: typeof register };
    };
    e.detail = { register };
    evt = e;
  }
  try {
    bus.dispatchEvent(evt);
  } catch {
    // Hostile listeners can throw — keep whatever registered before.
  }
  return Array.from(seen);
}

export function detectWallets(
  globals?: DetectionWindow,
  walletStandardTarget?: EventTarget | false,
): WalletDetection {
  const g: DetectionWindow =
    globals ?? (typeof window !== 'undefined' ? (window as unknown as DetectionWindow) : {});
  const found = new Set<WalletId>();

  if (g.phantom?.solana?.isPhantom === true || g.solana?.isPhantom === true) {
    found.add('phantom');
  }
  if (g.solflare?.isSolflare === true) found.add('solflare');
  if (g.backpack?.isBackpack === true || g.xnft !== undefined) found.add('backpack');
  if (g.glow !== undefined || g.glowSolana !== undefined) found.add('glow');
  if (g.trustwallet?.solana !== undefined || g.trustWallet?.solana !== undefined) {
    found.add('trust');
  }
  if (g.coinbaseSolana !== undefined || g.coinbaseWalletExtension !== undefined) {
    found.add('coinbase');
  }

  if (walletStandardTarget !== false) {
    for (const id of discoverWalletStandard(walletStandardTarget || undefined)) {
      found.add(id);
    }
  }

  const installed = WIDGET_WALLETS.filter((w) => found.has(w.id)).map((w) => w.id);
  const ua = globals?.navigator?.userAgent;
  return { installed, isMobile: isMobile(ua) };
}

/**
 * Build a wallet-specific universal link that opens the hosted checkout
 * URL inside the chosen wallet's in-app browser. The customer signs the
 * transfer entirely within their own wallet — we never receive any
 * signature material. Wallets without a published universal-browse spec
 * (Backpack, Glow, Trust) fall back to returning the checkout URL itself,
 * which the OS-level `https://` handler still routes correctly.
 */
export function buildWalletBrowseLink(wallet: WalletId, checkoutUrl: string): string {
  const encoded = encodeURIComponent(checkoutUrl);
  let origin = '';
  try {
    origin = new URL(checkoutUrl).origin;
  } catch {
    origin = '';
  }
  const ref = origin ? encodeURIComponent(origin) : '';

  switch (wallet) {
    case 'phantom':
      return ref
        ? `https://phantom.app/ul/browse/${encoded}?ref=${ref}`
        : `https://phantom.app/ul/browse/${encoded}`;
    case 'solflare':
      return `https://solflare.com/ul/v1/browse/${encoded}`;
    case 'coinbase':
      return `https://go.cb-w.com/dapp?cb_url=${encoded}`;
    case 'backpack':
    case 'glow':
    case 'trust':
      return checkoutUrl;
  }
}
