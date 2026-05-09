export { buildApp, type AppHandle, type AppDependencies } from './app.js';
export { openDb, type DB, type OpenDbOptions } from './db.js';
export {
  MerchantRepository,
  type CreateMerchantInput,
  type UpdateMerchantInput,
  type ListOptions,
} from './repository.js';
export type { Merchant } from './types.js';
export { HttpError } from './errors.js';
