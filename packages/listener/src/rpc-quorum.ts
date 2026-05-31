// RPC quorum (Z76, FIX 2). The fixed-address USDC watcher confirms a payment by
// reading the ERC-20 `Transfer` log from a public JSON-RPC endpoint. Trusting a
// SINGLE public RPC is a risk: a malicious or buggy endpoint could forge a
// confirmation and activate an invoice with no real payment. The mitigation
// keeps the architecture self-hosted, free and P2P — in fact MORE decentralised:
// we query a LIST of independent public RPCs per chain and require a QUORUM
// (>= 2 of N) to AGREE on the same tx + value + maturity before confirming.
//
//   - 1 endpoint disagrees / is offline  → fall back to the others
//   - only 1 endpoint confirms (others silent/offline) → NOT confirmed; the
//     transfer is left "awaiting" and 'rpc_quorum_degraded' is logged
//   - a single endpoint forging a different value can never reach quorum
//
// A merchant who runs their own node can collapse the list to a single trusted
// endpoint via the per-chain *_RPC_URL env (csv) — then quorum is 1-of-1 and the
// node they control is authoritative. This module is pure: no I/O, no network,
// HR-PHONE-HOME / HR-CUSTODY safe.

/** Default public RPC endpoints per chain alias. 2-3 independent providers. */
export const DEFAULT_EVM_RPCS: Record<string, string[]> = {
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
 * Resolve the effective RPC endpoint list for a chain. A merchant override
 * (csv, e.g. BASE_RPC_URL="https://my-node,https://backup") wins so a self-run
 * node can be used; otherwise the public defaults apply. De-duplicated, order
 * preserved, empty entries dropped. Never returns an empty list.
 */
export function resolveRpcList(
  override: string | undefined,
  defaults: readonly string[],
): string[] {
  const fromOverride = (override ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const chosen =
    fromOverride.length > 0 ? fromOverride : defaults.map((u) => u.replace(/\/$/, ''));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of chosen) {
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/**
 * Quorum threshold for N configured endpoints: require 2 when >= 2 endpoints
 * are configured, else 1 (a deliberately single endpoint — e.g. a merchant's
 * own node, or a test harness — is authoritative on its own).
 */
export function quorumThreshold(endpointCount: number): number {
  return endpointCount >= 2 ? 2 : 1;
}

/** One endpoint's view of a single inbound Transfer. */
export interface TransferObservation {
  /** `${txHash}:${logIndex}` — stable identity of the on-chain log. */
  key: string;
  txHash: string;
  /** Transfer value in token base units. */
  value: bigint;
  /** Confirmations as computed from THIS endpoint's latest block. */
  confirmations: number;
}

export interface QuorumConfirmation {
  key: string;
  txHash: string;
  value: bigint;
  /** Minimum confirmations among the agreeing endpoints. */
  confirmations: number;
  /** How many endpoints agreed on this mature (key,value). */
  agreement: number;
}

export interface QuorumDegraded {
  key: string;
  value: bigint;
  /** Endpoints that saw this (key,value) mature — fewer than required. */
  agreement: number;
  required: number;
}

export interface QuorumResult {
  /** (key,value) pairs that reached quorum and are at/above minConfirmations. */
  confirmed: QuorumConfirmation[];
  /** Mature (key,value) seen by >=1 but < required endpoints — left awaiting. */
  degraded: QuorumDegraded[];
}

/**
 * Cross-check per-endpoint Transfer observations and decide which reached
 * quorum. A (key,value) is CONFIRMED when at least `required` endpoints report
 * it with confirmations >= minConfirmations. A (key,value) that some — but
 * fewer than `required` — endpoints report as mature is reported as `degraded`
 * so the watcher can warn and retry rather than confirm on a minority. A value
 * still below minConfirmations everywhere is silently omitted (normal maturing).
 */
export function tallyTransferQuorum(
  perEndpoint: readonly (readonly TransferObservation[])[],
  minConfirmations: number,
  required: number,
): QuorumResult {
  // Group mature observations by (key,value); a forged value lands in its own
  // bucket and therefore competes for quorum on its own.
  const buckets = new Map<
    string,
    { key: string; txHash: string; value: bigint; confs: number[] }
  >();
  for (const endpoint of perEndpoint) {
    // One endpoint contributes at most one vote per (key,value).
    const votedThisEndpoint = new Set<string>();
    for (const obs of endpoint) {
      if (obs.confirmations < minConfirmations) continue;
      const bucketKey = `${obs.key}@${obs.value.toString()}`;
      if (votedThisEndpoint.has(bucketKey)) continue;
      votedThisEndpoint.add(bucketKey);
      const existing = buckets.get(bucketKey);
      if (existing) {
        existing.confs.push(obs.confirmations);
      } else {
        buckets.set(bucketKey, {
          key: obs.key,
          txHash: obs.txHash,
          value: obs.value,
          confs: [obs.confirmations],
        });
      }
    }
  }

  const confirmed: QuorumConfirmation[] = [];
  const degraded: QuorumDegraded[] = [];
  for (const b of buckets.values()) {
    const agreement = b.confs.length;
    if (agreement >= required) {
      confirmed.push({
        key: b.key,
        txHash: b.txHash,
        value: b.value,
        confirmations: Math.min(...b.confs),
        agreement,
      });
    } else {
      degraded.push({ key: b.key, value: b.value, agreement, required });
    }
  }
  return { confirmed, degraded };
}
