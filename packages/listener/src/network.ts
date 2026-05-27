// Bitcoin network selector for @zettapay/listener.
//
// One env var (`MERCHANT_NETWORK`) decides which mempool.space cluster the
// watcher talks to and which address HRP is expected from BIP-84 derivation.
// Same code path runs against mainnet, signet, testnet, and regtest — the
// only difference between a "test before mainnet" run and the real thing is
// the value of this enum.
//
// HR-PHONE-HOME: every URL referenced here is mempool.space (or the operator's
// own local electrs for regtest). No zettapay.* endpoint appears.

export type Network = 'mainnet' | 'testnet' | 'signet' | 'regtest';

export interface NetworkProfile {
  /** mempool.space WebSocket endpoint for this network. */
  ws: string;
  /** mempool.space REST base for this network (used for backfill + confirm advance). */
  rest: string;
  /** Bech32 HRP prefix that any derived BIP-84 address must start with. */
  addressPrefix: 'bc1' | 'tb1' | 'bcrt1';
  /** SLIP-0044 coin type for BIP-44 path validation. mainnet=0, all test variants=1. */
  bip84Coin: 0 | 1;
  /** True for live BTC. The README / verify-config gate confirms-before-arming on this. */
  isMainnet: boolean;
}

/**
 * Network → endpoints + address contract. Regtest URLs can be overridden via
 * REGTEST_WS_URL / REGTEST_REST_URL because there is no canonical public
 * mempool.space regtest cluster — operators run their own electrs.
 */
export function getNetworkConfig(
  network: Network,
  env: NodeJS.ProcessEnv = process.env,
): NetworkProfile {
  switch (network) {
    case 'mainnet':
      return {
        ws: 'wss://mempool.space/api/v1/ws',
        rest: 'https://mempool.space/api',
        addressPrefix: 'bc1',
        bip84Coin: 0,
        isMainnet: true,
      };
    case 'testnet':
      return {
        ws: 'wss://mempool.space/testnet/api/v1/ws',
        rest: 'https://mempool.space/testnet/api',
        addressPrefix: 'tb1',
        bip84Coin: 1,
        isMainnet: false,
      };
    case 'signet':
      return {
        ws: 'wss://mempool.space/signet/api/v1/ws',
        rest: 'https://mempool.space/signet/api',
        addressPrefix: 'tb1',
        bip84Coin: 1,
        isMainnet: false,
      };
    case 'regtest':
      return {
        ws: env.REGTEST_WS_URL?.trim() || 'ws://localhost:50001',
        rest: env.REGTEST_REST_URL?.trim() || 'http://localhost:50001',
        addressPrefix: 'bcrt1',
        bip84Coin: 1,
        isMainnet: false,
      };
  }
}

export const ALL_NETWORKS: readonly Network[] = ['mainnet', 'testnet', 'signet', 'regtest'];

export function isNetwork(value: string): value is Network {
  return (ALL_NETWORKS as readonly string[]).includes(value);
}

/**
 * Parse MERCHANT_NETWORK from env. Returns the inferred default if the var is
 * absent. `fallback` lets the caller pin it to the xpub-derived kind so a
 * vpub merchant doesn't end up watching mainnet by accident.
 */
export function readNetwork(
  env: NodeJS.ProcessEnv = process.env,
  fallback: Network = 'mainnet',
): Network {
  const raw = env.MERCHANT_NETWORK?.trim().toLowerCase();
  if (!raw) return fallback;
  if (!isNetwork(raw)) {
    throw new Error(
      `@zettapay/listener: unknown MERCHANT_NETWORK="${raw}". ` +
        `Expected one of: ${ALL_NETWORKS.join(', ')}.`,
    );
  }
  return raw;
}

/**
 * The xpub prefix carries network information; if the merchant set
 * MERCHANT_NETWORK to something that contradicts the xpub kind, fail loud
 * before the watcher boots. Mismatch detection rules:
 *
 *   zpub / xpub / ypub  → mainnet only
 *   vpub / tpub / upub  → testnet | signet | regtest (signet+regtest reuse
 *                         testnet derivation rules)
 */
export type XpubNetworkKind = 'mainnet' | 'testnet';

export function isNetworkCompatibleWithXpub(
  network: Network,
  xpubKind: XpubNetworkKind,
): boolean {
  if (xpubKind === 'mainnet') return network === 'mainnet';
  return network === 'testnet' || network === 'signet' || network === 'regtest';
}

export function defaultNetworkForXpubKind(xpubKind: XpubNetworkKind): Network {
  return xpubKind === 'mainnet' ? 'mainnet' : 'signet';
}
