#!/usr/bin/env node
import { ZettaPay } from "@zettapay/sdk";

const client = new ZettaPay({
  apiKey: process.env.ZETTAPAY_API_KEY,
  apiBase: process.env.ZETTAPAY_API_BASE,
});

const [cmd, ...args] = process.argv.slice(2);

function usage() {
  console.log(`usage:
  zpay create <amount> [reference]
  zpay status <intentId>
  zpay watch  <intentId>`);
  process.exit(1);
}

switch (cmd) {
  case "create": {
    const [amount, reference] = args;
    if (!amount) usage();
    const intent = await client.payments.create({
      amount,
      currency: "USDC",
      chain: "solana",
      reference: reference ?? `cli-${Date.now()}`,
    });
    console.log(JSON.stringify(intent, null, 2));
    break;
  }
  case "status": {
    const [id] = args;
    if (!id) usage();
    const intent = await client.payments.retrieve(id);
    console.log(intent.status, intent.signature ?? "");
    break;
  }
  case "watch": {
    const [id] = args;
    if (!id) usage();
    for (;;) {
      const intent = await client.payments.retrieve(id);
      process.stdout.write(`\r${intent.status}    `);
      if (intent.status === "settled" || intent.status === "expired") {
        console.log(`\n${intent.signature ?? ""}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    break;
  }
  default:
    usage();
}
