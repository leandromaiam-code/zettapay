# Self-Hosted Listener — Architectural Design

> Canonical reference for Z55–Z62.
> Each follow-up mission MUST link the section it implements in its PR description.

## Goals

The self-hosted listener is the package merchants install on their own infrastructure to:

1. Watch on-chain activity for invoices generated from their `xpub` (BIP-84 BTC, BIP-44 EVM).
2. Dispatch HMAC-signed webhooks to the merchant's own backend when payments confirm.
3. Persist invoice + webhook state locally via a swappable `StorageAdapter`.

It MUST be **non-custodial** (no private keys, never signs on behalf of the merchant), **wallet-less** (no `wallet.connect` UI), and MUST NOT phone home to any ZettaPay-controlled endpoint. See `HR-CUSTODY`, `HR-WALLET-LESS`, `HR-PHONE-HOME`.

---

## 1. `StorageAdapter` Interface

The entire listener business logic depends only on this interface. Concrete adapters are loaded lazily based on the `STORAGE` env var.

```ts
// packages/listener/src/storage/index.ts (canonical reference)

export type Chain = 'btc' | 'polygon' | 'eth';

export type InvoiceStatus =
  | 'pending'
  | 'partial'
  | 'confirmed'
  | 'expired'
  | 'failed';

export interface Merchant {
  id: string;
  shop_name: string;
  email: string;
  xpub: string;
  webhook_url: string;
  webhook_secret_hash: string;
  next_child_index: number;
  created_at: string;
}

export type MerchantInput = Omit<Merchant, 'id' | 'next_child_index' | 'created_at'>;

export interface Invoice {
  id: string;
  merchant_id: string;
  chain: Chain;
  asset: string;
  amount: string;
  address: string;
  child_index: number | null;
  status: InvoiceStatus;
  expires_at: string;
  paid_at: string | null;
  tx_hash: string | null;
  created_at: string;
  updated_at: string;
}

export type InvoiceInput = Omit<Invoice, 'created_at' | 'updated_at' | 'paid_at' | 'tx_hash' | 'status'> & {
  status?: InvoiceStatus;
};

export interface WebhookEvent {
  id: string;
  invoice_id: string;
  payload_json: string;
  attempts: number;
  next_retry_at: string;
  delivered_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
}

export type WebhookEventInput = Omit<WebhookEvent, 'attempts' | 'delivered_at' | 'last_status_code' | 'last_error'>;

export interface WebhookDeliveryResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
  nextRetryAt?: Date | null;
}

export interface ListPendingInvoicesOpts {
  limit?: number;
  chain?: Chain;
}

export interface StorageAdapter {
  getMerchant(id: string): Promise<Merchant | null>;
  createMerchant(m: MerchantInput): Promise<Merchant>;

  createInvoice(inv: InvoiceInput): Promise<Invoice>;
  getInvoice(id: string): Promise<Invoice | null>;
  listPendingInvoices(opts?: ListPendingInvoicesOpts): Promise<Invoice[]>;
  updateInvoiceStatus(
    id: string,
    status: InvoiceStatus,
    patch?: Partial<Invoice>,
  ): Promise<Invoice>;

  recordWebhookEvent(evt: WebhookEventInput): Promise<WebhookEvent>;
  getWebhookEventsDue(now: Date, limit: number): Promise<WebhookEvent[]>;
  markWebhookDelivered(id: string, result: WebhookDeliveryResult): Promise<void>;

  /** Atomic increment of merchant.next_child_index. MUST be race-safe. */
  nextChildIndex(merchantId: string): Promise<number>;

  /** Optional cleanup hook used by the contract test harness. */
  close?(): Promise<void>;
}
```

All adapter implementations (Z56–Z59) MUST satisfy the contract test suite at `packages/listener/test/storage-contract.ts`.

---

## 2. JSON Storage Layout

Default adapter (zero deps). Lives at `~/.zettapay/data/` (overridable via `--data-dir` / `ZETTAPAY_DATA_DIR`).

```
~/.zettapay/data/
├── merchant.json
├── invoices/
│   └── inv_<id>.json
├── webhook_events/
│   └── evt_<id>.json
└── .lock                  (proper-lockfile guarded writes)
```

### `merchant.json`
| field                  | type   | notes                                              |
|------------------------|--------|----------------------------------------------------|
| `id`                   | string | UUID                                               |
| `shop_name`            | string | display name                                       |
| `email`                | string | contact (HR-PII-MINIMAL — only field beyond shop)  |
| `xpub`                 | string | BIP-84 BTC zpub or BIP-44 EVM xpub                 |
| `webhook_url`          | string | https only                                         |
| `webhook_secret_hash`  | string | sha256 of the merchant's HMAC secret (no plain)    |
| `next_child_index`     | number | monotonically increasing per address allocation    |
| `created_at`           | string | ISO-8601                                           |

