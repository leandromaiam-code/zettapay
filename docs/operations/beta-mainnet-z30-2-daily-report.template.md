---
title: "Z30.2 — mainnet beta daily report"
description: "Per-day operator report template for the 60-day mainnet beta window."
---

# ZettaPay mainnet beta daily report

> Fill one of these per day. Append to the cohort retro doc. The
> `npm run beta:mainnet:digest` output is the source of the numerical
> sections — paste it under "Automated digest", then add the human
> commentary below.

## Header

- Date (ISO 8601): `YYYY-MM-DD`
- Beta day: `N/60`
- Operator on call: `Leandro` (or designated backup)
- API URL: `https://api.zettapay.dev`
- Recommendation echoed by digest: `continue | investigate | pause`

## Automated digest

```
<paste the contents of reports/beta-mainnet-z30-2-YYYY-MM-DD.md here>
```

## Human commentary

### Cohort activity

- Merchants that transacted today: …
- Merchants idle ≥ 48h (consider follow-up): …
- Top customer (anonymised id ok): …
- Anomalies noticed by merchants (timing, retries, UX): …

### Incidents and near-misses

- Pages received from Z30.3 program monitor: `0`
- Synthetic monitor (Z30.3 ticks) failures: `0`
- Manual interventions: `(none)` _or_ describe each — actor, timestamp,
  reason, audit_journal event name.

### Cap and limit posture

- Per-merchant cap (Z22.1): `$10,000`
- Per-invoice cap (Z30.1): `$100` _(D+0 baseline) — bumped to `$500` at D+30 by Z30.4 cap upgrade orchestrator when health-gated_
- Any merchant ≥ 80% cap utilisation: `yes/no` — if yes, list and decide
  (raise cap manually, or close out their week here).

### Decisions taken today

- e.g. raised merchant `merch_xxx` velocity ceiling from 5 → 10 tx/min
  (PUT `/merchants/:id/velocity`).
- e.g. paused merchant `merch_yyy` after suspicious refund chain
  (audit_journal `merchant.paused`).
- e.g. cap upgrade scheduled at D+30 — verified via
  `audit_journal[event=cap_upgrade.set_max_invoice_amount.d30]`.

### Next steps

- Carry-over tasks: …
- Watch for tomorrow: …
- Status page (Z18) note posted: `yes/no`.

## Sign-off

- Operator signature: `Leandro` (initials)
- Report committed to: `docs/operations/reports/beta-mainnet-z30-2-YYYY-MM-DD.md`
- (Optional) Linked PR / commit hash: `…`
