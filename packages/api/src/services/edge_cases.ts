/**
 * Z28.5 — devnet validation edge cases.
 *
 * Six guards covering the failure modes that surfaced (or were latent) during
 * devnet stress. Each lives as a pure function so it can be exercised in
 * unit tests without spinning up a Solana node, a webhook, or a DB, and so
 * the same predicate can be reused by routes, indexers, and the cron worker
 * without duplicating logic.
 *
 *   1. `BtcReorgGuard`            — short-fork detection for SPV proofs
 *   2. `shouldCreateAta`          — idempotency probe before sending the
 *                                   `createAssociatedTokenAccountIdempotentInstruction`
 *   3. `assertInvoiceNotExpired`  — TTL guard before settlement / payment record
 *   4. `assertNoDoublePayment`    — second receipt against the same invoice
 *   5. `assertInvoicePaid`        — refuses to sweep an unpaid invoice
 *   6. `assertSweepInvoiceIndexesValid` — non-empty, in-range, unique
 *
 * The errors are HTTP-shaped so the existing express error middleware can
 * surface them with sensible status codes without per-route translation.
 */
import { ConflictError, HttpError, ValidationError } from "../lib/errors.js";

/** Status the off-chain ledger assigns once a payment has been observed. */
export type InvoicePaymentStatus = "open" | "paid" | "swept" | "expired" | "refunded";

// --- 1. BTC chain reorg simulation ----------------------------------------

/**
 * Block hash divergence at a given Bitcoin block height. The chain
 * reorganised after we accepted the original block, and a different miner's
 * block is now canonical at that height.
 *
 * `expectedHash` is the previously-accepted hash; `observedHash` is the new
 * one. Both are 32-byte hex strings in big-endian (the form Bitcoin RPCs
 * surface — distinct from the internal little-endian byte order used by
 * `sha256d`). The guard works on whatever string form the caller picks, as
 * long as it is used consistently.
 */
export class BtcReorgDetectedError extends ConflictError {
  readonly height: number;
  readonly expectedHash: string;
  readonly observedHash: string;
  constructor(height: number, expectedHash: string, observedHash: string) {
    super(
      `Bitcoin chain reorg detected at height ${height}: ${expectedHash} -> ${observedHash}`,
      { height, expectedHash, observedHash },
    );
    this.name = "BtcReorgDetectedError";
    this.height = height;
    this.expectedHash = expectedHash;
    this.observedHash = observedHash;
  }
}

/**
 * In-memory tracker for the Bitcoin block hash observed at each height the
 * indexer has accepted. The class is intentionally minimal: a one-process
 * map is enough for the devnet validation stage where this surfaces. In
 * production the same predicate runs against the Postgres ledger.
 *
 * Confirmations are tracked alongside the hash because the right reaction
 * to a reorg depends on depth: a 1-confirm divergence is routine; a
 * 6-confirm divergence is an incident.
 */
export interface BtcBlockObservation {
  height: number;
  /** 32-byte block hash in whatever encoding the caller uses consistently. */
  hash: string;
  /** Tip-height minus block-height at observation time. */
  confirmations: number;
}

export class BtcReorgGuard {
  private readonly blocks = new Map<number, BtcBlockObservation>();

  /**
   * Record a new observation for `height`. Returns the previous observation
   * if one existed at that height (useful for callers that want to log the
   * full transition); throws `BtcReorgDetectedError` if the hash diverged.
   *
   * Same hash on the same height is a no-op replay — common when the
   * indexer reprocesses the same block as confirmations grow. We update the
   * confirmation count in place so later checks see fresh depth.
   */
  observe(observation: BtcBlockObservation): BtcBlockObservation | null {
    const prior = this.blocks.get(observation.height) ?? null;
    if (prior && prior.hash !== observation.hash) {
      throw new BtcReorgDetectedError(
        observation.height,
        prior.hash,
        observation.hash,
      );
    }
    this.blocks.set(observation.height, observation);
    return prior;
  }

  /**
   * Read-only lookup. Returns `null` when the height has not been seen.
   * Distinct from `observe` so the SPV finaliser can sanity-check a proof's
   * block height against a known good hash without inadvertently updating
   * the tracker with whatever the caller supplied.
   */
  get(height: number): BtcBlockObservation | null {
    return this.blocks.get(height) ?? null;
  }

  /**
   * `true` once the block at `height` has reached the configured depth.
   * Used to gate `finalize_btc_payment` — a proof under min confirmations
   * is treated as not-yet-final because a reorg can still vacate it.
   */
  isConfirmed(height: number, minConfirmations: number): boolean {
    const obs = this.blocks.get(height);
    return obs !== undefined && obs.confirmations >= minConfirmations;
  }

