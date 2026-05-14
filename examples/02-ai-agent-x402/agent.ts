/**
 * x402 client — autonomous AI agent paying for a paywalled resource.
 *
 * The agent reads its keypair from disk, signs a USDC transfer on devnet,
 * and replays the request with the encoded payment proof.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { fetch } from "undici";

type PaymentRequired = {
  scheme: "solana-usdc";
  recipient: string;
  amount: string;
  mint: string;
  reference: string;
  expiresAt: string;
};

function loadAgentKeypair(): Keypair {
  const path = process.env.AGENT_KEYPAIR ?? join(homedir(), ".zettapay/agent.json");
  const secret = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function signTransferTx(
  connection: Connection,
  payer: Keypair,
  quote: PaymentRequired,
): Promise<string> {
  const mint = new PublicKey(quote.mint);
  const recipient = new PublicKey(quote.recipient);
  const reference = new PublicKey(quote.reference);
  const source = getAssociatedTokenAddressSync(mint, payer.publicKey);
  const destination = getAssociatedTokenAddressSync(mint, recipient);
  const amount = BigInt(Math.round(Number(quote.amount) * 1_000_000));

  const ix = createTransferCheckedInstruction(
    source,
    mint,
    destination,
    payer.publicKey,
    amount,
    6,
    [],
    TOKEN_PROGRAM_ID,
  );
  ix.keys.push({ pubkey: reference, isSigner: false, isWritable: false });

  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(payer);
  return tx.serialize().toString("base64");
}

async function main(): Promise<void> {
  const baseUrl = process.env.ZETTAPAY_API ?? "https://zettapay.vercel.app";
  const resource = `${baseUrl}/premium-feed`;
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const agent = loadAgentKeypair();

  const probe = await fetch(resource);
  if (probe.status !== 402) {
    const body = await probe.text();
    console.log("resource is free:", body);
    return;
  }

  const quote = (await probe.json()) as PaymentRequired;
  console.log("paying", quote.amount, "USDC to", quote.recipient);

  const signedTx = await signTransferTx(connection, agent, quote);
  const header = Buffer.from(
    JSON.stringify({ scheme: quote.scheme, tx: signedTx }),
  ).toString("base64");

  const paid = await fetch(resource, { headers: { "X-PAYMENT": header } });
  console.log("response", paid.status, await paid.text());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
