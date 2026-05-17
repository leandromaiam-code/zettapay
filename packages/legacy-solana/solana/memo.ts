import { PublicKey, TransactionInstruction } from "@solana/web3.js";

/**
 * Memo program v2 — canonical address.
 * Docs: https://spl.solana.com/memo
 */
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export interface MemoBindingPayload {
  namespace: string;
  merchantId: string;
  wallet: string;
  ata: string;
  ts: number;
}

export function encodeMemoPayload(payload: MemoBindingPayload): string {
  return JSON.stringify({
    ns: payload.namespace,
    mid: payload.merchantId,
    w: payload.wallet,
    ata: payload.ata,
    ts: payload.ts,
  });
}

export function buildMemoInstruction(
  memo: string,
  signers: PublicKey[] = [],
): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: signers.map((pk) => ({ pubkey: pk, isSigner: true, isWritable: false })),
    data: Buffer.from(memo, "utf8"),
  });
}
