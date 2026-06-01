// RPC quorum (Z76 FIX 2). The fixed-address USDC watcher confirms a payment by
// reading the chain's ERC-20 Transfer logs over a public JSON-RPC endpoint. A
// SINGLE public RPC is a trust bottleneck: a malicious or buggy endpoint could
// forge a confirmation and falsely activate a merchant's plan WITHOUT a real
// payment.
//
// The defense keeps the architecture self-hosted, free and P2P — it makes the
// listener MORE decentralized, not less: instead of one RPC, every chain has a
// LIST of independent public RPCs, and a transfer is only confirmed when at
// least `quorum` of them AGREE on the same (tx, value) with enough
// confirmations. A merchant who runs their own node can collapse the list to
// that single trusted endpoint (BASE_RPC_URL=...) and opt out of cross-check.
//
// Pure module: the network fetching lives in the watcher; here we only hold the
// default endpoint lists, parse overrides, and decide a quorum from collected
// observations. HR-PHONE-HOME / HR-CUSTODY safe.

/** Quorum size required when 2+ RPCs are configured. 2-of-N. */
export const DEFAULT_QUORUM = 2;

/**
 * Default public JSON-RPC endpoints per chain alias. 3 independent providers
 * each so a single one being down or hostile cannot decide a confirmation.
 * All free, all public — no API key, no paid tier, no zettapay.* host.
 */
export const DEFAULT_RPC_URLS: Record<string, string[]> = {
  base: [
    'https://mainnet.base.org',
    'https://base.llamarpc.com',
    'https://base-rpc.publicnode.com',
  ],
  ethereum: [
    'https://eth.llamarpc.com',
    'https://ethereum-rpc.publicnode.com',
    'https://rpc.ankr.com/eth',
  ],
  polygon: [
    'https://polygon-rpc.com',
    'https://polygon.llamarpc.com',
    'https://polygon-bor-rpc.publicnode.com',
  ],
};

/**
 * Resolve the RPC endpoint list for a chain. A merchant override (csv from the
 * chain's env var, e.g. BASE_RPC_URL="https://my-node,https://backup") wins and
 * REPLACES the defaults — set a single url to use only your own node. Empty /
 * unset → the bundled public list.
 */
export function resolveRpcUrls(alias: string, override: string | undefined): string[] {
  const fromEnv = parseRpcCsv(override);
  if (fromEnv.length > 0) return fromEnv;
  return DEFAULT_RPC_URLS[alias.trim().toLowerCase()] ?? [];
}

/** Split a comma-separated RPC override into a de-duplicated url list. */
export function parseRpcCsv(csv: string | undefined): string[] {
  if (!csv) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of csv.split(',')) {
    const u = part.trim();
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

/**
 * Required agreeing-RPC count for a confirmation given how many endpoints are
 * configured. With a single endpoint (a merchant's own node, or a test) the
 * quorum is 1 — single trusted source. With 2+ public endpoints it is
 * {@link DEFAULT_QUORUM}, so no lone RPC can decide.
 */
export function quorumThreshold(configuredCount: number, quorum = DEFAULT_QUORUM): number {
  return Math.max(1, Math.min(configuredCount, quorum));
}

/** One RPC's view of a single Transfer log: its value and confirmation depth. */
export interface RpcObservation {
  value: bigint;
  confirmations: number;
}

export type QuorumDecision =
  | { status: 'agreed'; value: bigint; confirmations: number; agree: number }
  | { status: 'conflict'; agree: number }
  | { status: 'insufficient'; agree: number };

/**
 * Decide a quorum for ONE transfer (keyed by tx:logIndex) from the per-RPC
 * observations gathered this poll. Observations are grouped by value; the
 * largest agreeing group must reach `threshold` to be `agreed`. The agreed
 * confirmation depth is the MINIMUM across the agreeing RPCs (conservative —
 * we never over-count confirmations). When the top group is short of threshold
 * we distinguish a genuine `conflict` (RPCs report different values — possible
 * forgery) from `insufficient` (a single value but too few reporters yet —
 * propagation lag) so the caller can log accurately; both mean "do not
 * confirm".
 */
export function decideTransferQuorum(
  observations: RpcObservation[],
  threshold: number,
): QuorumDecision {
  const byValue = new Map<string, { count: number; minConf: number; value: bigint }>();
  for (const obs of observations) {
    const key = obs.value.toString();
    const g = byValue.get(key);
    if (g) {
      g.count += 1;
      g.minConf = Math.min(g.minConf, obs.confirmations);
    } else {
      byValue.set(key, { count: 1, minConf: obs.confirmations, value: obs.value });
    }
  }
  let top: { count: number; minConf: number; value: bigint } | null = null;
  for (const g of byValue.values()) {
    if (!top || g.count > top.count) top = g;
  }
  if (!top) return { status: 'insufficient', agree: 0 };
  if (top.count >= threshold) {
    return { status: 'agreed', value: top.value, confirmations: top.minConf, agree: top.count };
  }
  // Short of quorum. More than one distinct value ⇒ the RPCs disagree.
  return byValue.size > 1
    ? { status: 'conflict', agree: top.count }
    : { status: 'insufficient', agree: top.count };
}
