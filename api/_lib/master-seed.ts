// Master-seed loader (Z45). The BIP-39 mnemonic is the keys to the kingdom:
// every invoice address derives from it, and recovery of any merchant's
// funds requires this exact seed. Production reads it from Supabase Vault
// via the service-role key (Vault decrypts on read using pgsodium). The
// env fallback exists ONLY for local dev — in CI/prod ZETTAPAY_MASTER_SEED
// is unset and the loader fails fast unless Vault is reachable.
//
// The loaded mnemonic is held in module-scope so subsequent requests reuse
// the HDKey without re-decrypting Vault. The mnemonic string itself never
// crosses a logger, sentry tag, or HTTP response.

import { getSupabaseAdmin } from './supabase.js';

const VAULT_SECRET_NAME = 'ZETTAPAY_MASTER_SEED';

let cached: string | null = null;
let cachedAt = 0;
const TTL_MS = 5 * 60 * 1000;

export interface MasterSeedLoadResult {
  mnemonic: string;
  source: 'vault' | 'env';
}

export async function loadMasterMnemonic(): Promise<MasterSeedLoadResult> {
  if (cached && Date.now() - cachedAt < TTL_MS) {
    return { mnemonic: cached, source: 'vault' };
  }

  const fromVault = await readFromVault();
  if (fromVault) {
    cached = fromVault;
    cachedAt = Date.now();
    return { mnemonic: fromVault, source: 'vault' };
  }

  const fromEnv = process.env.ZETTAPAY_MASTER_SEED?.trim();
  if (fromEnv) {
    // Loud signal — dev only path.
    // eslint-disable-next-line no-console
    console.warn('[hd-wallet] master seed loaded from env (dev fallback); production must use Supabase Vault');
    cached = fromEnv;
    cachedAt = Date.now();
    return { mnemonic: fromEnv, source: 'env' };
  }

  throw new Error('hd-wallet: master seed not configured (Supabase Vault and ZETTAPAY_MASTER_SEED both empty)');
}

/**
 * Drop the in-process cache. Use after rotating the Vault secret to force
 * the next call to re-decrypt.
 */
export function clearMasterSeedCache(): void {
  cached = null;
  cachedAt = 0;
}

async function readFromVault(): Promise<string | null> {
  const client = getSupabaseAdmin();
  if (!client) return null;
  try {
    const { data, error } = await client
      .schema('vault')
      .from('decrypted_secrets')
      .select('decrypted_secret')
      .eq('name', VAULT_SECRET_NAME)
      .maybeSingle();
    if (error) {
      // Re-throw a redacted error — never include client.error.details which
      // may surface the secret name or query in plain text.
      throw new Error(`hd-wallet: vault read failed (${error.code ?? 'unknown'})`);
    }
    const row = data as { decrypted_secret?: string | null } | null;
    const value = row?.decrypted_secret;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('hd-wallet:')) throw err;
    // Vault schema not configured — fall through to env fallback. Catch
    // type errors from the supabase client without surfacing internals.
    return null;
  }
}
