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

## On-chain helpers (Z9 — Anchor program)

The SDK ships PDA derivation and Anchor-encoded instruction builders for the ZettaPay merchant binding program (`programs/zettapay`). The program is deployed at:

```
Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS  // devnet + localnet
```

```ts
import {
  Connection,
  Keypair,
  clusterApiUrl,
} from '@solana/web3.js';
import { randomBytes } from 'node:crypto';
import {
  registerMerchantOnChain,
  recordPayment,
  deriveMerchantBindingPda,
  derivePaymentPda,
  PAYMENT_ID_LEN,
} from '@zettapay/sdk';

const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
const owner = Keypair.generate();
const usdcTokenAccount = /* merchant's USDC ATA */ owner.publicKey;

// 1) Bind a handle on-chain (immutable PDA = [handle, owner])
const { signature, pda } = await registerMerchantOnChain({
  connection,
  owner: owner.publicKey,
  payer: owner.publicKey,
  merchantHandle: 'acme-store',
  usdcTokenAccount,
  signers: [owner],
});

// 2) Record an already-settled USDC transfer (immutable PDA = [binding, paymentId])
const paymentId = randomBytes(PAYMENT_ID_LEN);
const txSignature = randomBytes(64); // signature of the underlying SPL transfer
await recordPayment({
  connection,
  merchantBinding: pda,
  payer: owner.publicKey,
  paymentId,
  amount: 1_500_000n, // 1.5 USDC (6 decimals)
  txSignature,
  signers: [owner],
});
```

| Helper | Returns | Purpose |
| --- | --- | --- |
| `deriveMerchantBindingPda(handle, owner)` | `{ pda, bump }` | Off-chain PDA derivation matching the Rust seed contract. |
| `derivePaymentPda(merchantBinding, paymentId)` | `{ pda, bump }` | Off-chain payment receipt PDA derivation. |
| `buildRegisterMerchantInstruction(params)` | `TransactionInstruction` | Compose the `register_merchant` ix without sending. |
| `buildRecordPaymentInstruction(params)` | `TransactionInstruction` | Compose the `record_payment` ix without sending. |
| `registerMerchantOnChain(params)` | `Promise<{ signature, pda }>` | End-to-end build → sign → confirm. |
| `recordPayment(params)` | `Promise<{ signature, pda }>` | End-to-end build → sign → confirm. |

The IDL is exposed as `ZETTAPAY_IDL` for callers that want to wire it through `@coral-xyz/anchor` directly.

To redeploy the program (devnet), see `scripts/deploy-devnet.sh` at the repo root.

## High-level helpers (Z27.1 — no backend required)

These call Solana RPC + the ZettaPay program directly. No API keys, no `ZettaPayClient`.

```ts
import {
  Connection,
  Keypair,
  clusterApiUrl,
} from '@solana/web3.js';
import {
  createMerchant,
  createInvoice,
  getInvoiceStatus,
  listenPaymentEvents,
  sweep,
  USDC_DEVNET_MINT,
} from '@zettapay/sdk';

const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
const owner = Keypair.generate();

// 1) Bind merchant on-chain (creates the USDC ATA if missing)
const { merchantBinding } = await createMerchant({
  connection,
  owner,
  merchantHandle: 'acme-store',
  mint: USDC_DEVNET_MINT,
});

// 2) Off-chain: derive the payment PDA the payer must settle
const invoice = createInvoice({
  merchantHandle: 'acme-store',
  merchantOwner: owner.publicKey,
  amount: 1_500_000n, // 1.5 USDC
  expiresAt: Math.floor(Date.now() / 1000) + 600,
});

// 3) Poll status (pending | paid | expired)
const status = await getInvoiceStatus({ connection, invoice });

// 4) Push-based — subscribe to new payments for this merchant
const sub = await listenPaymentEvents({
  connection,
  merchantBinding,
  onEvent: (e) => console.log('settled', e.paymentIdHex, e.amount),
});
// later: await sub.close();

// 5) Drain merchant ATA into a treasury wallet
await sweep({
  connection,
  owner,
  mint: USDC_DEVNET_MINT,
  destination: new PublicKey('...treasury wallet...'),
});
```

| Helper | Returns | Purpose |
| --- | --- | --- |
| `createMerchant(params)` | `{ signature, merchantBinding, payoutTokenAccount, createdPayoutAta }` | One-shot on-chain merchant registration. Creates the payout ATA if missing. |
| `createInvoice(params)` | `Invoice` | Pure off-chain. Generates 32-byte invoice id + derives the payment receipt PDA the payer must settle. |
| `getInvoiceStatus({ connection, invoice })` | `{ status: 'pending' \| 'paid' \| 'expired', receipt }` | Polls the receipt PDA. Returns parsed amount + tx signature when paid. |
| `listenPaymentEvents(params)` | `{ id, close() }` | WebSocket subscription filtered to a single merchant's receipts. |
| `sweep(params)` | `{ signature, amount, source, destinationTokenAccount, noop }` | Drain an SPL token ATA to a destination wallet/account using `transferChecked`. |
