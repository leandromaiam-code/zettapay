/**
 * Node-only entry point for the ZettaPay SDK. Importable as
 * `@zettapay/sdk/server`. Bundles the webhook verifier and the typed event
 * union — everything a merchant needs to write their own webhook route
 * (Next.js, Express, Fastify, Hono, etc.) without depending on the listener
 * runtime.
 *
 * Do NOT import this from browser code: depends on `node:crypto`.
 */
export {
  verifyWebhookSignature,
  WebhookSignatureError,
  type VerifyWebhookOptions,
  type WebhookSignatureErrorCode,
} from './webhook.js';

export { parseEvent } from './events.js';

export {
  ZettaPayEventSchema,
  InvoiceConfirmedSchema,
  InvoicePendingSchema,
  InvoiceExpiredSchema,
  InvoiceUnderpaidSchema,
  type ZettaPayEvent,
  type ZettaPayEventType,
  type InvoiceConfirmedEvent,
  type InvoicePendingEvent,
  type InvoiceExpiredEvent,
  type InvoiceUnderpaidEvent,
} from './types.js';

// Verifier for the webhooks the current listener / Cloud dispatcher sends.
export {
  verifyWebhook,
  computeWebhookSignature,
  WebhookVerificationError,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_ATTEMPT_HEADER,
  DEFAULT_WEBHOOK_TOLERANCE_MS,
  type VerifyWebhookInput,
  type VerifiedWebhook,
  type WebhookHeaders,
  type WebhookVerificationErrorCode,
  type ZettaPayWebhookEvent,
  type InvoiceConfirmedWebhook,
  type PaymentOrphanWebhook,
} from '../webhooks/index.js';
