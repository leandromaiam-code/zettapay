# Solana Pay registry — PR draft

> Open as a PR against [`anza-xyz/solana-pay`](https://github.com/anza-xyz/solana-pay).
> The repo's `merchants/` (or equivalent registry directory at submission
> time) is the canonical wallet- and SDK-facing list of Solana Pay
> implementers.

## Submission checklist

- [ ] Confirm current registry path in upstream repo (`merchants/`,
      `apps/`, or `partners/` — check `CONTRIBUTING.md` first).
- [ ] Logo asset exported at the size required by upstream
      (typically 256×256 PNG, transparent background).
      Source: `public/brand/zettapay-symbol.png`.
- [ ] One screenshot of the checkout flow showing the Solana Pay QR.
- [ ] Confirm CLA / DCO requirements before pushing the branch.

## PR title

```
Add ZettaPay to the Solana Pay implementations registry
```

## PR body

```markdown
## What

Adds ZettaPay (https://zettapay.io) — an open-source Solana payment
protocol — to the Solana Pay implementations registry.

## Why

ZettaPay implements the Solana Pay URI scheme natively. Customers using
any Solana Pay-compatible wallet (Phantom, Solflare, Backpack, Glow,
mobile wallets via deeplink) can scan a ZettaPay-issued QR and complete a
USDC payment with no additional client install.

## Solana Pay coverage

- `solana:` URI builder: [`buildSolanaPayUrl`](https://github.com/leandromaiam-code/zettapay/blob/main/packages/sdk/src/solana-pay.ts)
- QR generator: [`buildSolanaPayQr`](https://github.com/leandromaiam-code/zettapay/blob/main/packages/sdk/src/solana-pay.ts)
- On-chain settlement: native SPL USDC `transferChecked` + memo binding
  (program source under [`programs/`](https://github.com/leandromaiam-code/zettapay/tree/main/programs))
- Reference docs: <https://docs.zettapay.io/concepts/architecture>

## Verification

- npm: <https://www.npmjs.com/package/@zettapay/sdk> (published with npm
  provenance attestations)
- Live devnet endpoint: <https://zettapay.vercel.app/healthz>
- Demo invoice URL: see PR comment for a fresh devnet QR (regenerated on
  request — devnet faucet limits prevent committing a permanent demo).

## Registry entry

Following the format in `<registry-path>/_template.json` at HEAD:

```json
{
  "name": "ZettaPay",
  "url": "https://zettapay.io",
  "docs": "https://docs.zettapay.io",
  "category": "payments",
  "description": "Open-source Solana USDC payment protocol for humans and AI agents.",
  "logo": "./logos/zettapay.png",
  "github": "https://github.com/leandromaiam-code/zettapay",
  "twitter": "https://twitter.com/zettapay",
  "supportsURIScheme": true,
  "supportsTransactionRequest": true,
  "license": "MIT"
}
```

If the registry uses a different schema at the time of merge, adjust to
match `CONTRIBUTING.md` rather than this template.

## Checklist

- [x] Read `CONTRIBUTING.md`.
- [x] Logo committed at the upstream-required size.
- [x] License: MIT (compatible with registry entry requirements).
- [x] No marketing language; only verifiable claims.
```

## Files to add (sketch — exact paths depend on upstream layout)

- `merchants/zettapay.json` — entry above
- `merchants/logos/zettapay.png` — 256×256 transparent PNG, copied from
  `public/brand/zettapay-symbol.png`

## Reviewer pre-flight

Before requesting review, verify upstream HEAD did not rename the
registry directory or change the entry schema. The Solana Pay repo
restructures roughly every 6 months.

---

## Status

- Drafted: 2026-05-11
- PR opened: _pending operator review_
- Merged URL: _n/a_
