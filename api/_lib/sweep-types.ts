// Z51 — types shared across the Vercel-lane sweep helpers. Mirrors the
// SweepableInvoice contract from packages/api/src/services/sweep_worker.ts
// without importing from it (workspaces=false in vercel.json means the
// Vercel install never resolves @zettapay/api).

export type SweepChain = 'btc' | 'base' | 'polygon' | 'ethereum';

export interface SweepableInvoice {
  id: string;
  merchantId: string;
  chain: SweepChain;
  derivationPath: string;
  receiveAddress: string;
  amountNative: string;
  sweepAttempts: number;
  sweepTxHash: string | null;
}

export type SweeperOutcome =
  | { kind: 'swept'; txHash: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string };
