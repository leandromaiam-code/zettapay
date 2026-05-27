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
