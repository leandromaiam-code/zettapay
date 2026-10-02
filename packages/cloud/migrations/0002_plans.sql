-- @zettapay/cloud — subscription plan per merchant.
--
-- The cloud tier is billed by a flat subscription; a plan only caps how many
-- invoices a merchant may create per calendar month. No per-transaction fee is
-- ever taken and no funds are touched. Additive and idempotent: existing
-- merchants land on 'free'.

alter table zettapay_merchants
  add column if not exists plan text not null default 'free';

-- Monthly usage is counted as invoices per merchant since the start of the month.
create index if not exists zettapay_invoices_merchant_created_idx
  on zettapay_invoices (merchant_id, created_at);
