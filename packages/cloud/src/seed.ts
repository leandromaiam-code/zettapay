#!/usr/bin/env node
// Admin seed/onboarding util. Provisions ONE merchant: inserts the merchant row,
// its chain config (BTC xpub and/or Base xpub/fixed-address), an optional webhook
// endpoint, and a freshly minted API key — then prints the RAW key exactly once.
//
// NON-CUSTODIAL: every input is public material (xpub, receive address, webhook
// URL/secret). No private key, seed phrase or signing path is read or stored.
//
// Usage (env-driven, no flags parsing dependency):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   SEED_EMAIL=you@shop.com SEED_SHOP="My Shop" \
//   SEED_BTC_XPUB=zpub... [SEED_BASE_XPUB=xpub...] [SEED_BASE_ADDRESS=0x...] \
//   [SEED_WEBHOOK_URL=https://...] [SEED_WEBHOOK_SECRET=whsec_...] \
//   [SEED_PLAN=free|starter|pro] \
//   npm run seed --workspace @zettapay/cloud

import { randomUUID } from 'node:crypto';
import { generateApiKey } from './auth.js';
import type { CloudChain, CloudDb, MerchantChainRow } from './cloud-db.js';
import { SupabaseRestDb } from './supabase-db.js';

export interface SeedChainInput {
  chain: CloudChain;
  xpub?: string | null;
  fixedAddress?: string | null;
  evmTokens?: string[] | null;
}

export interface SeedMerchantInput {
  email: string;
  shopName: string;
  chains: SeedChainInput[];
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  keyLabel?: string | null;
  /** Subscription plan; omitted = the database default ('free'). */
  plan?: string | null;
}

export interface SeedMerchantResult {
  merchantId: string;
  /** Raw API key — surfaced to the operator ONCE, never persisted in clear. */
  apiKey: string;
  keyPrefix: string;
}

/** Provision a merchant + chains + (optional) webhook + one API key. */
export async function seedMerchant(db: CloudDb, input: SeedMerchantInput): Promise<SeedMerchantResult> {
  if (!input.email) throw new Error('seed: email is required');
  if (!input.shopName) throw new Error('seed: shopName is required');
  if (input.chains.length === 0) throw new Error('seed: at least one chain is required');

  const merchantId = randomUUID();
  const now = new Date().toISOString();

  await db.insertMerchant({
    id: merchantId,
    auth_uid: null,
    email: input.email,
    name: input.shopName,
    ...(input.plan ? { plan: input.plan } : {}),
    created_at: now,
  });

  for (const c of input.chains) {
    if (!c.xpub && !c.fixedAddress) {
      throw new Error(`seed: chain "${c.chain}" needs an xpub or a fixed address`);
    }
    const row: MerchantChainRow = {
      id: randomUUID(),
      merchant_id: merchantId,
      chain: c.chain,
      xpub: c.xpub ?? null,
      fixed_address: c.fixedAddress ?? null,
      evm_tokens: c.evmTokens ?? null,
      next_child_index: 0,
      created_at: now,
    };
    await db.insertChain(row);
  }

  if (input.webhookUrl) {
    await db.insertWebhook({
      id: randomUUID(),
      merchant_id: merchantId,
      url: input.webhookUrl,
      secret_enc: input.webhookSecret ?? '',
      created_at: now,
    });
  }

  const apiKey = generateApiKey();
  await db.insertApiKey({
    id: randomUUID(),
    merchant_id: merchantId,
    api_key_hash: apiKey.hash,
    key_prefix: apiKey.prefix,
    label: input.keyLabel ?? null,
    created_at: now,
    revoked_at: null,
  });

  return { merchantId, apiKey: apiKey.key, keyPrefix: apiKey.prefix };
}

function chainsFromEnv(env: NodeJS.ProcessEnv): SeedChainInput[] {
  const chains: SeedChainInput[] = [];
  if (env.SEED_BTC_XPUB) chains.push({ chain: 'btc', xpub: env.SEED_BTC_XPUB });
  if (env.SEED_BASE_XPUB || env.SEED_BASE_ADDRESS) {
    chains.push({
      chain: 'base',
      xpub: env.SEED_BASE_XPUB ?? null,
      fixedAddress: env.SEED_BASE_ADDRESS ?? null,
    });
  }
  return chains;
}

async function main(): Promise<void> {
  const env = process.env;
  const db = SupabaseRestDb.fromEnv(env);
  const result = await seedMerchant(db, {
    email: env.SEED_EMAIL ?? '',
    shopName: env.SEED_SHOP ?? '',
    chains: chainsFromEnv(env),
    webhookUrl: env.SEED_WEBHOOK_URL ?? null,
    webhookSecret: env.SEED_WEBHOOK_SECRET ?? null,
    keyLabel: env.SEED_KEY_LABEL ?? null,
    plan: env.SEED_PLAN ?? null,
  });

  process.stdout.write(
    [
      '',
      'merchant provisioned',
      `  merchant_id : ${result.merchantId}`,
      `  key_prefix  : ${result.keyPrefix}`,
      '',
      '  API KEY (shown once — store it now, it cannot be recovered):',
      `    ${result.apiKey}`,
      '',
    ].join('\n') + '\n',
  );
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`@zettapay/cloud seed failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
