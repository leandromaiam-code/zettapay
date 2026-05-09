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
export {
  ZETTAPAY_PROGRAM_ID,
  MERCHANT_HANDLE_MIN_LEN,
  MERCHANT_HANDLE_MAX_LEN,
  PAYMENT_ID_LEN,
  TX_SIGNATURE_LEN,
  isValidMerchantHandle,
  deriveMerchantBindingPda,
  derivePaymentPda,
  buildRegisterMerchantInstruction,
  buildRecordPaymentInstruction,
  registerMerchantOnChain,
  recordPayment,
  type PdaAddress,
  type BuildRegisterMerchantParams,
  type BuildRecordPaymentParams,
  type RegisterMerchantOnChainParams,
  type RecordPaymentOnChainParams,
  type SendOnChainResult,
} from './onchain.js';
export { ZETTAPAY_IDL, type ZettaPayErrorCode } from './idl/zettapay.js';
