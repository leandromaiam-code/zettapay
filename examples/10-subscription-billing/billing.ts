/**
 * Memo-based recurring billing loop.
 */

import Database from "better-sqlite3";
import cron from "node-cron";
import nodemailer from "nodemailer";
import { ZettaPay } from "@zettapay/sdk";

type Sub = {
  id: string;
  email: string;
  amount: string;
  cycle: number;
  nextDueAt: number;
  status: "active" | "past_due" | "cancelled";
};

const GRACE_DAYS = 3;
const CYCLE_DAYS = 30;

const zp = new ZettaPay({ apiKey: process.env.ZETTAPAY_API_KEY ?? "" });
const mailer = nodemailer.createTransport(process.env.SMTP_URL ?? "");
const db = new Database("subscriptions.sqlite");

db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    amount TEXT NOT NULL,
    cycle INTEGER NOT NULL,
    next_due_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
  );
  CREATE TABLE IF NOT EXISTS cycles (
    reference TEXT PRIMARY KEY,
    sub_id TEXT NOT NULL,
    cycle INTEGER NOT NULL,
    paid_at INTEGER
  );
`);

const dueSubs = db.prepare<[number], Sub>(`
  SELECT id, email, amount, cycle, next_due_at AS nextDueAt, status
  FROM subscriptions WHERE status = 'active' AND next_due_at <= ?
`);
const recordCycle = db.prepare(
  "INSERT INTO cycles (reference, sub_id, cycle) VALUES (?, ?, ?)",
);
const markPaid = db.prepare(
  "UPDATE cycles SET paid_at = ? WHERE reference = ?",
);
const advanceSub = db.prepare(
  "UPDATE subscriptions SET cycle = cycle + 1, next_due_at = ? WHERE id = ?",
);
const markPastDue = db.prepare(
  "UPDATE subscriptions SET status = 'past_due' WHERE id = ? AND status = 'active'",
);

async function bill(sub: Sub): Promise<void> {
  const memo = `sub:${sub.id}:${sub.cycle + 1}`;
  const intent = await zp.payments.create({
    amount: sub.amount,
    currency: "USDC",
    metadata: { memo, subscriptionId: sub.id, cycle: sub.cycle + 1 },
    idempotencyKey: memo,
  });
  recordCycle.run(intent.reference, sub.id, sub.cycle + 1);
  await mailer.sendMail({
    to: sub.email,
    subject: `ZettaPay · invoice ${sub.amount} USDC`,
    text: `Pay your subscription: ${intent.paymentUrl}`,
  });
}

cron.schedule("0 8 * * *", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const sub of dueSubs.all(now)) await bill(sub);
  const stale = now - GRACE_DAYS * 86400;
  db.prepare(
    `UPDATE subscriptions SET status = 'past_due'
     WHERE status = 'active' AND next_due_at < ?
       AND NOT EXISTS (SELECT 1 FROM cycles WHERE sub_id = subscriptions.id AND cycle = subscriptions.cycle + 1 AND paid_at IS NOT NULL)`,
  ).run(stale);
});

export function onWebhook(event: { type: string; data: { reference: string; metadata?: { subscriptionId?: string } } }): void {
  if (event.type !== "payment.confirmed") return;
  markPaid.run(Math.floor(Date.now() / 1000), event.data.reference);
  const subId = event.data.metadata?.subscriptionId;
  if (subId) {
    const next = Math.floor(Date.now() / 1000) + CYCLE_DAYS * 86400;
    advanceSub.run(next, subId);
  }
}
