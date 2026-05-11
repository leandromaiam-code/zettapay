# 06 · Proof formats

A "payment proof" is whatever a relying party (merchant, agent host,
indexer) accepts as evidence that a particular USDC transfer
discharged a particular invoice. ZettaPay defines two proof
formats — one carried in an HTTP header (x402, for AI agent
settlement), and one read from chain state (the canonical settlement
proof, identical for human and agent flows).

## 1. x402 — agent-side payment authorization

x402 is an open spec for autonomous-agent payments. The agent
attaches a **signed Solana transaction blob** to its HTTP request;
the upstream service (ZettaPay) submits the transaction and returns a
confirmation.

### Header

```
x-402-payment: <base64(Transaction)>
```

| Field | Constraint |
| --- | --- |
| Encoding | Standard base64 (RFC 4648), no URL-safe variant |
| Decoded payload | Serialized legacy or v0 Solana transaction |
| Size | ≤ 1232 bytes (Solana packet limit) |
| Signature | The payer's signature MUST verify against the embedded payer pubkey |

### Validation rules

| Check | Failure `code` |
| --- | --- |
| Header present | `missing_header` |
| Valid base64 | `invalid_encoding` |
| Parses as a Solana transaction | `malformed_transaction` |
| Legacy or v0 (versioned not yet supported) | `unsupported_version` |
| Payer signature present | `missing_signatures` |
| Signature verifies against embedded payer pubkey | `invalid_signature` |
| Decoded length ≤ 1232 bytes | `malformed_transaction` |

A failed check returns HTTP `400` with the corresponding `code`. No
side effects — the transaction is not submitted.

### Flow

1. **Quote.** The agent calls the merchant's `/quote` endpoint and
   receives merchant id, amount, and a recent blockhash.
2. **Build.** The agent constructs a `transferChecked` over USDC,
   payer → merchant ATA, and signs the transaction.
3. **Encode.** The serialized transaction is base64-encoded.
4. **Submit.** The agent calls `POST /pay` with the blob in
   `x-402-payment`. The `payerWallet` field in the body is
   redundant — the wallet is derived from the embedded signature.
5. **Confirm.** ZettaPay submits the transaction, awaits
   confirmation, and returns the standard payment response (see
   "Settlement confirmation" below).

### Minimal client snippet

```ts
import { Connection, Transaction } from '@solana/web3.js';
import { createTransferCheckedInstruction } from '@solana/spl-token';

const tx = new Transaction({
  feePayer: payer.publicKey,
  recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
});
tx.add(
  createTransferCheckedInstruction(
    payerAta, USDC_MINT, merchantAta, payer.publicKey,
    BigInt(amountUsdc * 1_000_000), 6,
  ),
);
tx.sign(payer);

const blob = tx.serialize().toString('base64');

await fetch('https://api.zettapay.io/pay', {
  method: 'POST',
  headers: {
    'x-zettapay-api-key': API_KEY,
    'x-402-payment': blob,
  },
  body: JSON.stringify({ merchantId: 42, amount: amountUsdc.toFixed(2) }),
});
```

### Why x402 over a custom protocol

The x402 spec is open, header-based, transport-agnostic, and already
in flight in the Anthropic agent-payments ecosystem. Adopting it
without modification keeps ZettaPay forward-compatible with whatever
agent runtimes ship next; the cost of inventing a competing
header — fragmenting agent SDK authors — is materially larger than
the cost of complying with someone else's spec.

## 2. On-chain settlement proof

Both human and agent flows produce the same on-chain artifact: a USDC
`transferChecked` from the payer's ATA to the merchant's ATA. The
**proof of settlement** is the conjunction of three observations,
each independently verifiable on-chain.

### Required observations

