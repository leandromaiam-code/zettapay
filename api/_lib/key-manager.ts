// KeyManager service for the Vercel /api/ lane (Z45). Wraps the pure
// derivation in ./hd-wallet around a Postgres-backed atomic allocator
// (zettapay_allocate_invoice_index function from migration
// 20260517000000_zettapay_invoices.sql) so concurrent invoice creation
// can never collide on a derivation index.

import { type SupabaseClient } from '@supabase/supabase-js';
import { HDKey } from '@scure/bip32';
import {
  deriveAddressFromMaster,
  mnemonicToMasterKey,
  pathFor,
  chainToNamespace,
  type BitcoinNetwork,
  type DerivedInvoiceAddress,
  type IndexNamespace,
  type InvoiceChain,
} from './hd-wallet.js';
import { loadMasterMnemonic } from './master-seed.js';
import { getSupabaseAdmin } from './supabase.js';

export interface IndexAllocator {
  allocate(namespace: IndexNamespace): Promise<number>;
}

export class PostgresIndexAllocator implements IndexAllocator {
  constructor(private readonly client: SupabaseClient) {}

  async allocate(namespace: IndexNamespace): Promise<number> {
    const { data, error } = await this.client.rpc('zettapay_allocate_invoice_index', {
      p_namespace: namespace,
    });
    if (error) {
      throw new Error(`hd-wallet: index allocation failed (${error.code ?? 'unknown'})`);
    }
    const allocated = typeof data === 'number' ? data : Number(data);
    if (!Number.isInteger(allocated) || allocated < 0) {
      throw new Error(`hd-wallet: allocator returned non-integer index: ${data}`);
    }
    return allocated;
  }
}

let cachedManager: KeyManager | null = null;

export class KeyManager {
  private readonly master: HDKey;
  private readonly network: BitcoinNetwork;
  private readonly allocator: IndexAllocator;

  constructor(options: { mnemonic: string; passphrase?: string; network?: BitcoinNetwork; allocator: IndexAllocator }) {
    if (!options.allocator) throw new Error('KeyManager: allocator required');
    this.master = mnemonicToMasterKey(options.mnemonic, options.passphrase ?? '');
    this.network = options.network ?? 'mainnet';
    this.allocator = options.allocator;
  }

  async deriveNext(chain: InvoiceChain): Promise<DerivedInvoiceAddress> {
    const namespace = chainToNamespace(chain);
    const index = await this.allocator.allocate(namespace);
    return deriveAddressFromMaster(this.master, chain, index, this.network);
  }

  deriveByPath(chain: InvoiceChain, path: string): DerivedInvoiceAddress {
    const expectedPrefix = chain === 'btc' ? "m/84'/0'/0'/0/" : "m/44'/60'/0'/0/";
    if (!path.startsWith(expectedPrefix)) {
      throw new Error(`KeyManager: path ${path} does not match ${chain} derivation scheme`);
    }
    const indexStr = path.slice(expectedPrefix.length);
    const index = Number.parseInt(indexStr, 10);
    if (!Number.isInteger(index) || String(index) !== indexStr) {
      throw new Error(`KeyManager: path ${path} index segment is not a uint32`);
    }
    return deriveAddressFromMaster(this.master, chain, index, this.network);
  }
}

/**
 * Returns a process-cached KeyManager. Loads the master mnemonic from
 * Supabase Vault on first use (5-min TTL). Returns null when either the
 * Supabase connection or the master seed is unavailable so callers can
 * emit a 503 instead of leaking the underlying failure.
 */
export async function getKeyManager(): Promise<KeyManager | null> {
  if (cachedManager) return cachedManager;
  const client = getSupabaseAdmin();
  if (!client) return null;
  let seed;
  try {
    seed = await loadMasterMnemonic();
  } catch {
    return null;
  }
  const network: BitcoinNetwork =
    process.env.ZETTAPAY_BTC_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
  cachedManager = new KeyManager({
    mnemonic: seed.mnemonic,
    network,
    allocator: new PostgresIndexAllocator(client),
  });
  return cachedManager;
}

/** Test/diagnostic hook — never call from request handlers. */
export function _resetKeyManagerCache(): void {
  cachedManager = null;
}

export { pathFor, chainToNamespace };
export type { InvoiceChain, IndexNamespace, BitcoinNetwork, DerivedInvoiceAddress };
