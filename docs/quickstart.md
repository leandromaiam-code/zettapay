# Quickstart · 5 minutes

Accept your first USDC payment with ZettaPay on Solana devnet. The flow is the
same for AI agents and humans: register a merchant, sign a transfer, submit it
through the open `x-402-payment` header.

This document is the source for the rendered page at
[`/docs/quickstart`](https://zettapay.vercel.app/docs/quickstart).

## Prerequisites

- Node 18+, Python 3.10+, or Go 1.22+
- A Solana wallet (Phantom recommended) on devnet
- Devnet funding — claim 1000 USDC + 1 SOL once per hour from the
  [ZettaPay devnet faucet](https://zettapay.io/docs/faucet) or
  `POST https://api.zettapay.io/api/faucet { "recipient": "<your-pubkey>" }`
- A ZettaPay base URL — defaults to `https://api.zettapay.dev`

## Devnet constants

| Constant | Value |
| --- | --- |
| Cluster | `devnet` |
| USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Decimals | `6` |
| Header | `x-402-payment` |

## 1 · Install the SDK

### TypeScript

```bash
npm install @zettapay/sdk
```

### Python

```bash
# Python SDK ships in Z16.3 — use plain HTTP for now
pip install requests
```

### Go

```bash
go get github.com/leandromaiam-code/zettapay/packages/sdk-go
```

### cURL

No install — every endpoint is plain JSON over HTTPS.

## 2 · Register a merchant

`POST /merchants/register` binds your wallet on-chain via the memo program,
creates the merchant USDC ATA (the protocol pays the rent), and returns an API
key.

### TypeScript

```ts
import { ZettaPayClient } from '@zettapay/sdk';

const client = new ZettaPayClient({ baseURL: 'https://api.zettapay.dev' });

const merchant = await client.registerMerchant({
  name: 'Acme Coffee',
  email: 'owner@acme.coffee',
  walletAddress: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT',
});

console.log(merchant.id, merchant.apiKey);
```

### Python

```python
import requests

resp = requests.post(
    "https://api.zettapay.dev/merchants/register",
    json={
        "name": "Acme Coffee",
        "email": "owner@acme.coffee",
        "walletAddress": "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT",
    },
    timeout=15,
)
resp.raise_for_status()
merchant = resp.json()
print(merchant["merchant"]["id"], merchant["apiKey"])
```

### Go

```go
package main

import (
    "context"
    "log"
    "time"

    zettapay "github.com/leandromaiam-code/zettapay/packages/sdk-go"
)

func main() {
    client, _ := zettapay.NewClient(zettapay.ClientConfig{
        BaseURL: "https://api.zettapay.dev",
        Retry:   zettapay.DefaultRetryPolicy(),
    })

    ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
    defer cancel()

    merchant, err := client.RegisterMerchant(ctx, zettapay.RegisterMerchantInput{
        Name:          "Acme Coffee",
        Email:         "owner@acme.coffee",
        WalletAddress: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT",
    })
    if err != nil { log.Fatal(err) }
    log.Println(merchant.ID, merchant.APIKey)
}
```

### cURL

```bash
curl -X POST https://api.zettapay.dev/merchants/register \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "name": "Acme Coffee",
    "email": "owner@acme.coffee",
    "walletAddress": "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT"
  }'
```

> Every write endpoint accepts an `Idempotency-Key` header. The TypeScript and
> Go SDKs emit one automatically; for Python and cURL pass any UUID v4.

## 3 · Build a signed payment

ZettaPay never custodies funds. The payer signs an SPL `transferChecked`
transaction client-side; the API only relays it.

### TypeScript

```ts
import {
  Connection, PublicKey, Transaction, clusterApiUrl,
} from '@solana/web3.js';
import {
  createTransferCheckedInstruction, getAssociatedTokenAddress,
} from '@solana/spl-token';

const connection = new Connection(clusterApiUrl('devnet'));
const usdcMint = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

const payerAta    = await getAssociatedTokenAddress(usdcMint, payer.publicKey);
const merchantAta = await getAssociatedTokenAddress(usdcMint, merchantPubkey);

const ix = createTransferCheckedInstruction(
  payerAta, usdcMint, merchantAta, payer.publicKey,
  1_500_000, // 1.50 USDC (6 decimals)
  6,
);

const tx = new Transaction().add(ix);
tx.feePayer = payer.publicKey;
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
tx.sign(payer);

const signedBase64 = tx.serialize().toString('base64');
```

### Python

```python
import base64
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solana.rpc.api import Client
from solana.transaction import Transaction
from spl.token.instructions import transfer_checked, TransferCheckedParams
from spl.token.constants import TOKEN_PROGRAM_ID

USDC = Pubkey.from_string("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")
client = Client("https://api.devnet.solana.com")

ix = transfer_checked(TransferCheckedParams(
    program_id=TOKEN_PROGRAM_ID,
    source=payer_ata,
    mint=USDC,
    dest=merchant_ata,
    owner=payer.pubkey(),
    amount=1_500_000, # 1.50 USDC
    decimals=6,
    signers=[],
))

tx = Transaction().add(ix)
tx.recent_blockhash = client.get_latest_blockhash().value.blockhash
tx.sign(payer)

signed_b64 = base64.b64encode(bytes(tx)).decode()
```

### Go

```go
import (
    "encoding/base64"
    solana "github.com/gagliardetto/solana-go"
    "github.com/gagliardetto/solana-go/programs/token"
    "github.com/gagliardetto/solana-go/rpc"
)

usdc := solana.MustPublicKeyFromBase58("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")
client := rpc.New(rpc.DevNet_RPC)

ix := token.NewTransferCheckedInstruction(
    1_500_000, 6, // 1.50 USDC
    payerATA, usdc, merchantATA, payer.PublicKey(),
    []solana.PublicKey{},
).Build()

recent, _ := client.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
tx, _ := solana.NewTransaction(
    []solana.Instruction{ix},
    recent.Value.Blockhash,
    solana.TransactionPayer(payer.PublicKey()),
)
_, _ = tx.Sign(func(k solana.PublicKey) *solana.PrivateKey { return &payer })

raw, _ := tx.MarshalBinary()
signedB64 := base64.StdEncoding.EncodeToString(raw)
```

### cURL

cURL does not sign Solana transactions on its own. Use any of the SDK examples
above to obtain `$SIGNED_TX_BASE64`, then continue at step 4.

## 4 · Submit via the x402 header

```ts
const receipt = await client.pay({ transaction: signedBase64 });
console.log(receipt.paymentId, receipt.status, receipt.signature);
```

```python
resp = requests.post(
    "https://api.zettapay.dev/pay",
    headers={
        "x-402-payment": signed_b64,
        "Idempotency-Key": str(uuid.uuid4()),
    },
    timeout=30,
)
receipt = resp.json()
```

```go
receipt, err := client.PayBase64(ctx, signedB64)
```

```bash
curl -X POST https://api.zettapay.dev/pay \
  -H "x-402-payment: $SIGNED_TX_BASE64" \
  -H "Idempotency-Key: $(uuidgen)"
```

Sample response:

```json
{
  "paymentId": "pay_01HM...",
  "status":    "confirmed",
  "signature": "5jkA...",
  "merchantId":"mer_01HM...",
  "amount":    "1.50",
  "currency":  "USDC"
}
```

## 5 · Verify the receipt

Receipts are immutable and queryable. Confirmation typically lands in under one
second on devnet.

```ts
const record = await client.getPayment(receipt.paymentId);
```

```python
payment = requests.get(
    f"https://api.zettapay.dev/payments/{receipt['paymentId']}",
    timeout=10,
).json()
```

```go
payment, err := client.GetPayment(ctx, receipt.PaymentID)
```

```bash
curl https://api.zettapay.dev/payments/pay_01HM...
```

For production, subscribe to the `payment.confirmed` webhook event instead of
polling. Signatures are HMAC-SHA256 over the body.

## What's next

- [`@zettapay/sdk`](https://github.com/leandromaiam-code/zettapay/tree/main/packages/sdk) — TypeScript SDK reference
- [Go SDK](https://github.com/leandromaiam-code/zettapay/tree/main/packages/sdk-go) — context-aware Go client
- [Merchant dashboard](https://zettapay.vercel.app/dashboard) — Phantom login, balance, history
- [x402 spec](https://github.com/coinbase/x402) — the open header standard