| # | Observation | Source |
| --- | --- | --- |
| 1 | The transaction signature is **finalized** at the cluster's commitment level | `getSignatureStatuses` |
| 2 | A `transferChecked` over the canonical USDC mint moved exactly `Invoice.amount` base units from the payer's ATA to the merchant's ATA | Parsed transaction message |
| 3 | The invoice PDA appears as a read-only **reference** on the same transaction (when correlation is desired) | Transaction account list |

Observation #3 is what lets an indexer attribute the inbound USDC to
a specific ZettaPay invoice without an off-chain lookup. The invoice
PDA is included as a Solana Pay `reference` key (see
[`01-uri-scheme.md`](./01-uri-scheme.md#zettapay-conventions)) so it
appears on the transaction's account list as a read-only entry.

### Recommended verification

```ts
import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
} from '@solana/web3.js';

async function verifySettlement(
  conn: Connection,
  txSig: string,
  expected: {
    invoicePda: PublicKey;
    merchantAta: PublicKey;
    payerAta: PublicKey;
    usdcMint: PublicKey;
    amountBaseUnits: bigint;
  },
): Promise<boolean> {
  const tx: ParsedTransactionWithMeta | null =
    await conn.getParsedTransaction(txSig, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
  if (!tx || tx.meta?.err) return false;

  // 1. Invoice PDA appears in the account keys (reference).
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  if (!keys.includes(expected.invoicePda.toBase58())) return false;

  // 2. A transferChecked over USDC for the exact amount, payer → merchant.
  for (const ix of tx.transaction.message.instructions) {
    if (!('parsed' in ix)) continue;
    const p = (ix as { parsed: { type: string; info: Record<string, string> } }).parsed;
    if (p.type !== 'transferChecked') continue;
    const info = p.info;
    if (info.mint !== expected.usdcMint.toBase58()) continue;
    if (info.source !== expected.payerAta.toBase58()) continue;
    if (info.destination !== expected.merchantAta.toBase58()) continue;
    const amount = info.tokenAmount && BigInt(
      (info.tokenAmount as unknown as { amount: string }).amount,
    );
    if (amount !== expected.amountBaseUnits) continue;
    return true;
  }
  return false;
}
```

### Why three observations, not one

A `transferChecked` alone is not enough — the chain has no way to
know which ZettaPay invoice a stray USDC transfer should discharge.
A finalized signature alone is not enough — finality says the bytes
hit the chain, not that they moved the expected amount. The
`reference` key alone is not enough — anyone can attach an arbitrary
pubkey as a reference.

The conjunction is what closes those gaps. An attacker who can fake
two of the three observations still gets caught by the third.

## 3. The Sweep marker

Once a merchant observes settlement, they call
[`Sweep`](./03-instructions.md#2--sweep) on the invoice. This flips
the on-chain `Invoice.status` from `Open = 0` to `Swept = 1` and
records `swept_at`. The marker is a **convenience receipt**, not part
of the proof of settlement:

- A `Swept` invoice with no matching USDC transfer is meaningless
  (merchant swept the wrong invoice; the only remedy is a refund
  transfer in the opposite direction).
- An `Open` invoice with a matching USDC transfer is **already
  settled** from the payer's perspective. The merchant's failure to
  sweep is their own bookkeeping problem.

Relying parties (indexers, refund flows, dispute systems) MUST treat
the on-chain transfer + the invoice reference as the authoritative
proof and treat the sweep marker as a hint about the merchant's
internal state.

## 4. Replay considerations

A signed transaction blob carried in `x-402-payment` is **single-use** in
practice because each transaction embeds a recent blockhash and the
cluster rejects duplicate signatures within the blockhash validity
window (~ 2 minutes). A replay attempt outside that window simply
fails with `BlockhashNotFound`.

For longer-lived authorizations (subscriptions, agent budgets), do
**not** stash an x402 blob. Use the subscription primitives in
[`packages/api/src/services/subscriptions.ts`](../packages/api/src/services/subscriptions.ts) — those derive a per-charge transaction from a long-lived
authorization record, signed independently each charge cycle.
