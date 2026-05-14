#!/usr/bin/env node
import express from "express";
import { Connection, Transaction } from "@solana/web3.js";

const rpc = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
const price = process.env.PAYWALL_PRICE_USDC ?? "0.05";
const recipient = process.env.MERCHANT_PUBKEY ?? "AcAnpkVxJxnxXc6yp1JKfDmphqJ7gA1JjVZTbnUaWb8s";
const connection = new Connection(rpc, "confirmed");

const app = express();
app.use(express.text({ type: "*/*", limit: "1mb" }));

app.get("/protected", async (req, res) => {
  const header = req.get("x-payment") ?? "";
  if (!header.toLowerCase().startsWith("x402 ")) {
    res
      .status(402)
      .set("www-authenticate", `x402 amount="${price}", currency="USDC", recipient="${recipient}"`)
      .send("payment required");
    return;
  }

  try {
    const b64 = header.slice(5).trim();
    const tx = Transaction.from(Buffer.from(b64, "base64"));
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    await connection.confirmTransaction(sig, "confirmed");
    res.json({ message: "thanks for paying", signature: sig });
  } catch (err) {
    res.status(400).send(`bad payment: ${err.message}`);
  }
});

const port = Number(process.env.PORT ?? 4040);
app.listen(port, () => console.log(`paywalled server on :${port}`));
