#!/usr/bin/env node
import qrcode from "qrcode-terminal";

const apiKey = process.env.ZETTAPAY_API_KEY;
const apiBase = process.env.ZETTAPAY_API_BASE ?? "https://api.zettapay.dev";
const amount = process.env.AMOUNT_USDC ?? "1.00";

if (!apiKey) {
  console.error("Missing ZETTAPAY_API_KEY (copy .env.example to .env).");
  process.exit(1);
}

async function createIntent() {
  const res = await fetch(`${apiBase}/v1/pay/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      amount,
      currency: "USDC",
      chain: "solana",
      reference: `cli-demo-${Date.now()}`,
    }),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function poll(intentId) {
  for (;;) {
    const res = await fetch(`${apiBase}/v1/pay/${intentId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`poll failed: ${res.status}`);
    const body = await res.json();
    process.stdout.write(`\rstatus: ${body.status}    `);
    if (body.status === "settled" || body.status === "expired") return body;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const intent = await createIntent();
console.log(`Intent: ${intent.id}`);
console.log(`Amount: ${amount} USDC → ${intent.recipient}`);
console.log(`URI:    ${intent.uri}\n`);
qrcode.generate(intent.uri, { small: true });

const final = await poll(intent.id);
console.log(`\nDone. Tx: ${final.signature ?? "(none)"}`);
