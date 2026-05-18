-- Z53: non-custodial xpub-based BTC payment confirmation tables.
--
-- Three tables: merchants (xpub + monotonically increasing child index),
-- invoices (per-invoice derived address + confirmation tracking), webhook_events
-- (HMAC-signed delivery queue with retry-curve metadata).
--
-- All three live under public schema for now — the Vercel /api/ functions use
-- the PostgREST surface with the service-role key. RLS is enabled but no
-- policies are wired yet (the only callers are server-side functions
-- authenticating with the service role). Future hardening: add merchant_id =
-- auth.uid() policies once dashboard auth is in place.

-- ---------------------------------------------------------------------------
-- merchants — minimal PII (HR-PII-MINIMAL: email + shop_name + xpub only).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.zettapay_merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  shop_name text NOT NULL,
  xpub text NOT NULL,
  next_child_index integer NOT NULL DEFAULT 0,
  webhook_url text,
  webhook_secret text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS zettapay_merchants_email_lower_idx
  ON public.zettapay_merchants (lower(email));

ALTER TABLE public.zettapay_merchants ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.zettapay_merchants IS
  'Z53: merchants register with email + shop_name + xpub only. ZettaPay never holds the matching xprv.';

-- ---------------------------------------------------------------------------
-- invoices — per-invoice receive address derived from merchant.xpub via
-- m/0/{child_index} (BIP-84 native segwit). One address per invoice; the
-- child_index is allocated atomically by incrementing the merchant row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.zettapay_invoices (
  id text PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES public.zettapay_merchants (id) ON DELETE CASCADE,
  chain text NOT NULL DEFAULT 'btc',
  child_index integer NOT NULL,
  receive_address text NOT NULL,
  amount_usd numeric(20, 8) NOT NULL,
  amount_btc numeric(20, 8),
  required_confirmations integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  tx_hash text,
  confirmations integer NOT NULL DEFAULT 0,
  detected_at timestamptz,
  confirmed_at timestamptz,
  metadata jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS zettapay_invoices_merchant_child_idx
  ON public.zettapay_invoices (merchant_id, child_index);
CREATE INDEX IF NOT EXISTS zettapay_invoices_status_idx
  ON public.zettapay_invoices (status, expires_at);
CREATE INDEX IF NOT EXISTS zettapay_invoices_receive_address_idx
  ON public.zettapay_invoices (receive_address);

ALTER TABLE public.zettapay_invoices ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.zettapay_invoices IS
  'Z53: BTC invoice + derived receive address. Status: pending → detected → confirmed → expired.';

-- ---------------------------------------------------------------------------
-- webhook_events — HMAC-signed delivery queue. Retry curve persisted as
-- attempt + next_retry_at; worker picks rows due, POSTs to merchant webhook
-- URL, and updates response_code + status (delivered / failed / retrying).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.zettapay_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id text NOT NULL REFERENCES public.zettapay_invoices (id) ON DELETE CASCADE,
  merchant_id uuid NOT NULL REFERENCES public.zettapay_merchants (id) ON DELETE CASCADE,
  event_type text NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 10,
  payload jsonb NOT NULL,
  signature text,
  status text NOT NULL DEFAULT 'pending',
  next_retry_at timestamptz NOT NULL DEFAULT now(),
  response_code integer,
  response_body text,
  delivered_at timestamptz,
  last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS zettapay_webhook_events_due_idx
  ON public.zettapay_webhook_events (status, next_retry_at);
CREATE INDEX IF NOT EXISTS zettapay_webhook_events_invoice_idx
  ON public.zettapay_webhook_events (invoice_id);

ALTER TABLE public.zettapay_webhook_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.zettapay_webhook_events IS
  'Z53: HMAC-signed webhook deliveries. Retry curve: 1s, 5s, 30s, 2m, 10m, 30m, 1h, 3h, 12h, 24h (10 attempts).';

-- ---------------------------------------------------------------------------
-- allocate_next_child_index(merchant) — atomic increment-and-return.
-- Used by /api/invoices to derive m/0/{i} without race conditions across
-- concurrent invoice creations.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zettapay_allocate_child_index(p_merchant uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_index integer;
BEGIN
  UPDATE public.zettapay_merchants
     SET next_child_index = next_child_index + 1
   WHERE id = p_merchant
   RETURNING next_child_index - 1 INTO v_index;
  IF v_index IS NULL THEN
    RAISE EXCEPTION 'merchant_not_found: %', p_merchant;
  END IF;
  RETURN v_index;
END;
$$;

REVOKE ALL ON FUNCTION public.zettapay_allocate_child_index(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.zettapay_allocate_child_index(uuid) TO service_role;
