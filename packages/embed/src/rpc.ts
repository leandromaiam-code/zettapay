/**
 * Minimal Solana JSON-RPC client. Uses `fetch` directly so the embed
 * ships with zero runtime dependencies. Only the methods strictly needed
 * for payment detection are wired:
 *
 *   - `getSignaturesForAddress` to discover candidate settlement txs
 *   - `getTransaction` to validate the SPL transfer and amount
 *
 * Both calls hit the cluster's public endpoint by default, but any URL
 * works — merchants who care about privacy or rate-limit headroom can
 * point at their own RPC.
 */
import type { Cluster } from './types.js';

/** Public Solana endpoints — fine for read-only polling at 30 s cadence. */
export const RPC_URL: Record<Cluster, string> = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
};

/** Canonical USDC mints per cluster, kept in sync with `@zettapay/sdk`. */
export const USDC_MINT: Record<Cluster, string> = {
  'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};

let rpcId = 0;

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!res.ok) {
    throw new Error(`rpc http ${res.status}`);
  }
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) {
    throw new Error(`rpc error: ${body.error.message}`);
  }
  return body.result as T;
}

export interface SignatureInfo {
  signature: string;
  blockTime: number | null;
  err: unknown;
}

/**
 * Latest signatures referencing `address`. We cap at 10 — the polling
 * loop only cares about novel signatures since the last tick, so a
 * shallow window keeps the response small and the validation tight.
 */
export async function getSignaturesForAddress(
  rpcUrl: string,
  address: string,
  limit = 10,
): Promise<SignatureInfo[]> {
  return rpc<SignatureInfo[]>(rpcUrl, 'getSignaturesForAddress', [
    address,
    { limit },
  ]);
}

export interface ParsedTransferInstruction {
  program: string;
  parsed?: {
    type?: string;
    info?: {
      destination?: string;
      authority?: string;
      mint?: string;
      tokenAmount?: { amount: string; decimals: number };
      amount?: string;
    };
  };
}

export interface ParsedTransaction {
  blockTime: number | null;
  meta: { err: unknown } | null;
  transaction: {
    message: {
      instructions: ParsedTransferInstruction[];
    };
  };
}

export async function getParsedTransaction(
  rpcUrl: string,
  signature: string,
): Promise<ParsedTransaction | null> {
  return rpc<ParsedTransaction | null>(rpcUrl, 'getTransaction', [
    signature,
    {
      encoding: 'jsonParsed',
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    },
  ]);
}
