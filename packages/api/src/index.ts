export { createApp, type CreateAppOptions } from "./app.js";
export { openDatabase, closeDatabase } from "./db/index.js";
export { HttpError } from "./lib/errors.js";
export { merchantsRouter } from "./routes/merchants.js";
export { payRouter } from "./routes/pay.js";
export {
  paymentRouter,
  mapToUnified as mapPaymentToUnified,
  type UnifiedPayment,
} from "./routes/payment.js";
export { funnelRouter } from "./routes/funnel.js";
// Z53: payEvmRouter quarantined to packages/legacy-custodial/ (HR-CUSTODY).
export { settlementRouter } from "./routes/settlement.js";
export { verifySignatureRouter } from "./routes/verify-signature.js";
export {
  HttpCoinflowClient,
  CoinflowApiError,
  type CoinflowClient,
  type CoinflowConfig,
  type CoinflowEnvironment,
  type CoinflowWithdrawalRequest,
  type CoinflowWithdrawalResponse,
} from "./coinflow/client.js";
export {
  COINFLOW_FEE_BPS,
  computeSettlementFee,
  type FeeBreakdown,
} from "./coinflow/fee.js";
export {
  enableCoinflowSettlement,
  disableCoinflowSettlement,
  settlePayment,
  type EnableSettlementInput,
  type SettlePaymentInput,
} from "./coinflow/service.js";
export {
  HttpBitprecoClient,
  HttpTransferoClient,
  PixApiError,
  createPixClient,
  isPixKeyType,
  isPixProvider,
  PIX_KEY_TYPES,
  PIX_PROVIDERS,
  type PixClient,
  type PixConfig,
  type PixEnvironment,
  type PixKeyType,
  type PixProvider,
  type PixWithdrawalRequest,
  type PixWithdrawalResponse,
} from "./pix/client.js";
export {
  PIX_FEE_BPS,
  computePixSettlementFee,
} from "./pix/fee.js";
export {
  enablePixSettlement,
  disablePixSettlement,
  settlePaymentToPix,
  type EnablePixSettlementInput,
  type SettlePixPaymentInput,
} from "./pix/service.js";
export {
  pixRouter,
  type PixClientResolver,
  type PixRouterDeps,
} from "./routes/pix.js";
export { idempotency } from "./middleware/idempotency.js";
export { initTracing, type TracingHandle } from "./lib/tracing.js";
export { getTracer, withSpan, withSpanSync, recordSpanError } from "./lib/tracer.js";
export {
  beginInstall as beginShopifyInstall,
  completeInstall as completeShopifyInstall,
  defaultTokenExchanger as defaultShopifyTokenExchanger,
  type ShopifyAppConfig,
  type ShopifyTokenExchanger,
  type TokenExchangeResponse as ShopifyTokenExchangeResponse,
} from "./services/shopify.js";
export {
  isValidShopDomain,
  normalizeShopDomain,
  verifyShopifyOAuthHmac,
  verifyShopifyWebhookHmac,
  SHOPIFY_HMAC_HEADER,
  SHOPIFY_SHOP_DOMAIN_HEADER,
  type ShopifyHmacResult,
  type ShopifyHmacFailure,
} from "./lib/shopify.js";
export { shopifyRouter } from "./routes/shopify.js";
export {
  GracefulShutdown,
  type CloseHook,
  type GracefulShutdownOptions,
  type ServerLike,
} from "./lib/shutdown.js";
export {
  signWebhookPayload,
  verifyWebhookSignature,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  EVENT_ID_HEADER,
  type SignWebhookOptions,
  type VerifyWebhookOptions,
  type VerifyResult,
  type VerifyFailureReason,
} from "./lib/webhook-signature.js";
export { SolanaService, type SolanaConfig } from "./services/solana.js";
// Z53: EvmService + createEvmPayment quarantined to packages/legacy-custodial/ (HR-CUSTODY).
export {
  SUPPORTED_EVM_CHAINS,
  EVM_CHAIN_REGISTRY,
  DEFAULT_EVM_CURRENCY,
  isSupportedEvmChain,
  normalizeEvmChain,
  resolveEvmToken,
  resolveRpcUrl,
  isHexAddress,
  type EvmChain,
  type EvmCurrency,
  type EvmChainDefinition,
  type EvmTokenDefinition,
  type ResolvedEvmToken,
} from "./lib/chains.js";
export {
  WEBHOOK_QUEUE_NAME,
  WEBHOOK_JOB_NAME,
  DEFAULT_WEBHOOK_JOB_OPTIONS,
  createWebhookQueue,
  enqueueWebhookDelivery,
  type WebhookDeliveryJob,
  type CreateWebhookQueueOptions,
} from "./lib/webhook-queue.js";
export {
  startWebhookWorker,
  type WebhookWorkerOptions,
  type WebhookWorkerHandle,
} from "./services/webhook_worker.js";
export { kycRouter, type KycRouterOptions } from "./routes/kyc.js";
export type {
  KycProviderClient,
  AccessTokenInput,
  AccessTokenResult,
  CreateApplicantInput,
  CreateApplicantResult,
  WebhookVerifyResult,
} from "./services/kyc/provider.js";
export {
  createSumsubClient,
  verifySumsubWebhook,
  mapSumsubReview,
  type SumsubConfig,
  type SumsubReviewPayload,
  type MappedSumsubVerdict,
} from "./services/kyc/sumsub.js";
export {
  startKyc,
  recordDocument,
  getKycStatus,
  applyWebhookEvent,
  type StartKycInput,
  type StartKycResult,
  type RecordDocumentInput,
  type RecordDocumentResult,
  type KycStatusView,
} from "./services/kyc/service.js";
export type {
  KycProvider,
  KycStatus,
  KycVerification,
  KycDocument,
} from "./db/kyc.js";
export {
  appendAudit,
  listAuditEntries,
  type AuditJournalEntry,
} from "./db/audit_journal.js";
export {
  IncidentService,
  type Incident,
  type IncidentSeverity,
  type IncidentStatus,
  type IncidentUpdate,
  type OpenIncidentInput,
  type PostUpdateInput,
} from "./services/incident.js";
export { incidentGuard } from "./middleware/incident-guard.js";
export { incidentsRouter, type IncidentsRouterDeps } from "./routes/incidents.js";
