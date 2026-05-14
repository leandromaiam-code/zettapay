#!/usr/bin/env node
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import bs58 from "bs58";

const rpc = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
const usdcMint = new PublicKey(process.env.USDC_MINT);
const paywallUrl = process.env.PAYWALL_URL ?? "http://localhost:4040/protected";
const agent = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_SECRET_KEY_BASE58));
const connection = new Connection(rpc, "confirmed");

console.log("Step 1 — unpriced request:");
let res = await fetch(paywallUrl);
console.log(`  status: ${res.status} ${res.statusText}`);
if (res.status !== 402) {
  console.log("  unexpected — server didn't ask for payment.");
  process.exit(0);
}

const challenge = res.headers.get("www-authenticate") ?? "";
const params = Object.fromEntries(
  challenge
    .replace(/^x402\s+/i, "")
    .split(",")
    .map((p) => p.trim().split("=").map((s) => s.replace(/^"|"$/g, ""))),
);
console.log(`  challenge: pay ${params.amount} USDC to ${params.recipient}`);

console.log("\nStep 2 — sign transfer:");
const recipient = new PublicKey(params.recipient);
const lamportsPerUsdc = 1_000_000n;
const amount = BigInt(Math.round(Number(params.amount) * Number(lamportsPerUsdc)));
const fromAta = await getAssociatedTokenAddress(usdcMint, agent.publicKey);
const toAta = await getAssociatedTokenAddress(usdcMint, recipient);
const ix = createTransferCheckedInstruction(
  fromAta,
  usdcMint,
  toAta,
  agent.publicKey,
  amount,
  6,
);
const { blockhash } = await connection.getLatestBlockhash();
const tx = new Transaction({ recentBlockhash: blockhash, feePayer: agent.publicKey }).add(ix);
tx.sign(agent);
const serialized = tx.serialize().toString("base64");
console.log(`  signed tx: ${serialized.slice(0, 32)}…`);

console.log("\nStep 3 — retry with X-Payment header:");
res = await fetch(paywallUrl, { headers: { "X-Payment": `x402 ${serialized}` } });
console.log(`  status: ${res.status}`);
console.log(`  body:   ${await res.text()}`);
