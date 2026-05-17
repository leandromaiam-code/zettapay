-- Seed Hard Rules for the zettapay workspace.
-- Apply on Fabric control-plane after 0001_hr_columns.sql.
-- Idempotent via id-based UPSERT (id is workspace-scoped, format: <workspace>:<HR_ID>).

INSERT INTO public.fabric_layer0_premissas
  (id, workspace_id, premissa_kind, severity, title, body, detection_patterns)
VALUES
  (
    'zettapay:HR-CUSTODY',
    'c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
    'HR', 'hard',
    'Non-custodial invariant',
    'ZettaPay never possesses, generates, stores, or has capacity to sign with private keys controlling merchant/customer funds. Forbidden patterns include any code that stores private keys for merchant/customer wallets, derives addresses from a ZettaPay-held master seed (use merchant xpub instead), or signs transactions on behalf of merchants. Sweep cron services that consolidate funds using our keys are also forbidden.',
    '["\\bPRIVATE_KEY\\b","\\bMASTER_SEED\\b","\\bTREASURY_\\w*KEY\\b","createWalletClient\\s*\\(","privateKeyToAccount\\s*\\(","KeyManager\\.sign\\w+","signBtcTx","signEvmTx","sweep_worker","master_seed","BIP39.*mnemonic"]'::jsonb
  ),
  (
    'zettapay:HR-WALLET-LESS',
    'c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
    'HR', 'hard',
    'Wallet-less merchant',
    'Merchant never connects a wallet. UI shows address inputs only (no wallet.connect, no Phantom/Metamask buttons). Customer uses their own wallet — that is fine — but merchant never does.',
    '["wallet\\.connect\\s*\\(","window\\.solana\\.connect","window\\.ethereum\\.request","ConnectWallet","useWallet\\(","@solana/wallet-adapter"]'::jsonb
  ),
  (
    'zettapay:HR-PII-MINIMAL',
    'c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
    'HR', 'hard',
    'Minimal PII',
    'ZettaPay collects only email + shop_name from merchants. No name, no doc, no address, no birthdate. No KYC unless triggered by regulatory threshold (>$10k tx volume — feature-gated).',
    '["kyc\\b","\\bssn\\b","social_security","tax_id","passport"]'::jsonb
  ),
  (
    'zettapay:HR-SECRETS-IN-GIT',
    'c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
    'HR', 'blocker',
    'No secrets in git',
    'Real API keys, private keys, webhook secrets never committed. Use placeholders in .env.example. Real values in Supabase Vault or platform secrets store.',
    '["sk_live_[a-zA-Z0-9]{20,}","zk_live_[a-zA-Z0-9]{20,}","whsec_[a-zA-Z0-9_-]{20,}","ghp_[a-zA-Z0-9]{30,}","0x[a-fA-F0-9]{64}\\s*(//|$)"]'::jsonb
  )
ON CONFLICT (id) DO UPDATE SET
  premissa_kind = EXCLUDED.premissa_kind,
  severity = EXCLUDED.severity,
  title = EXCLUDED.title,
  body = EXCLUDED.body,
  detection_patterns = EXCLUDED.detection_patterns;
