// @zettapay/cloud — the managed, multi-tenant face of @zettapay/listener. It
// runs the SAME listener core (watchers, invoice derivation, retry curve) over a
// Supabase-backed StorageAdapter, so a hosted merchant and a self-hosted merchant
// settle payments byte-identically on the wire. NON-CUSTODIAL throughout: only
// public xpub / receive address / webhook secret is ever stored.

export type {
  CloudChain,
  CloudDb,
  InvoiceRow,
  ListPendingOpts,
  MerchantChainRow,
  MerchantKeyRow,
  MerchantRow,
  WebhookEventRow,
  WebhookRow,
} from './cloud-db.js';
export { MemoryCloudDb } from './cloud-db.js';

export { SupabaseRestDb } from './supabase-db.js';
export type { SupabaseRestDbOptions } from './supabase-db.js';

export { SupabaseStorageAdapter } from './storage.js';
export type { ChainConfig } from './storage.js';

export {
  authenticate,
  CloudRateLimiter,
  DEFAULT_CLOUD_RATE_LIMIT,
  generateApiKey,
  hashApiKey,
  safeEqualHex,
} from './auth.js';
export type {
  AuthResult,
  GeneratedApiKey,
  RateLimitConfig,
  RateLimitDecision,
} from './auth.js';

export { buildCheckoutView, CloudApiServer, serializeInvoice } from './server.js';
export type { CloudApiServerOptions } from './server.js';

export { CloudWebhookDispatcher, startCloudFleet } from './webhook-fleet.js';
export type {
  CloudFleet,
  CloudFleetOptions,
  CloudWebhookDispatcherOptions,
} from './webhook-fleet.js';

export { seedMerchant } from './seed.js';
export type {
  SeedChainInput,
  SeedMerchantInput,
  SeedMerchantResult,
} from './seed.js';
