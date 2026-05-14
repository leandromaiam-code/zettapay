#!/usr/bin/env node
import crypto from "node:crypto";
import express from "express";

const secret = process.env.ZETTAPAY_WEBHOOK_SECRET;
if (!secret) {
  console.error("Missing ZETTAPAY_WEBHOOK_SECRET.");
  process.exit(1);
}

const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const processed = new Map();

const app = express();
app.use(express.raw({ type: "application/json", limit: "1mb" }));

function verify(req) {
  const ts = Number(req.get("zettapay-timestamp"));
  const sig = req.get("zettapay-signature") ?? "";
  if (!ts || Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) {
    return { ok: false, reason: "timestamp out of window" };
  }
  const signedPayload = `${ts}.${req.body.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad signature" };
  }
  return { ok: true };
}

app.post("/zettapay/webhook", (req, res) => {
  const check = verify(req);
  if (!check.ok) return res.status(401).send(check.reason);

  const event = JSON.parse(req.body.toString("utf8"));
  if (processed.has(event.id)) {
    return res.status(200).send("duplicate-ok");
  }
  processed.set(event.id, Date.now());

  console.log(`event ${event.type} · ${event.id} · ${event.data.amount} USDC`);

  res.status(200).send("ok");
});

setInterval(() => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [id, ts] of processed) if (ts < cutoff) processed.delete(id);
}, 60_000).unref();

const port = Number(process.env.PORT ?? 4242);
app.listen(port, () => console.log(`webhook receiver on :${port}`));
