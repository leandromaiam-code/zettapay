import { describe, it, expect, beforeEach } from "vitest";
import {
  BtcReorgGuard,
  BtcReorgDetectedError,
  DoublePaymentError,
  InvalidInvoiceIndexError,
  InvoiceExpiredError,
  SweepBeforePaidError,
  assertInvoiceNotExpired,
  assertInvoicePaid,
  assertNoDoublePayment,
  assertSweepInvoiceIndexesValid,
  shouldCreateAta,
} from "../src/services/edge_cases.js";

describe("Z28.5 edge cases — chain reorg, ATA, expiry, double-pay, sweep guards", () => {
  // --- 1. chain reorg simulation BTC --------------------------------------

  describe("BtcReorgGuard (chain reorg simulation)", () => {
    let guard: BtcReorgGuard;
    beforeEach(() => {
      guard = new BtcReorgGuard();
    });

    it("accepts the first observation at a given height", () => {
      const prior = guard.observe({
        height: 800_001,
        hash: "0000000000000000000ac11ea5a8c2c2c8e3e7b00d3a1aac3a9b6e7d8f1c2b3a",
        confirmations: 1,
      });
      expect(prior).toBeNull();
      expect(guard.get(800_001)?.confirmations).toBe(1);
    });

    it("is a no-op replay when the same hash is reobserved with higher confirmations", () => {
      const hash = "deadbeefcafef00d000000000000000000000000000000000000000000000001";
      guard.observe({ height: 800_001, hash, confirmations: 1 });
      const prior = guard.observe({ height: 800_001, hash, confirmations: 6 });
      expect(prior?.hash).toBe(hash);
      // depth must advance — finalize checks it via isConfirmed
      expect(guard.isConfirmed(800_001, 6)).toBe(true);
    });

    it("throws BtcReorgDetectedError when a different hash appears at the same height", () => {
      const original = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
      const reorged = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";
      guard.observe({ height: 800_002, hash: original, confirmations: 2 });

      expect(() =>
        guard.observe({ height: 800_002, hash: reorged, confirmations: 1 }),
      ).toThrowError(BtcReorgDetectedError);

      try {
        guard.observe({ height: 800_002, hash: reorged, confirmations: 1 });
      } catch (err) {
        expect(err).toBeInstanceOf(BtcReorgDetectedError);
        const e = err as BtcReorgDetectedError;
        expect(e.height).toBe(800_002);
        expect(e.expectedHash).toBe(original);
        expect(e.observedHash).toBe(reorged);
        expect(e.status).toBe(409);
      }
    });

    it("treats `isConfirmed` as `false` below the requested depth", () => {
      guard.observe({
        height: 800_003,
        hash: "ccccc0000000000000000000000000000000000000000000000000000000000c",
        confirmations: 2,
      });
      expect(guard.isConfirmed(800_003, 6)).toBe(false);
      expect(guard.isConfirmed(800_003, 1)).toBe(true);
      expect(guard.isConfirmed(800_999, 1)).toBe(false);
    });
  });

  // --- 2. ATA missing → idempotent creation -------------------------------

  describe("shouldCreateAta (ATA missing creation)", () => {
    it("returns true when the account info lookup is null", () => {
      expect(shouldCreateAta(null)).toBe(true);
    });

    it("returns true when the account exists but has zero lamports (localnet artefact)", () => {
      expect(shouldCreateAta({ lamports: 0, data: Buffer.alloc(0) })).toBe(true);
    });

    it("returns true when the data buffer is empty (Buffer)", () => {
      expect(shouldCreateAta({ lamports: 2_039_280, data: Buffer.alloc(0) })).toBe(
        true,
      );
    });

    it("returns true when the data buffer is empty (Uint8Array)", () => {
      expect(
        shouldCreateAta({ lamports: 2_039_280, data: new Uint8Array(0) }),
      ).toBe(true);
    });

    it("returns false for an existing funded ATA with token-account data", () => {
      // Real SPL token account is 165 bytes; the contents do not matter to
      // this predicate — only the presence of allocated data.
      expect(
        shouldCreateAta({ lamports: 2_039_280, data: Buffer.alloc(165) }),
      ).toBe(false);
    });
  });

  // --- 3. invoice expirada ------------------------------------------------

  describe("assertInvoiceNotExpired (invoice expired)", () => {
    it("is a no-op when expiresAt is null (perpetual invoice)", () => {
      expect(() =>
        assertInvoiceNotExpired({ id: "inv_perpetual", expiresAt: null }, 1_700_000_000),
      ).not.toThrow();
    });

    it("is a no-op when now is strictly before expiry", () => {
      expect(() =>
        assertInvoiceNotExpired(
          { id: "inv_fresh", expiresAt: 1_700_000_100 },
          1_700_000_099,
        ),
      ).not.toThrow();
    });

    it("throws InvoiceExpiredError at the boundary (now == expiresAt)", () => {
      // Boundary policy: <= expiresAt is expired. A boundary timestamp is
      // already past — callers see this in the wild when the cron sweep
      // races the API check.
      expect(() =>
        assertInvoiceNotExpired(
          { id: "inv_boundary", expiresAt: 1_700_000_100 },
          1_700_000_100,
        ),
      ).toThrowError(InvoiceExpiredError);
    });

    it("throws InvoiceExpiredError when now is past expiry", () => {
      try {
        assertInvoiceNotExpired(
          { id: "inv_expired", expiresAt: 1_700_000_000 },
          1_700_000_500,
        );
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(InvoiceExpiredError);
        const e = err as InvoiceExpiredError;
        expect(e.invoiceId).toBe("inv_expired");
        expect(e.status).toBe(400);
      }
    });
  });

  // --- 4. double payment same invoice -------------------------------------

  describe("assertNoDoublePayment (double payment same invoice)", () => {
    it("accepts the first payment against an open invoice", () => {
      expect(() =>
        assertNoDoublePayment(
          { id: "inv_a", status: "open", paymentId: null },
          "pay_first",
        ),
      ).not.toThrow();
    });

    it("treats a same-paymentId replay as idempotent (no throw)", () => {
      // Idempotency middleware re-runs the same body on retry — a double
      // delivery of the *same* paymentId is benign.
      expect(() =>
        assertNoDoublePayment(
          { id: "inv_b", status: "paid", paymentId: "pay_first" },
          "pay_first",
        ),
      ).not.toThrow();
    });

    it("rejects a different paymentId against a paid invoice", () => {
      try {
        assertNoDoublePayment(
          { id: "inv_c", status: "paid", paymentId: "pay_first" },
          "pay_second",
        );
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(DoublePaymentError);
        const e = err as DoublePaymentError;
        expect(e.invoiceId).toBe("inv_c");
        expect(e.existingPaymentId).toBe("pay_first");
        expect(e.newPaymentId).toBe("pay_second");
        expect(e.status).toBe(409);
      }
    });

    it("rejects a different paymentId even after sweep", () => {
      expect(() =>
        assertNoDoublePayment(
          { id: "inv_d", status: "swept", paymentId: "pay_first" },
          "pay_second",
        ),
      ).toThrowError(DoublePaymentError);
    });
  });

  // --- 5. sweep before paid -----------------------------------------------

  describe("assertInvoicePaid (sweep before paid)", () => {
    it("accepts an invoice in paid status", () => {
      expect(() =>
        assertInvoicePaid({ id: "inv_p", status: "paid", paymentId: "pay_a" }),
      ).not.toThrow();
    });

    it("rejects an open invoice (no payment yet observed)", () => {
      try {
        assertInvoicePaid({ id: "inv_o", status: "open", paymentId: null });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SweepBeforePaidError);
        const e = err as SweepBeforePaidError;
        expect(e.invoiceId).toBe("inv_o");
        expect(e.status).toBe(400);
      }
    });

    it("rejects an already-swept invoice (premature retry)", () => {
      // Retrying a sweep against an already-swept invoice is also a logic
      // bug — the cron worker double-scheduled. Reject so the audit trail
      // shows the request, not a silent no-op.
      expect(() =>
        assertInvoicePaid({ id: "inv_s", status: "swept", paymentId: "pay_a" }),
      ).toThrowError(SweepBeforePaidError);
    });

    it("rejects an expired invoice (cannot sweep funds that never arrived)", () => {
      expect(() =>
        assertInvoicePaid({ id: "inv_x", status: "expired", paymentId: null }),
      ).toThrowError(SweepBeforePaidError);
    });

    it("rejects a refunded invoice", () => {
      expect(() =>
        assertInvoicePaid({
          id: "inv_r",
          status: "refunded",
          paymentId: "pay_a",
        }),
      ).toThrowError(SweepBeforePaidError);
    });
  });

  // --- 6. sweep with invalid invoice indexes ------------------------------

  describe("assertSweepInvoiceIndexesValid (sweep with invalid invoice_ids)", () => {
    it("accepts a single in-range index", () => {
      expect(() => assertSweepInvoiceIndexesValid([0], 3)).not.toThrow();
    });

    it("accepts the full in-range set", () => {
      expect(() =>
        assertSweepInvoiceIndexesValid([0, 1, 2], 3),
      ).not.toThrow();
    });

    it("accepts bigint indexes (matching on-chain u64 wire format)", () => {
      expect(() =>
        assertSweepInvoiceIndexesValid([0n, 1n], 3),
      ).not.toThrow();
    });

    it("rejects an empty index list with reason=empty", () => {
      try {
        assertSweepInvoiceIndexesValid([], 3);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidInvoiceIndexError);
        expect((err as InvalidInvoiceIndexError).reason).toBe("empty");
        expect((err as InvalidInvoiceIndexError).status).toBe(400);
      }
    });

    it("rejects duplicate indexes with reason=duplicate", () => {
      try {
        assertSweepInvoiceIndexesValid([0, 1, 1], 3);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as InvalidInvoiceIndexError).reason).toBe("duplicate");
      }
    });

    it("rejects indexes >= invoiceCount with reason=out_of_range", () => {
      try {
        assertSweepInvoiceIndexesValid([0, 5], 3);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as InvalidInvoiceIndexError).reason).toBe("out_of_range");
      }
    });

    it("rejects negative indexes with reason=out_of_range", () => {
      try {
        assertSweepInvoiceIndexesValid([-1], 3);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as InvalidInvoiceIndexError).reason).toBe("out_of_range");
      }
    });

    it("rejects when invoiceCount is zero (merchant has no invoices yet)", () => {
      try {
        assertSweepInvoiceIndexesValid([0], 0);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as InvalidInvoiceIndexError).reason).toBe("out_of_range");
      }
    });
  });
});
