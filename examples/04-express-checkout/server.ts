/**
 * Express merchant integration with @zettapay/sdk.
 */

import express, { type Request, type Response } from "express";
import { ZettaPay } from "@zettapay/sdk";

const zp = new ZettaPay({ apiKey: process.env.ZETTAPAY_API_KEY ?? "" });

const app = express();
app.use(express.json());

app.post("/checkout", async (req: Request, res: Response) => {
  const { amount, sku } = req.body as { amount: string; sku: string };
  const intent = await zp.payments.create({
    amount,
    currency: "USDC",
    metadata: { sku },
    idempotencyKey: `${sku}-${Date.now()}`,
  });
  res.json({ paymentUrl: intent.paymentUrl, reference: intent.reference });
});

app.get("/payments/:reference", async (req: Request, res: Response) => {
  const payment = await zp.payments.retrieve(req.params.reference);
  res.json(payment);
});

app.listen(Number(process.env.PORT ?? 3000), () => {
  console.log("listening on :3000");
});
