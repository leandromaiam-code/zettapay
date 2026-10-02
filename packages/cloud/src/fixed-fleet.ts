// Fixed-address watcher fleet.
//
// In fixed-address mode a merchant has ONE public receive address on Base and
// each invoice is told apart by a nonce in the low decimals of the amount. The
// listener core's FixedAddressWatcher follows exactly one address, so the cloud
// runs one instance per DISTINCT fixed address across all tenants and refreshes
// that set periodically as merchants sign up. Each instance is the unmodified
// core class: it reads pending invoices through the shared StorageAdapter and
// only ever touches the ones sent to its own address.
//
// NON-CUSTODIAL: an address here is public material supplied by the merchant;
// the watcher only reads chain logs.

import {
  FixedAddressWatcher,
  lookupEvmChain,
  type FixedChainConfig,
  type Logger,
} from '@zettapay/listener';
import type { CloudDb } from './cloud-db.js';
import { SupabaseStorageAdapter } from './storage.js';

const FLEET_MERCHANT = '*cloud-fleet*';
const DEFAULT_REFRESH_MS = 60_000;

/** Public Base RPC endpoints cross-checked by quorum when none are configured. */
export const DEFAULT_BASE_RPC_URLS = [
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://base.gateway.tenderly.co',
];

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface FixedAddressFleetOptions {
  storage: SupabaseStorageAdapter;
  db: CloudDb;
  /** Base RPC endpoints (quorum list). Defaults to {@link DEFAULT_BASE_RPC_URLS}. */
  rpcUrls?: string[];
  refreshMs?: number;
  logger?: Logger;
  /** Test seam: build a watcher for one address. */
  createWatcher?: (address: string, chains: FixedChainConfig[]) => { start(): Promise<void>; stop(): Promise<void> };
}

export class FixedAddressFleet {
  private readonly storage: SupabaseStorageAdapter;
  private readonly db: CloudDb;
  private readonly refreshMs: number;
  private readonly log: Logger;
  private readonly chains: FixedChainConfig[];
  private readonly createWatcher: NonNullable<FixedAddressFleetOptions['createWatcher']>;
  private readonly watchers = new Map<string, { stop(): Promise<void> }>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(opts: FixedAddressFleetOptions) {
    this.storage = opts.storage;
    this.db = opts.db;
    this.refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
    this.log = opts.logger ?? noopLogger;
    const spec = lookupEvmChain('base');
    if (!spec) throw new Error('@zettapay/cloud: base chain is missing from the listener registry');
    const rpcUrls = opts.rpcUrls && opts.rpcUrls.length > 0 ? opts.rpcUrls : DEFAULT_BASE_RPC_URLS;
    this.chains = [{ ...spec, rpcUrl: rpcUrls[0] ?? spec.defaultRpcUrl, rpcUrls, enabledTokens: spec.tokens }];
    this.createWatcher =
      opts.createWatcher ??
      ((address, chains) =>
        new FixedAddressWatcher({
          storage: this.storage,
          merchantId: FLEET_MERCHANT,
          address,
          chains,
          logger: this.log,
        }));
  }

  /** Addresses currently being watched (lower-cased). */
  get addresses(): string[] {
    return [...this.watchers.keys()];
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.refresh();
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await Promise.allSettled([...this.watchers.values()].map((w) => w.stop()));
    this.watchers.clear();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.refresh()
        .catch((err) => this.log.error('fixed_fleet.refresh_failed', err))
        .finally(() => this.schedule());
    }, this.refreshMs);
  }

  /** Start a watcher for every fixed address that does not have one yet. */
  async refresh(): Promise<void> {
    const wanted = new Set((await this.db.listFixedAddresses()).map((a) => a.toLowerCase()));
    for (const address of wanted) {
      if (this.watchers.has(address) || this.stopped) continue;
      const watcher = this.createWatcher(address, this.chains);
      this.watchers.set(address, watcher);
      // Not awaited: the first poll talks to public RPCs and must not hold up
      // the rest of the fleet (or the API) when one of them is slow.
      void watcher.start().catch((err) => this.log.warn('fixed_fleet.watcher_start_failed', { address, err: String(err) }));
      this.log.info('fixed_fleet.watching', { address });
    }
  }
}