### `invoices/inv_<id>.json`
| field          | type                            | notes                                |
|----------------|---------------------------------|--------------------------------------|
| `id`           | string                          | invoice id (caller-supplied)         |
| `merchant_id`  | string                          | fk merchant.id                       |
| `chain`        | `'btc' \| 'polygon' \| 'eth'`   | matches `Chain` enum                 |
| `asset`        | string                          | `BTC`, `USDC`, etc                   |
| `amount`       | string                          | decimal as string (no float)         |
| `address`      | string                          | watch-only derived from xpub         |
| `child_index`  | number \| null                  | BIP path index (null for legacy)     |
| `status`       | `InvoiceStatus`                 | see enum                             |
| `expires_at`   | string                          | ISO-8601                             |
| `paid_at`      | string \| null                  | set when status flips to confirmed   |
| `tx_hash`      | string \| null                  | settling tx                          |
| `created_at`   | string                          | ISO-8601                             |
| `updated_at`   | string                          | ISO-8601, bumped on every write      |

### `webhook_events/evt_<id>.json`
| field              | type           | notes                                       |
|--------------------|----------------|---------------------------------------------|
| `id`               | string         | event id                                    |
| `invoice_id`       | string         | fk invoice.id                               |
| `payload_json`     | string         | serialized webhook body (canonical JSON)    |
| `attempts`         | number         | retry counter                               |
| `next_retry_at`    | string         | ISO-8601 of next attempt                    |
| `delivered_at`     | string \| null | ISO-8601 of successful delivery             |
| `last_status_code` | number \| null | last HTTP status from merchant endpoint     |
| `last_error`       | string \| null | last error message                          |

### Crash safety
- Writes go to `<file>.tmp` then `rename(2)` → atomic on POSIX.
- `.lock` is acquired via `proper-lockfile` around any multi-file write (e.g. `nextChildIndex` increment alongside invoice create).

---

## 3. Dependency Graph

```
                listener-core
       (watcher, webhook-dispatcher,
        business logic — Z60–Z62)
                     |
                     v
              StorageAdapter
            (interface, abstract)
                     |
        +------------+------------+------------+
        |            |            |            |
        v            v            v            v
       json        sqlite      supabase     postgres
   (default,    (peer:        (peer:        (peer:
    zero deps)   better-      @supabase/    pg)
                 sqlite3)     supabase-js)
```

- `listener-core` NEVER imports a concrete adapter — only the interface.
- `packages/listener/src/storage/index.ts` is the factory: it inspects `STORAGE` env, then `await import('./json' | './sqlite' | './supabase' | './postgres')`.
- A peer dep import failure surfaces as `MissingStorageDependencyError` with a remediation message (e.g. `npm install better-sqlite3`).

---

## 4. CLI Command Surface

Binary: `zettapay-listener` (declared in `packages/listener/package.json#bin`).

| command                         | flags                                                                                  | purpose                                                            |
|---------------------------------|----------------------------------------------------------------------------------------|--------------------------------------------------------------------|
| `zettapay-listener init`        | `--xpub`, `--shop-name`, `--email`, `--webhook-url`, `--storage <json\|sqlite\|supabase\|postgres>`, `--data-dir` | Bootstrap merchant.json (or storage equivalent). One-shot.        |
| `zettapay-listener start`       | `--port`, `--log-level`, `--chain <btc\|polygon\|eth\|all>`                            | Run watcher + webhook dispatcher.                                  |
| `zettapay-listener migrate`     | `--from <storage>`, `--to <storage>`, `--dry-run`                                       | Bulk-copy state between adapters. Idempotent + reversible.         |
| `zettapay-listener healthcheck` | `--json`                                                                                | Exit 0 if storage + chain RPCs reachable; 1 otherwise.             |
| `zettapay-listener verify-config` | (none)                                                                                | Validates env vars + storage reachability before `start`.          |

CLI implementation lands in Z60. This doc fixes the contract.

---

## 5. Phone-Home Prohibition

The self-hosted listener MUST NOT make outbound HTTP requests to any ZettaPay-controlled host.

### Prohibited domains
- `zettapay.vercel.app`
- `zettapay.dev`
- `zettapay.com`
- `api.zettapay.*` (any subdomain)

### Permitted outbound traffic
- `mempool.space` (and merchant-supplied alternate BTC indexer host) — read-only chain data.
- `MERCHANT_WEBHOOK_URL` — the merchant's own backend (HTTPS only).
- `STORAGE` adapter URL — Supabase / Postgres if the merchant chose those adapters.
- Chain RPC URL configured by the merchant (e.g. their own Alchemy/Infura/QuickNode endpoint).

This invariant is enforced by `HR-PHONE-HOME` (see `fabric/seed/zettapay_hrs.json`). The pre-merge HR scan blocks any code under `packages/listener/` that introduces a forbidden host.

