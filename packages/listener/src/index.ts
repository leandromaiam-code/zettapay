export * from './types.js';
export * from './errors.js';
export {
  createStorage,
  createStorageAdapter,
  JsonFileStorage,
  MissingStorageDependencyError,
  SqliteStorage,
} from './storage/index.js';
export type {
  JsonFileStorageOptions,
  SqliteStorageOptions,
  StorageAdapter,
  StorageFactoryOptions,
} from './storage/index.js';

export { BtcListener } from './listener.js';
export type {
  BtcListenerOptions,
  ListenerStatus,
  Logger,
} from './listener.js';

export {
  BaseWatcher,
  DEFAULT_BASE_RPC_URL,
  USDC_BASE_ADDRESS,
} from './base-watcher.js';
export type { BaseWatcherOptions, BaseWatcherStatus } from './base-watcher.js';

export { deriveEvmAddress, toChecksumAddress } from './derive-evm.js';
export type { DeriveEvmParams, DerivedEvm } from './derive-evm.js';

export { usdToUsdc, formatUsdc, USDC_DECIMALS } from './usdc-pricing.js';

export {
  createInvoiceForMerchant,
  createBaseInvoiceForMerchant,
  buildBaseUsdcUri,
  buildBip21Uri,
  formatBtcAmount,
} from './invoice-core.js';
export type {
  CreateInvoiceParams,
  CreateInvoiceResult,
  CreateBaseInvoiceParams,
  CreateBaseInvoiceResult,
} from './invoice-core.js';

export {
  WebhookDispatcher,
  RETRY_CURVE_MS,
  MAX_ATTEMPTS,
  nextRetryDate,
} from './webhook-dispatcher.js';
export type { WebhookDispatcherOptions } from './webhook-dispatcher.js';

export { HealthServer, DEFAULT_HEALTH_PORT } from './health-server.js';
export type { HealthServerOptions } from './health-server.js';
