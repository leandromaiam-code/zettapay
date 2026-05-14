#!/usr/bin/env node
import crypto from "node:crypto";
import express from "express";

const secret = process.env.ZETTAPAY_WEBHOOK_SECRET;
const shopifyStore = process.env.SHOPIFY_STORE;
const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN;

if (!secret || !shopifyStore || !shopifyToken) {
  console.error("Missing env vars (see .env.example).");
  process.exit(1);
}

const app = express();
app.use(express.raw({ type: "application/json", limit: "1mb" }));

const seen = new Set();

app.post("/webhook", async (req, res) => {
  const signature = req.get("zettapay-signature") ?? "";
  const expected = crypto.createHmac("sha256", secret).update(req.body).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.status(401).send("bad signature");
  }

  const event = JSON.parse(req.body.toString("utf8"));
  if (event.type !== "payment.confirmed") return res.send("ignored");
  if (seen.has(event.id)) return res.send("duplicate");
  seen.add(event.id);

  const orderId = event.data.reference?.split("-")[1];
  if (!orderId) return res.status(400).send("missing reference");

  const url = `https://${shopifyStore}/admin/api/2024-10/orders/${orderId}/transactions.json`;
  const shopifyRes = await fetch(url, {
    method: "POST",
    headers: {
      "x-shopify-access-token": shopifyToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      transaction: {
        kind: "capture",
        status: "success",
        amount: event.data.amount,
        currency: "USD",
        gateway: "zettapay",
        authorization: event.data.signature,
      },
    }),
  });

  if (!shopifyRes.ok) {
    return res.status(502).send(`shopify error: ${shopifyRes.status}`);
  }
  res.send("ok");
});

const port = Number(process.env.PORT ?? 4242);
app.listen(port, () => console.log(`shopify webhook on :${port}`));
