import { ZettaPayEventSchema, type ZettaPayEvent } from './types.js';

/**
 * Runtime-validate a JSON-decoded webhook body and narrow it to the typed
 * `ZettaPayEvent` discriminated union. Throws `ZodError` on schema mismatch.
 *
 * Most merchants call `verifyWebhookSignature` instead — it composes HMAC
 * verification, replay protection, and this parse in one step. Use `parseEvent`
 * directly only when the signature has already been verified upstream (e.g.
 * by an API gateway).
 */
export function parseEvent(raw: unknown): ZettaPayEvent {
  return ZettaPayEventSchema.parse(raw);
}
