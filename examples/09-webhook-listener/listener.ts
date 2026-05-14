/**
 * Reference webhook receiver — signature, replay and idempotency.
 */

import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import Database from "better-sqlite3";

const SECRET = process.env.ZETTAPAY_WEBHOOK_SECRET ?? "";
const TOLERANCE_SECONDS = 300;

const db = new Database("webhook-ledger.sqlite");
db.exec("CREATE TABLE IF NOT EXISTS processed (id TEXT PRIMARY KEY, at INTEGER NOT NULL)");
const seen = db.prepare<[string], { id: string }>("SELECT id FROM processed WHERE id = ?");
const insert = db.prepare("INSERT OR IGNORE INTO processed (id, at) VALUES (?, ?)");

type SignedHeader = { timestamp: number; signature: string };

function parseHeader(header: string): SignedHeader | null {
  const parts = header.split(",");
  let timestamp: number | undefined;
  let signature: string | undefined;
  for (const part of parts) {
    const [k, v] = part.split("=");
    if (k === "t") timestamp = Number(v);
    else if (k === "v1") signature = v;
  }
  if (!timestamp || !signature) return null;
  return { timestamp, signature };
}

function verify(rawBody: Buffer, header: string): boolean {
  const parsed = parseHeader(header);
  if (!parsed) return false;
  const age = Math.floor(Date.now() / 1000) - parsed.timestamp;
  if (age > TOLERANCE_SECONDS) return false;
  const payload = `${parsed.timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parsed.signature));
}

const app = express();

app.post(
  "/zettapay/webhook",
  express.raw({ type: "application/json" }),
  (req: Request, res: Response) => {
    const sig = req.header("zettapay-signature") ?? "";
    if (!verify(req.body as Buffer, sig)) {
      res.status(401).send("bad signature");
      return;
    }
    const event = JSON.parse(req.body.toString("utf8")) as { id: string; type: string };
    if (seen.get(event.id)) {
      res.json({ ok: true, duplicate: true });
      return;
    }
    insert.run(event.id, Math.floor(Date.now() / 1000));
    res.json({ ok: true });
    setImmediate(() => handle(event));
  },
);

function handle(event: { id: string; type: string }): void {
  console.log("processing", event.type, event.id);
  // route by event.type — payment.confirmed, payment.failed, ...
}

app.listen(Number(process.env.PORT ?? 5000));
