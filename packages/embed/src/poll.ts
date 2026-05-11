/**
 * Payment detection loop. We poll `getSignaturesForAddress` on the
 * Solana Pay reference key (preferred) or recipient ATA (fallback).
 *
 * For every novel signature we fetch the parsed transaction and look
 * for an SPL transfer to `recipient` whose `(mint, amount)` matches
 * the invoice. The first match is reported via `onMatch`. The loop
 * stops itself after a match — terminal state is the caller's
 * responsibility.
 */
import {
  getParsedTransaction,
  getSignaturesForAddress,
  type ParsedTransferInstruction,
} from './rpc.js';

export interface PollParams {
  rpcUrl: string;
  /** Address whose signature stream we poll. */
  watch: string;
  /** SPL token account expected to receive the funds. */
  recipient: string;
  /** Mint base58 — guards against unrelated transfers on the watched address. */
  mint: string;
  /** Amount in base units (e.g. 6-dp USDC: `1500000` for 1.5 USDC). */
  amountBaseUnits: bigint;
  /** Polling interval in ms. */
  intervalMs: number;
  /** Called on the first matching signature; the poller stops itself afterwards. */
  onMatch: (signature: string, blockTime: number | null) => void;
  /** Called when a poll cycle fails. Loop continues — RPCs flake. */
  onError: (err: Error) => void;
}

export interface Poller {
  stop(): void;
}

export function startPoller(params: PollParams): Poller {
  const seen = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const sigs = await getSignaturesForAddress(params.rpcUrl, params.watch);
      for (const sig of sigs) {
        if (stopped) return;
        if (seen.has(sig.signature)) continue;
        seen.add(sig.signature);
        if (sig.err) continue;
        const tx = await getParsedTransaction(params.rpcUrl, sig.signature);
        if (!tx || tx.meta?.err) continue;
        if (
          matchesTransfer(
            tx.transaction.message.instructions,
            params.recipient,
            params.mint,
            params.amountBaseUnits,
          )
        ) {
          stopped = true;
          params.onMatch(sig.signature, sig.blockTime ?? tx.blockTime);
          return;
        }
      }
    } catch (e) {
      params.onError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, params.intervalMs);
      }
    }
  };

  // First tick fires immediately so payments made before the embed
  // renders (e.g. payer prepared the tx in advance) are caught fast.
  timer = setTimeout(tick, 0);

  return {
    stop(): void {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}

/**
 * Returns true when one of the parsed instructions is an SPL transfer
 * (`transfer` or `transferChecked`) of `amount` `mint` units to
 * `recipient`. Anything else — wrong destination, wrong mint, partial
 * amount — is ignored.
 */
export function matchesTransfer(
  instructions: ParsedTransferInstruction[],
  recipient: string,
  mint: string,
  amount: bigint,
): boolean {
  for (const ix of instructions) {
    if (ix.program !== 'spl-token') continue;
    const info = ix.parsed?.info;
    if (!info || info.destination !== recipient) continue;
    if (ix.parsed?.type === 'transferChecked') {
      if (info.mint !== mint) continue;
      const raw = info.tokenAmount?.amount;
      if (raw && BigInt(raw) === amount) return true;
    } else if (ix.parsed?.type === 'transfer') {
      // Legacy `transfer` lacks an inline mint — caller's `mint` is the
      // mint of the recipient ATA, so a destination match is sufficient
      // proof that the funds settle in the right token.
      const raw = info.amount;
      if (raw && BigInt(raw) === amount) return true;
    }
  }
  return false;
}
