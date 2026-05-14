/**
 * Shopify webhook receiver — orders/create → ZettaPay payment intent.
 */

import crypto from "node:crypto";
import express, { type Request, type Response } from "express";

type ShopifyOrder = {
  id: number;
  email: string;
  total_price: string;
  currency: string;
};

const SHARED_SECRET = process.env.SHOPIFY_SHARED_SECRET ?? "";
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN ?? "";
const ZETTAPAY_API = process.env.ZETTAPAY_API ?? "https://zettapay.vercel.app";
const API_KEY = process.env.ZETTAPAY_API_KEY ?? "";

const orderRefs = new Map<string, number>();

function verifyShopify(rawBody: Buffer, headerHmac: string): boolean {
  const digest = crypto
    .createHmac("sha256", SHARED_SECRET)
    .update(rawBody)
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(headerHmac));
}

async function createZettaPayment(order: ShopifyOrder): Promise<{
  paymentUrl: string;
  reference: string;
}> {
  const res = await fetch(`${ZETTAPAY_API}/payments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
      "idempotency-key": `shopify-order-${order.id}`,
    },
    body: JSON.stringify({
      amount: order.total_price,
      currency: "USDC",
      customerEmail: order.email,
      metadata: { shopify_order_id: order.id },
    }),
  });
  if (!res.ok) throw new Error(`zettapay ${res.status}`);
  return (await res.json()) as { paymentUrl: string; reference: string };
}

async function markShopifyPaid(orderId: number, signature: string): Promise<void> {
  await fetch(
    `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2025-01/orders/${orderId}/transactions.json`,
    {
      method: "POST",
      headers: {
        "x-shopify-access-token": ADMIN_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        transaction: { kind: "capture", status: "success", gateway: "zettapay", message: signature },
      }),
    },
  );
}

const app = express();

app.post(
  "/shopify/orders-create",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const hmac = req.header("x-shopify-hmac-sha256") ?? "";
    if (!verifyShopify(req.body as Buffer, hmac)) {
      res.status(401).send("bad hmac");
      return;
    }
    const order = JSON.parse(req.body.toString("utf8")) as ShopifyOrder;
    const intent = await createZettaPayment(order);
    orderRefs.set(intent.reference, order.id);
    res.json({ paymentUrl: intent.paymentUrl });
  },
);

app.post("/zettapay/webhook", express.json(), async (req: Request, res: Response) => {
  const event = req.body as { type: string; data: { reference: string; signature: string } };
  if (event.type === "payment.confirmed") {
    const orderId = orderRefs.get(event.data.reference);
    if (orderId) {
      await markShopifyPaid(orderId, event.data.signature);
      orderRefs.delete(event.data.reference);
    }
  }
  res.json({ ok: true });
});

app.listen(Number(process.env.PORT ?? 4000));
