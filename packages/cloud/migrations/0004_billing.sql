-- @zettapay/cloud — subscription billing.
--
-- A paid plan is a flat monthly price that raises the monthly invoice cap. It can
-- be paid in crypto (an ordinary ZettaPay invoice issued by the platform's own
-- merchant account) or by card (a Stripe subscription). Neither path touches the
-- funds a merchant receives. Additive and idempotent.

alter table zettapay_merchants
  add column if not exists plan_expires_at timestamptz;

-- Signup looks merchants up by email. Not UNIQUE: rows seeded by the operator
-- before self-serve signup existed may share an address; signup itself refuses
-- an email that is already present.
create index if not exists zettapay_merchants_email_idx on zettapay_merchants (email);

create table if not exists zettapay_subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  merchant_id             uuid not null references zettapay_merchants (id) on delete cascade,
  plan                    text not null,
  method                  text not null check (method in ('crypto', 'stripe')),
  status                  text not null default 'pending'
                            check (status in ('pending', 'active', 'expired', 'canceled')),
  invoice_id              text,
  stripe_session_id       text,
  stripe_subscription_id  text,
  amount_usd              numeric not null,
  period_end              timestamptz,
  created_at              timestamptz not null default now()
);
create index if not exists zettapay_subscriptions_merchant_idx on zettapay_subscriptions (merchant_id);
create index if not exists zettapay_subscriptions_pending_idx on zettapay_subscriptions (status, method);
create index if not exists zettapay_subscriptions_stripe_idx on zettapay_subscriptions (stripe_subscription_id);

-- Service role only (the cloud service); no end-user policy.
alter table zettapay_subscriptions enable row level security;
