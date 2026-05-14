/**
 * Minimal Solana Pay QR — wallet-less by construction.
 *
 * Usage:
 *   RECIPIENT=<base58> AMOUNT_USDC=1.50 npx tsx index.ts
 */

import { writeFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { encodeURL, findReference, validateTransfer } from "@solana/pay";
import BigNumber from "bignumber.js";
import qrcode from "qrcode";

const USDC_DEVNET_MINT = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

async function main(): Promise<void> {
  const recipient = new PublicKey(
    process.env.RECIPIENT ?? "11111111111111111111111111111111",
  );
  const amount = new BigNumber(process.env.AMOUNT_USDC ?? "1.50");
  const reference = Keypair.generate().publicKey;

  const url = encodeURL({
    recipient,
    amount,
    splToken: USDC_DEVNET_MINT,
    reference,
    label: "ZettaPay Example",
    message: `Pay ${amount.toString()} USDC`,
    memo: `zettapay:example:${reference.toBase58().slice(0, 8)}`,
  });

  await qrcode.toFile("payment.png", url.toString(), { width: 512 });
  console.log("QR written to ./payment.png");
  console.log("Payment URL:", url.toString());

  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  console.log("Polling for incoming transfer...");

  const signatureInfo = await findReference(connection, reference, {
    finality: "confirmed",
  });

  await validateTransfer(
    connection,
    signatureInfo.signature,
    {
      recipient,
      amount,
      splToken: USDC_DEVNET_MINT,
      reference,
    },
    { commitment: "confirmed" },
  );

  console.log("Confirmed:", signatureInfo.signature);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
