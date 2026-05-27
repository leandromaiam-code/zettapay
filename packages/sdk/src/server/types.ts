import { z } from 'zod';

/**
 * Common envelope fields shared by every ZettaPay webhook event.
 * Carries the discriminator (`type`), the per-event creation time, and an
 * optional event id (the listener also sends this as `X-ZettaPay-Event-Id`,
 * which is the canonical dedup key).
 */
const EventEnvelope = {
  id: z.string().optional(),
  created_at: z.string(),
};

const InvoiceCommonData = {
  invoice_id: z.string(),
  address: z.string(),
  amount_sats: z.number().int(),
  chain: z.string().optional(),
};

export const InvoiceConfirmedSchema = z.object({
  ...EventEnvelope,
  type: z.literal('invoice.confirmed'),
  data: z.object({
    ...InvoiceCommonData,
    tx_hash: z.string(),
    confirmations: z.number().int(),
    paid_at: z.string(),
  }),
});

export const InvoicePendingSchema = z.object({
  ...EventEnvelope,
  type: z.literal('invoice.pending'),
  data: z.object({
    ...InvoiceCommonData,
    tx_hash: z.string(),
    confirmations: z.number().int(),
    seen_at: z.string(),
  }),
});

export const InvoiceExpiredSchema = z.object({
  ...EventEnvelope,
  type: z.literal('invoice.expired'),
  data: z.object({
    ...InvoiceCommonData,
    expired_at: z.string(),
  }),
});

export const InvoiceUnderpaidSchema = z.object({
  ...EventEnvelope,
  type: z.literal('invoice.underpaid'),
  data: z.object({
    ...InvoiceCommonData,
    received_sats: z.number().int(),
    tx_hash: z.string(),
    seen_at: z.string(),
  }),
});

export const ZettaPayEventSchema = z.discriminatedUnion('type', [
  InvoiceConfirmedSchema,
  InvoicePendingSchema,
  InvoiceExpiredSchema,
  InvoiceUnderpaidSchema,
]);

export type InvoiceConfirmedEvent = z.infer<typeof InvoiceConfirmedSchema>;
export type InvoicePendingEvent = z.infer<typeof InvoicePendingSchema>;
export type InvoiceExpiredEvent = z.infer<typeof InvoiceExpiredSchema>;
export type InvoiceUnderpaidEvent = z.infer<typeof InvoiceUnderpaidSchema>;

export type ZettaPayEvent = z.infer<typeof ZettaPayEventSchema>;

export type ZettaPayEventType = ZettaPayEvent['type'];