  /** Test seam. */
  reset(): void {
    this.blocks.clear();
  }
}

// --- 2. ATA missing → idempotent creation --------------------------------

/**
 * The merchant's USDC Associated Token Account is created lazily — the very
 * first payment is also the request that funds rent for the ATA. Callers
 * use `createAssociatedTokenAccountIdempotentInstruction` so the instruction
 * is safe to re-include on every transfer, but the off-chain layer still
 * wants to *know* whether the account is being created so it can audit
 * the rent cost and surface it on the first webhook.
 *
 * Returns `true` when the account did not exist (and the idempotent ix
 * will allocate it), `false` when it already existed.
 */
export function shouldCreateAta(
  ataAccountInfo: { lamports: number; data: Buffer | Uint8Array } | null,
): boolean {
  // `getAccountInfo` returns `null` for an unallocated account. A zero-data
  // zero-lamport entry (rare, but possible in localnet replay artifacts) is
  // treated the same — the SPL token program will still allocate on first
  // touch. We bias toward "create" rather than risk skipping a needed
  // allocation, which would surface as a `TokenAccountNotFoundError` on
  // the transfer.
  if (ataAccountInfo === null) return true;
  if (ataAccountInfo.lamports === 0) return true;
  const data = ataAccountInfo.data;
  if (data instanceof Buffer) return data.length === 0;
  return data.byteLength === 0;
}

// --- 3. Invoice expired ----------------------------------------------------

export class InvoiceExpiredError extends ValidationError {
  readonly invoiceId: string;
  readonly expiredAt: number;
  readonly now: number;
  constructor(invoiceId: string, expiredAt: number, now: number) {
    super(`Invoice ${invoiceId} expired at ${expiredAt}; now=${now}`, {
      invoiceId,
      expiredAt,
      now,
    });
    this.name = "InvoiceExpiredError";
    this.invoiceId = invoiceId;
    this.expiredAt = expiredAt;
    this.now = now;
  }
}

export interface InvoiceTtlView {
  id: string;
  /** Unix seconds. `null` means no expiry. */
  expiresAt: number | null;
}

/**
 * Reject a payment attempt against an invoice that has aged past its TTL.
 *
 * Expiry is enforced off-chain because the on-chain `Invoice` struct does
 * not carry the field (premise 25 holds size fixed for stable rent). The
 * off-chain row is authoritative for the TTL window; the on-chain state
 * stays `OPEN` until the cron sweep flips it to `EXPIRED`.
 *
 * Pass `now` explicitly — never read `Date.now()` from this helper — so
 * tests can simulate the boundary and so the same predicate works inside
 * a transaction that already pinned a timestamp.
 */
export function assertInvoiceNotExpired(invoice: InvoiceTtlView, now: number): void {
  if (invoice.expiresAt === null) return;
  if (invoice.expiresAt <= now) {
    throw new InvoiceExpiredError(invoice.id, invoice.expiresAt, now);
  }
}

// --- 4. Double payment against the same invoice --------------------------

export class DoublePaymentError extends ConflictError {
  readonly invoiceId: string;
  readonly existingPaymentId: string;
  readonly newPaymentId: string;
  constructor(
    invoiceId: string,
    existingPaymentId: string,
    newPaymentId: string,
  ) {
    super(
      `Invoice ${invoiceId} already has payment ${existingPaymentId}; refusing duplicate ${newPaymentId}`,
      { invoiceId, existingPaymentId, newPaymentId },
    );
    this.name = "DoublePaymentError";
    this.invoiceId = invoiceId;
    this.existingPaymentId = existingPaymentId;
    this.newPaymentId = newPaymentId;
  }
}

export interface InvoicePaymentView {
  id: string;
  status: InvoicePaymentStatus;
  /** The first payment that landed against the invoice. `null` when open. */
  paymentId: string | null;
}

/**
 * Reject a second receipt against the same invoice.
 *
 * The on-chain `INVOICE_STATUS_OPEN` check is the last line of defense, but
 * by the time a second payer's transaction reaches the program both have
 * already paid Solana fees. The off-chain guard catches the race at API
 * entry so the second payer never broadcasts.
 *
 * The "same paymentId" case is treated as an idempotent replay — callers
 * already retry-safe through the idempotency middleware. Only a *different*
 * paymentId against an invoice that already has a settlement is rejected.
 */
