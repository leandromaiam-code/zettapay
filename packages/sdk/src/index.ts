export {
  ZettaPayClient,
  X402_HEADER,
  type ZettaPayClientOptions,
  type PayInput,
} from './client.js';
export { ZettaPayError, fromAxiosError } from './errors.js';
export type {
  ApiErrorBody,
  HealthStatus,
  ListMerchantsOptions,
  ListMerchantsResponse,
  ListPaymentsOptions,
  ListPaymentsResponse,
  Merchant,
  PayResponse,
  PaymentRecord,
  RegisterMerchantInput,
  UpdateMerchantInput,
} from './types.js';
