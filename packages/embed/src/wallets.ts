/**
 * Wallet-less wallet detection.
 *
 * ZettaPay never connects to a wallet. Customers pay from whichever wallet
 * they choose by scanning a QR code or tapping a `solana:` deep link — the
 * embed only inspects what wallet providers a browser exposes so it can
 * surface a more relevant "Open in <wallet>" affordance.
 *
 * Everything here is read-only:
 *
 *   - We probe injected globals (`window.phantom`, `window.solflare`, …)
 *     using *property reads only*. No method calls, no `connect()`, no
 *     `signMessage`, no `request()`. The wallet provider sees nothing.
 *
 *   - On mobile we never probe — we surface the canonical universal links
 *     each wallet publishes, so the customer can tap and the OS routes
 *     them into their wallet of choice.
 *
 * The Solana Pay URI itself (`solana:<recipient>?…`) is the universal
 * fallback. It's already registered as a system handler on iOS/Android
 * and works with every wallet listed below.
 */
import type { WalletDetection, WalletId, WalletMeta } from './types.js';

/**
 * Canonical metadata for every wallet we surface. Order here is the order
 * we render in the UI when none of them is detected as installed — Phantom
 * is the de-facto reference Solana wallet so it leads.
 */
export const WALLETS: readonly WalletMeta[] = [
  {
    id: 'phantom',
    name: 'Phantom',
    installUrl: 'https://phantom.app/download',
    brand: '#ab9ff2',
  },
  {
    id: 'solflare',
    name: 'Solflare',
    installUrl: 'https://solflare.com/download',
    brand: '#fc7227',
  },
  {
    id: 'backpack',
    name: 'Backpack',
    installUrl: 'https://backpack.app/downloads',
    brand: '#e33e3f',
  },
  {
    id: 'glow',
    name: 'Glow',
    installUrl: 'https://glow.app/download',
    brand: '#9945ff',
  },
  {
    id: 'trust',
    name: 'Trust',
    installUrl: 'https://trustwallet.com/download',
    brand: '#0500ff',
  },
  {
    id: 'coinbase',
    name: 'Coinbase Wallet',
    installUrl: 'https://www.coinbase.com/wallet/downloads',
    brand: '#0052ff',
  },
];

const WALLETS_BY_ID = new Map<WalletId, WalletMeta>(WALLETS.map((w) => [w.id, w]));

export function getWalletMeta(id: WalletId): WalletMeta | undefined {
  return WALLETS_BY_ID.get(id);
}

/**
 * Heuristic mobile check. Conservative on purpose — false positives just
 * mean we show universal-link buttons that still work on desktop, while
 * false negatives mean we miss the chance to deep-link.
 */
export function isMobile(userAgent?: string): boolean {
  const ua = userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  if (!ua) return false;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
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

/**
 * Inspect injected wallet providers. Read-only — every check is a property
 * lookup, never a method call. Pass a custom `globals` for unit tests so
 * we don't have to mutate the real `window`.
 *
 * Returns the list of wallets whose provider is present, the canonical
 * Solana-wallet-standard discovery isn't invoked (no event dispatch), and
 * a mobile flag derived from the user agent.
 */
export function detectWallets(globals?: DetectionWindow): WalletDetection {
  const g: DetectionWindow =
    globals ?? (typeof window !== 'undefined' ? (window as unknown as DetectionWindow) : {});
  const installed: WalletId[] = [];

  // `window.phantom.solana.isPhantom` is Phantom's documented detection
  // surface; the legacy `window.solana.isPhantom` is still set on older
  // installs. Either signal counts.
  if (g.phantom?.solana?.isPhantom === true || g.solana?.isPhantom === true) {
    installed.push('phantom');
  }
  if (g.solflare?.isSolflare === true) {
    installed.push('solflare');
  }
  // Backpack injects both `window.backpack` and the xNFT global on its
  // newer builds; we accept either.
  if (g.backpack?.isBackpack === true || g.xnft !== undefined) {
    installed.push('backpack');
  }
  if (g.glow !== undefined || g.glowSolana !== undefined) {
    installed.push('glow');
  }
  // Trust ships a Solana provider only when the user enabled the Solana
  // network in-app; we only flag it when that provider is present.
  if (g.trustwallet?.solana !== undefined || g.trustWallet?.solana !== undefined) {
    installed.push('trust');
  }
  if (g.coinbaseSolana !== undefined || g.coinbaseWalletExtension !== undefined) {
    installed.push('coinbase');
  }

  const ua = globals?.navigator?.userAgent;
  return { installed, isMobile: isMobile(ua) };
}

/**
 * Build a wallet-specific deep link for opening `solanaPayUri` in a chosen
 * wallet. The customer still signs in their own wallet — we never receive
 * the signature or any private state.
 *
 * For Solana Pay flows the universal `solana:` URI is the most robust
 * handler on mobile, so wallets without a dedicated Solana Pay deep-link
 * spec just round-trip back to the original URI. Desktop callers should
 * fall back to copy-paste when no universal link is published.
 */
export function buildWalletDeeplink(
  wallet: WalletId,
  solanaPayUri: string,
  opts?: { dappUrl?: string },
): string {
  const encoded = encodeURIComponent(solanaPayUri);
  const ref = opts?.dappUrl ? encodeURIComponent(opts.dappUrl) : '';
  switch (wallet) {
    case 'phantom':
      // Phantom universal link wraps any URL and opens it in their in-app
      // browser; pasting a `solana:` URI surfaces the transfer prompt.
      return ref
        ? `https://phantom.app/ul/browse/${encoded}?ref=${ref}`
        : `https://phantom.app/ul/browse/${encoded}`;
    case 'solflare':
      return `https://solflare.com/ul/v1/browse/${encoded}`;
    case 'backpack':
      // Backpack registers `solana:` natively on mobile; on desktop the
      // extension picks it up from the QR scan, so the URI alone is the
      // most reliable cross-surface link.
      return solanaPayUri;
    case 'glow':
    case 'trust':
      // No public universal-link spec for Solana Pay invoices; rely on
      // the OS-level `solana:` handler.
      return solanaPayUri;
    case 'coinbase':
      // Coinbase Wallet exposes a generic dapp deep link that accepts a
      // target URL via the `cb_url` query parameter.
      return `https://go.cb-w.com/dapp?cb_url=${encoded}`;
  }
}