export function assertNoDoublePayment(
  invoice: InvoicePaymentView,
  newPaymentId: string,
): void {
  if (invoice.status === "open") return;
  if (invoice.paymentId === null) return;
  if (invoice.paymentId === newPaymentId) return;
  throw new DoublePaymentError(invoice.id, invoice.paymentId, newPaymentId);
}

// --- 5. Sweep before paid -------------------------------------------------

export class SweepBeforePaidError extends ValidationError {
  readonly invoiceId: string;
  /**
   * Off-chain payment-flow status of the invoice. Distinct from the
   * inherited `HttpError.status` (HTTP code) — kept separate so the
   * express error handler can read the HTTP code without ambiguity.
   */
  readonly invoiceStatus: InvoicePaymentStatus;
  constructor(invoiceId: string, status: InvoicePaymentStatus) {
    super(
      `Invoice ${invoiceId} cannot be swept while status=${status}; requires status=paid`,
      { invoiceId, status },
    );
    this.name = "SweepBeforePaidError";
    this.invoiceId = invoiceId;
    this.invoiceStatus = status;
  }
}

/**
 * Refuse a sweep against an invoice whose off-chain payment has not been
 * observed yet.
 *
 * On-chain `process_sweep` accepts any `OPEN` invoice — by design, since
 * the contract is custody-less and never *moves* funds. The off-chain
 * layer must enforce the "payment-first" invariant, otherwise a merchant
 * dashboard click could flip an invoice to SWEPT without USDC ever
 * arriving in the ATA — destroying the audit trail downstream consumers
 * (Coinflow, Pix payouts, accounting exports) read as ground truth.
 */
export function assertInvoicePaid(invoice: InvoicePaymentView): void {
  if (invoice.status !== "paid") {
    throw new SweepBeforePaidError(invoice.id, invoice.status);
  }
}

// --- 6. Sweep with invalid invoice indexes -------------------------------

export class InvalidInvoiceIndexError extends ValidationError {
  readonly indexes: number[];
  readonly invoiceCount: number;
  readonly reason: "empty" | "duplicate" | "out_of_range";
  constructor(
    indexes: number[],
    invoiceCount: number,
    reason: "empty" | "duplicate" | "out_of_range",
  ) {
    super(`Invalid sweep invoice indexes (${reason})`, {
      indexes,
      invoiceCount,
      reason,
    });
    this.name = "InvalidInvoiceIndexError";
    this.indexes = indexes;
    this.invoiceCount = invoiceCount;
    this.reason = reason;
  }
}

/**
 * Validate the `invoice_indexes` payload of a sweep request.
 *
 * On-chain failure surfaces as `InvoicePdaMismatch` (for out-of-range
 * indexes) or `AccountInvoiceCountMismatch` (for empty/skewed account
 * arrays) — both correct, neither informative. Catching this off-chain
 * yields a usable 400 with the specific reason so the SDK can short-circuit
 * without burning a tx slot.
 *
 * Three reject reasons, surfaced in this order so the most informative
 * error wins:
 *
 *   - `empty`         — caller asked to sweep nothing.
 *   - `duplicate`     — same index listed twice; the on-chain sweep would
 *                       try to write the same invoice twice in one tx and
 *                       fail on the second `INVOICE_STATUS_OPEN` check.
 *   - `out_of_range`  — index >= `invoiceCount`; the PDA was never created.
 */
export function assertSweepInvoiceIndexesValid(
  indexes: ReadonlyArray<number | bigint>,
  invoiceCount: number | bigint,
): void {
  const normalised: number[] = [];
  for (const raw of indexes) {
    normalised.push(typeof raw === "bigint" ? Number(raw) : raw);
  }
  if (normalised.length === 0) {
    throw new InvalidInvoiceIndexError(normalised, Number(invoiceCount), "empty");
  }
  const seen = new Set<number>();
  for (const idx of normalised) {
    if (seen.has(idx)) {
      throw new InvalidInvoiceIndexError(
        normalised,
        Number(invoiceCount),
        "duplicate",
      );
    }
    seen.add(idx);
  }
  const count = Number(invoiceCount);
  for (const idx of normalised) {
    if (!Number.isFinite(idx) || idx < 0 || idx >= count) {
      throw new InvalidInvoiceIndexError(
        normalised,
        count,
        "out_of_range",
      );
    }
  }
}

// Re-export `HttpError` so callers can catch the common ancestor without
// having to import from both modules. Useful inside express error
// middlewares that branch on `err instanceof HttpError`.
export { HttpError };
