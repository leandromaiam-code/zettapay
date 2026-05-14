# Z28.1 — Internal devnet beta report

> Copy this file into `reports/beta-z28-1-YYYYMMDD.md` and fill it in
> alongside the auto-generated JSON report from
> `npm run beta:devnet:z28-1`. The JSON has the raw on-chain signatures;
> this markdown is the human narrative.

## Run metadata

- **Date:** YYYY-MM-DD
- **Operator:** name
- **Devnet program id:** `…`
- **RPC endpoint:** `https://api.devnet.solana.com`
- **Cohort:** five-friend codewords (e.g. `amanda, bruno, clara, diego, eva`)
- **JSON report:** `reports/beta-z28-1-YYYYMMDD.json`

## On-chain settlement summary

| Metric | Expected | Observed |
|--------|----------|----------|
| Merchants registered | 5 | |
| Invoices created | 100 | |
| Payments transferred | 100 | |
| Sweep transactions | 20 (4 batches × 5 merchants) | |
| Total USDC settled | sum of `expected_total_usdc_base_units` | |
| Customer ATA residue | `0` | |
| Wall-clock duration | 8–15 min | |

Paste the `phases[]` table from the JSON report here, one row per phase
with status and duration.

## Per-merchant cohort notes

For each of the five friends, fill in:

### Merchant: `<codeword>`

- **Master pubkey:** `…`
- **Wallet used:** Phantom / Solflare / hardware / mobile / other
- **Time-to-first-payment:** N seconds from QR display
- **Failed attempts before success:** N (paste exact error strings)
- **Cohort verbatim:** "would they ship a real customer through this today? what would block them?"

(repeat per merchant)

## Bugs filed

Use the rubric from the runbook. Promote any auto-detected bugs from
`report.bugs[]` (JSON) into this section with operator commentary.

### Bug B-001 — `<short summary>`

- **Severity:** critical | high | medium | low
- **Phase:** Phase N — name
- **Repro steps:** numbered
- **Expected behavior:**
- **Actual behavior:**
- **Tx signatures / log lines:**
- **Owner (mission ticket):** Z…

(repeat per bug)

## Webhook surface observations (Phase 6)

Only fill in if `BETA_API_URL` was set during the run.

- **API endpoint exercised:** `…/webhooks/events`
- **Event rows returned:** N (paste raw counts)
- **HMAC verification observed?** yes / no (test by replaying with a
  tampered body — must reject)
- **Idempotency observed?** yes / no (test by re-delivering the same
  `X-ZettaPay-Event-Id` — must dedupe)
- **Retry behavior on 5xx?** observed N retries with exponential
  backoff matching `DEFAULT_RETRY_DELAYS_MS`?

## Sprint-level conclusions

One paragraph on whether Z28 (validação devnet, 4 sem) is on track or
needs an extension. Cite the bug count by severity and the cohort's
go/no-go signal.

## Follow-up missions opened

- Z…-… — `<short title>` — critical bug
- Z…-… — `<short title>` — high bug
- Z…-… — `<short title>` — high bug
- (… etc)
