// Z51 — BTC consolidation. Pulls UTXOs from mempool.space for the invoice's
// derived address, builds a single P2WPKH transaction that pays everything
// (minus medium-priority network fee) to BTC_TREASURY_ADDRESS, signs with
// the per-invoice private key, broadcasts via mempool.space POST /tx.
//
// 100-UTXO cap matches the spec: anything larger threatens stand-alone tx
// size limits and gets retried in a follow-up tick.

import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { deriveChildPrivateKey } from './sweep-derive.js';
import type { SweeperOutcome } from './sweep-types.js';

interface Utxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean };
}

const MAX_UTXOS_PER_TX = 100;
// Stand-alone P2WPKH (no scripts, no SegWit complications) — vbytes per input
// 68, per output 31, fixed 11. Good enough for fee estimation against a
// single-output consolidation tx.
function estimateVbytes(inputs: number): number {
  return 11 + inputs * 68 + 1 * 31;
}

export async function sweepBtc(args: {
  derivationPath: string;
  fromAddress: string;
  treasuryAddress: string;
}): Promise<SweeperOutcome> {
  const base = mempoolBase();
  const network = btcNetwork();

  let privateKey: Uint8Array;
  try {
    privateKey = deriveChildPrivateKey(args.derivationPath);
  } catch (err) {
    return { kind: 'failed', reason: errorMessage(err) };
  }
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  const p2wpkh = btc.p2wpkh(publicKey, network);
  if (!p2wpkh.address || p2wpkh.address !== args.fromAddress) {
    return {
      kind: 'failed',
      reason: `derived address mismatch (expected ${args.fromAddress}, got ${p2wpkh.address ?? 'undefined'})`,
    };
  }

  const utxosRes = await fetch(`${base}/api/address/${args.fromAddress}/utxo`);
  if (!utxosRes.ok) {
    return { kind: 'failed', reason: `mempool.space utxo fetch ${utxosRes.status}` };
  }
  const utxosRaw = (await utxosRes.json()) as Utxo[];
  const utxos = utxosRaw
    .filter((u) => u.status.confirmed)
    .sort((a, b) => b.value - a.value)
    .slice(0, MAX_UTXOS_PER_TX);
  if (utxos.length === 0) {
    return { kind: 'skipped', reason: 'no confirmed UTXOs to sweep' };
  }
  const totalSats = utxos.reduce((acc, u) => acc + u.value, 0);

  const feeRate = await fetchMediumFeeRate(base);
  const vbytes = estimateVbytes(utxos.length);
  const feeSats = Math.ceil(feeRate * vbytes);
  if (feeSats >= totalSats) {
    return { kind: 'skipped', reason: `value ${totalSats} below fee ${feeSats}` };
  }
  const sendSats = totalSats - feeSats;

  const tx = new btc.Transaction();
  for (const utxo of utxos) {
    const prevTxHex = await fetchRawTxHex(base, utxo.txid);
    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: p2wpkh.script, amount: BigInt(utxo.value) },
      nonWitnessUtxo: prevTxHex ? hexToBytes(prevTxHex) : undefined,
    });
  }
  tx.addOutputAddress(args.treasuryAddress, BigInt(sendSats), network);
  tx.sign(privateKey);
  tx.finalize();
  const txHex = tx.hex;

  const broadcastRes = await fetch(`${base}/api/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: txHex,
  });
  if (!broadcastRes.ok) {
    return {
      kind: 'failed',
      reason: `broadcast ${broadcastRes.status}: ${await broadcastRes.text()}`,
    };
  }
  const txid = (await broadcastRes.text()).trim();
  return { kind: 'swept', txHash: txid };
}

async function fetchMediumFeeRate(base: string): Promise<number> {
  try {
    const res = await fetch(`${base}/api/v1/fees/recommended`);
    if (!res.ok) return 5;
    const body = (await res.json()) as { halfHourFee?: number; hourFee?: number };
    return body.halfHourFee ?? body.hourFee ?? 5;
  } catch {
    return 5;
  }
}

async function fetchRawTxHex(base: string, txid: string): Promise<string | null> {
  try {
    const res = await fetch(`${base}/api/tx/${txid}/hex`);
    if (!res.ok) return null;
    return (await res.text()).trim();
  } catch {
    return null;
  }
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function mempoolBase(): string {
  return process.env.MEMPOOL_SPACE_BASE_URL?.replace(/\/+$/, '') ?? 'https://mempool.space';
}

function btcNetwork(): typeof btc.NETWORK {
  return process.env.BTC_NETWORK === 'testnet' ? btc.TEST_NETWORK : btc.NETWORK;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
