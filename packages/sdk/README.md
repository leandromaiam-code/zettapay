# @zettapay/sdk

Typed TypeScript client for the ZettaPay merchant + X-402 payments API.

## Install

```bash
npm install @zettapay/sdk
```

## Usage

```ts
import { ZettaPayClient, ZettaPayError } from '@zettapay/sdk';

const client = new ZettaPayClient({ baseURL: 'https://api.zettapay.dev' });

// Register a merchant
const merchant = await client.registerMerchant({
  name: 'Acme Coffee',
  walletPubkey: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT',
  usdcAta: 'EhpbDdUDKv2Ah6yyhyqz7n9zUQqvmW1qzPKNaqgQ4kZK',
});

// Submit an X-402 payment (base64-encoded signed Solana tx)
const receipt = await client.pay({ transaction: signedTransactionBase64 });

// Look up a payment
const record = await client.getPayment(receipt.paymentId);
```

Errors thrown by the SDK are `ZettaPayError` instances exposing `code`, `status`, and `details` mirroring the API error envelope.

## API surface

| Method | HTTP | Description |
| --- | --- | --- |
| `pay(input)` | `POST /pay` | Submit a signed transaction via the `x-402-payment` header. |
| `registerMerchant(input)` | `POST /merchants` | Create a merchant. |
| `getMerchant(id)` | `GET /merchants/:id` | Fetch a merchant. |
| `listMerchants(opts)` | `GET /merchants` | Paginated merchant list. |
| `updateMerchant(id, patch)` | `PATCH /merchants/:id` | Patch a merchant. |
| `deleteMerchant(id)` | `DELETE /merchants/:id` | Remove a merchant. |
| `getPayment(id)` | `GET /payments/:id` | Fetch a recorded payment. |
| `listPayments(opts)` | `GET /payments` | Paginated payment list. |
| `health()` | `GET /healthz` | Liveness probe. |
