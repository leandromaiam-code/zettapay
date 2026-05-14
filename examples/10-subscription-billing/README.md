# 10 · Subscription Billing

A memo-based recurring billing tracker. ZettaPay does not custody funds, so
"subscriptions" are implemented as one-shot transfers that the customer
re-confirms each cycle. This example shows the canonical pattern:

1. Subscriber registers (provides email + payment address).
2. On day-1 of each cycle, the billing loop creates a payment intent and
   emails the subscriber a payment link.
3. Memo carries `sub:<id>:<cycle>` so reconciliation is on-chain auditable.
4. If unpaid after `gracePeriodDays`, the subscription transitions to
   `past_due` and access is revoked.

## Flow

```
billing loop (cron) → for each active sub:
  create payment intent with memo sub:<id>:<cycle>
  email payment URL
on payment.confirmed webhook → mark cycle paid, schedule next
on grace expiry → mark past_due
```

## Run

```bash
npm i @zettapay/sdk node-cron better-sqlite3 nodemailer
ZETTAPAY_API_KEY=zp_live_... SMTP_URL=smtps://... npx tsx billing.ts
```

## Why this matters

SaaS is recurring or it isn't a business. A worked example of cycle
management, dunning and grace-period state machines on top of one-shot
transfers gives merchants a copy-pasteable subscription primitive.
