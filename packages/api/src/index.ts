export { createApp, type CreateAppOptions } from "./app.js";
export { openDatabase, closeDatabase } from "./db/index.js";
export { HttpError } from "./lib/errors.js";
export { merchantsRouter } from "./routes/merchants.js";
export { payRouter } from "./routes/pay.js";
export { verifySignatureRouter } from "./routes/verify-signature.js";
export { idempotency } from "./middleware/idempotency.js";
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
