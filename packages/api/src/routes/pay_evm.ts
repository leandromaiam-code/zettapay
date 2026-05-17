// Z47 — /pay/evm is dead.
//
// The custodial flow (EVM_PAYER_PRIVATE_KEY signs a transfer to the
// merchant address) violates the wallet-less premise: ZettaPay never holds
// merchant funds, never signs transfers on behalf of anyone, and never
// requires a connected wallet. Z45 introduced HD-derived per-invoice
// receive addresses (one address = one invoice = one detectable Transfer)
// and Z47 wires the Base USDC listener. /pay/evm is therefore retired.
//
// Existing integrations land here for one release cycle; the body points
// callers at `POST /admin/invoices` (Z45) for the new flow.

import { Router, type Request, type Response } from "express";

const SUPERSEDED_AT = "2026-05-17";
const SUNSET_PAYLOAD = {
  error: {
    code: "gone",
    message:
      "POST /pay/evm has been retired. ZettaPay no longer custodies EVM funds. " +
      "Allocate a per-invoice receive address via POST /admin/invoices and " +
      "let the on-chain listener confirm the customer's direct Transfer.",
    supersededAt: SUPERSEDED_AT,
    migration: "https://github.com/leandromaiam-code/zettapay/blob/main/README.md#z45-master-seed-setup",
  },
} as const;

export function payEvmRouter(): Router {
  const router = Router();

  const sunset = (_req: Request, res: Response): void => {
    res.status(410).json(SUNSET_PAYLOAD);
  };

  router.post("/pay/evm", sunset);
  router.post("/pay/evm/:merchantRef", sunset);

  return router;
}
