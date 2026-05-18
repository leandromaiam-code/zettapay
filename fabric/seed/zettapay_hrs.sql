-- Seed Hard Rules for the zettapay workspace.
-- Apply on Fabric control-plane after 0001_hr_columns.sql and
-- 0002_hr_allowlist_paths.sql. Idempotent via id-based UPSERT
-- (id is workspace-scoped, format: <workspace>:<HR_ID>).

INSERT INTO public.fabric_layer0_premissas
  (id, workspace_id, premissa_kind, severity, title, body, allowlist_paths, detection_patterns)
VALUES
  (
    'zettapay:HR-CUSTODY',
    'c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
    'HR', 'hard',
    'Non-custodial invariant',
    'ZettaPay never possesses, generates, stores, or has capacity to sign with private keys controlling merchant/customer funds. Forbidden patterns include any code that stores private keys for merchant/customer wallets, derives addresses from a ZettaPay-held master seed (use merchant xpub instead), or signs transactions on behalf of merchants. Sweep cron services that consolidate funds using our keys are also forbidden.',
    '[]'::jsonb,
    '["\\bPRIVATE_KEY\\b","\\bMASTER_SEED\\b","\\bTREASURY_\\w*KEY\\b","createWalletClient\\s*\\(","privateKeyToAccount\\s*\\(","KeyManager\\.sign\\w+","signBtcTx","signEvmTx","sweep_worker","master_seed","BIP39.*mnemonic"]'::jsonb
  ),
  (
    'zettapay:HR-WALLET-LESS',
    'c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
    'HR', 'hard',
    'Wallet-less merchant',
    'Merchant never connects a wallet. UI shows address inputs only (no wallet.connect, no Phantom/Metamask buttons). Customer uses their own wallet — that is fine — but merchant never does.',
    '[]'::jsonb,
    '["wallet\\.connect\\s*\\(","window\\.solana\\.connect","window\\.ethereum\\.request","ConnectWallet","useWallet\\(","@solana/wallet-adapter"]'::jsonb
  ),
  (
    'zettapay:HR-PII-MINIMAL',
    'c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
    'HR', 'hard',
    'Minimal PII',
    'ZettaPay collects only email + shop_name from merchants. No name, no doc, no address, no birthdate. No KYC unless triggered by regulatory threshold (>$10k tx volume — feature-gated).',
    '[]'::jsonb,
    '["kyc\\b","\\bssn\\b","social_security","tax_id","passport"]'::jsonb
  ),
  (
    'zettapay:HR-SECRETS-IN-GIT',
    'c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
    'HR', 'blocker',
    'No secrets in git',
    'Real API keys, private keys, webhook secrets never committed. Use placeholders in .env.example. Real values in Supabase Vault or platform secrets store.',
    '[]'::jsonb,
    '["sk_live_[a-zA-Z0-9]{20,}","zk_live_[a-zA-Z0-9]{20,}","whsec_[a-zA-Z0-9_-]{20,}","ghp_[a-zA-Z0-9]{30,}","0x[a-fA-F0-9]{64}\\s*(//|$)"]'::jsonb
  ),
  (
    'zettapay:HR-PHONE-HOME',
    'c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
    'HR', 'hard',
    'Self-hosted listener never phones home to ZettaPay-controlled domains',
    'O package @zettapay/listener, quando em modo self-hosted, nao pode fazer outbound HTTP para zettapay.vercel.app, zettapay.dev, zettapay.com ou api.zettapay.* (qualquer subdomain). Trafego permitido: mempool.space, MERCHANT_WEBHOOK_URL configurado pelo merchant, e Supabase/Postgres URL se merchant escolheu adapter=supabase|postgres.',
    '["examples/","docs/","**/README*","**/*.test.ts","packages/sdk/"]'::jsonb,
    '["zettapay\\.(vercel\\.app|dev|com)","api\\.zettapay\\.","https://zettapay\\."]'::jsonb
  ),
  (
    'zettapay:HR-OPTIONAL-DEPS',
    'c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
    'HR', 'hard',
    'Dependencias de storage adapter sao OPTIONAL peer deps',
    'O listener self-hosted precisa bootar com STORAGE=json SEM ter @supabase/supabase-js, better-sqlite3 ou pg instalados. Essas libs vivem em peerDependenciesMeta.<dep>.optional=true no package.json do @zettapay/listener. Imports devem ser lazy/conditional (dynamic import baseado em STORAGE env). Falha de import vira erro claro sugerindo npm install do peer dep correspondente.',
    '["packages/listener/src/storage/supabase.ts","packages/listener/src/storage/sqlite.ts","packages/listener/src/storage/postgres.ts","packages/api/","packages/legacy-custodial/","packages/legacy-solana/"]'::jsonb,
    '["from [''\"]@supabase/supabase-js[''\"]","from [''\"]better-sqlite3[''\"]","from [''\"]pg[''\"]","require\\([''\"]@supabase/supabase-js[''\"]\\)","require\\([''\"]better-sqlite3[''\"]\\)","require\\([''\"]pg[''\"]\\)"]'::jsonb
  ),
  (
    'zettapay:HR-STORAGE-ADAPTER',
    'c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
    'HR', 'hard',
    'Toda persistencia do listener passa por StorageAdapter',
    'Nenhum codigo do listener fora de packages/listener/src/storage/<adapter>.ts pode chamar fs.writeFile/readFile (para JSON), supabase.from, sqlite.prepare ou pg.query diretamente. Tudo via interface abstrata StorageAdapter. Garante swappability JSON->SQLite->Cloud sem refactor de business logic.',
    '["packages/listener/src/storage/","examples/","**/*.test.ts","packages/api/","packages/legacy-custodial/","packages/legacy-solana/","scripts/"]'::jsonb,
    '["fs\\.(write|read)File","supabase\\.from\\(","sqlite.*\\.prepare\\(","\\bpg\\.query\\(","\\.prepare\\(.*\\)\\.(run|get|all)"]'::jsonb
  )
ON CONFLICT (id) DO UPDATE SET
  premissa_kind = EXCLUDED.premissa_kind,
  severity = EXCLUDED.severity,
  title = EXCLUDED.title,
  body = EXCLUDED.body,
  allowlist_paths = EXCLUDED.allowlist_paths,
  detection_patterns = EXCLUDED.detection_patterns;
