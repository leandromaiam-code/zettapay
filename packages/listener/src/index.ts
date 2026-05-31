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
  allocateNonce,
  encodeAmount,
  matchAmount,
  baseUnitsForUsd,
  isValidEvmAddress,
  NONCE_MAX,
  NONCE_MODULUS,
  NONCE_DECIMALS,
} from './evm-amount-nonce.js';
export type { EncodedAmount } from './evm-amount-nonce.js';

export {
  FixedAddressWatcher,
  EVM_CHAIN_REGISTRY,
  lookupEvmChain,
  parseFixedChains,
} from './fixed-address-watcher.js';
export type {
  EvmChainSpec,
  FixedChainConfig,
  FixedAddressWatcherOptions,
  FixedAddressWatcherStatus,
} from './fixed-address-watcher.js';

export {
  createInvoiceForMerchant,
  createBaseInvoiceForMerchant,
  createFixedEvmInvoiceForMerchant,
  buildBaseUsdcUri,
  buildEvmUsdcUri,
  buildBip21Uri,
  formatBtcAmount,
} from './invoice-core.js';
export type {
  CreateInvoiceParams,
  CreateInvoiceResult,
  CreateBaseInvoiceParams,
  CreateBaseInvoiceResult,
  CreateFixedEvmInvoiceParams,
  CreateFixedEvmInvoiceResult,
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
