/**
 * `@zettapay/sdk/api` — client for the current ZettaPay HTTP API (self-hosted
 * listener and ZettaPay Cloud). No runtime dependencies; safe to import
 * without pulling any of the legacy Solana-era modules.
 */
export {
  ZettaPayApi,
  API_KEY_HEADER,
  API_PATH_PREFIX,
  type ZettaPayApiOptions,
  type ZettaPayTarget,
} from './client.js';
export { ZettaPayApiError, PlanLimitReachedError, RateLimitedError } from './errors.js';
export type {
  BaseAsset,
  BaseInvoiceCreated,
  BtcInvoiceCreated,
  CloudHealth,
  CreateBaseInvoiceInput,
  CreateBtcInvoiceInput,
  ListenerHealth,
  ZettaPayApiErrorBody,
  ZettaPayChain,
  ZettaPayHealth,
  ZettaPayInvoice,
  ZettaPayInvoiceStatus,
} from './types.js';