The cloud-side `@zettapay/sdk` (used by merchant frontends, not by the listener) is explicitly allow-listed — it may call the ZettaPay-hosted API. The listener may not.

---

## 6. Migration Story

JSON and SQLite (and Supabase, Postgres) MUST share the **same field names and types** so `migrate --from <a> --to <b>` is a pure round-trip.

### Field mapping (canonical)

| logical field             | json (`merchant.json` / `invoices/inv_*.json`) | sqlite column                  | supabase/postgres column      |
|---------------------------|------------------------------------------------|--------------------------------|-------------------------------|
| `merchant.id`             | `id` (string)                                  | `id TEXT PRIMARY KEY`          | `id uuid primary key`         |
| `merchant.shop_name`      | `shop_name`                                    | `shop_name TEXT NOT NULL`      | `shop_name text not null`     |
| `merchant.email`          | `email`                                        | `email TEXT NOT NULL`          | `email text not null`         |
| `merchant.xpub`           | `xpub`                                         | `xpub TEXT NOT NULL`           | `xpub text not null`          |
| `merchant.webhook_url`    | `webhook_url`                                  | `webhook_url TEXT NOT NULL`    | `webhook_url text not null`   |
| `merchant.webhook_secret_hash` | `webhook_secret_hash`                     | `webhook_secret_hash TEXT NOT NULL` | `webhook_secret_hash text not null` |
| `merchant.next_child_index` | `next_child_index`                           | `next_child_index INTEGER NOT NULL DEFAULT 0` | `next_child_index integer not null default 0` |
| `merchant.created_at`     | `created_at` (ISO-8601 string)                 | `created_at TEXT NOT NULL`     | `created_at timestamptz not null` |
| `invoice.id`              | `id`                                           | `id TEXT PRIMARY KEY`          | `id uuid primary key`         |
| `invoice.merchant_id`     | `merchant_id`                                  | `merchant_id TEXT NOT NULL`    | `merchant_id uuid not null`   |
| `invoice.chain`           | `chain`                                        | `chain TEXT NOT NULL`          | `chain text not null`         |
| `invoice.asset`           | `asset`                                        | `asset TEXT NOT NULL`          | `asset text not null`         |
| `invoice.amount`          | `amount` (decimal string)                      | `amount TEXT NOT NULL`         | `amount numeric not null`     |
| `invoice.address`         | `address`                                      | `address TEXT NOT NULL`        | `address text not null`       |
| `invoice.child_index`     | `child_index` (number\|null)                   | `child_index INTEGER`          | `child_index integer`         |
| `invoice.status`          | `status`                                       | `status TEXT NOT NULL`         | `status text not null`        |
| `invoice.expires_at`      | `expires_at`                                   | `expires_at TEXT NOT NULL`     | `expires_at timestamptz not null` |
| `invoice.paid_at`         | `paid_at`                                      | `paid_at TEXT`                 | `paid_at timestamptz`         |
| `invoice.tx_hash`         | `tx_hash`                                      | `tx_hash TEXT`                 | `tx_hash text`                |
| `invoice.created_at`      | `created_at`                                   | `created_at TEXT NOT NULL`     | `created_at timestamptz not null` |
| `invoice.updated_at`      | `updated_at`                                   | `updated_at TEXT NOT NULL`     | `updated_at timestamptz not null` |

### Reversibility guarantees
- `migrate --from json --to sqlite --dry-run` reports row counts per table — no writes.
- A real migrate run writes target rows; running the same command twice MUST be a no-op (UPSERT semantics keyed on `id`).
- `migrate --from sqlite --to json` MUST produce JSON files byte-equivalent (modulo key order; canonical JSON serializer) to the originals.

---

## 7. Conformance

Every mission in the self-hosted listener family MUST link the specific section(s) of this doc it implements, in the PR description, e.g.:

> Implements `StorageAdapter` JSON adapter conforming to `docs/architecture/self-hosted-listener-design.md#2-json-storage-layout` and `#1-storageadapter-interface`. Passes contract suite `packages/listener/test/storage-contract.ts`.

Mission-to-section map (forward planning):

| mission | sections | deliverable                                       |
|---------|----------|---------------------------------------------------|
| Z56     | §1, §2   | JSON adapter (default, zero deps)                 |
| Z57     | §1, §6   | SQLite adapter (peer: better-sqlite3)             |
| Z58     | §1, §6   | Supabase adapter (peer: @supabase/supabase-js)    |
| Z59     | §1, §6   | Postgres adapter (peer: pg)                       |
| Z60     | §3, §4   | listener-core + CLI surface                       |
| Z61     | §3, §5   | Watcher business logic (mempool.space + EVM RPC)  |
| Z62     | §3, §5   | Webhook dispatcher (HMAC sign + retry policy)     |

PRs that touch listener code without citing a section are blocked by review.
