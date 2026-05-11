# Anza grants — application draft

> Submit at <https://www.anza.xyz/grants>. Anza maintains the Solana
> validator client (Agave) and runs grants for protocol-adjacent
> infrastructure.

## Submission checklist

- [ ] Founder identity verified (KYC inside the form)
- [ ] Wallet for grant disbursement (project multisig, **not** personal)
- [ ] Pitch deck attached (PDF, ≤ 12 slides)
- [ ] Demo video URL (Loom or YouTube unlisted, ≤ 5 min)
- [ ] Audit summary link from `audit/devnet-bug-bounty/`
- [ ] Repo link: <https://github.com/leandromaiam-code/zettapay>
- [ ] Docs link: <https://docs.zettapay.io>

---

## Project name

ZettaPay

## One-line description

Open-source universal payment protocol on Solana for humans and AI agents.

## Category

Payments / Developer infrastructure

## Project URL

<https://zettapay.io> · docs <https://docs.zettapay.io> · code
<https://github.com/leandromaiam-code/zettapay>

## What are you building

ZettaPay is a Solana-native payment protocol that lets merchants accept
USDC and AI agents pay autonomously. Three things make it specifically a
Solana play, not a generic payments project:

1. **Native on-chain program** (Anchor + native Rust) for merchant
   registration, invoice PDAs, and sweep flows. Source under
   [`programs/`](https://github.com/leandromaiam-code/zettapay/tree/main/programs);
   IDL exported in [`idl/`](https://github.com/leandromaiam-code/zettapay/tree/main/idl).
2. **Solana Pay URI scheme + QR generator** in `@zettapay/sdk`
   (`buildSolanaPayUrl`, `buildSolanaPayQr`) — interoperable with every
   wallet that already supports the Solana Pay spec.
3. **x402 + MCP-native AI agent flow** — an AI agent sends a signed tx
   blob in an HTTP header; we land it on Solana and notify the merchant
   via webhook. No custodial step.

## Why Solana

- Sub-second finality is a hard requirement for AI-agent payments.
  Every other L1 either confirms too slowly or imposes per-tx fees that
  break agent micro-pricing.
- USDC on Solana is the most liquid stablecoin pair globally and the
  one already trusted by merchant onramp partners (MoonPay, Coinflow).
- Solana Pay gives us a ready-made wallet UX surface — a user can
  scan a QR with Phantom and pay in one tap, with no protocol-specific
  client install.

## What does the grant unlock

| Workstream | Effort | Why it matters |
| --- | --- | --- |
| Mainnet program audit (OtterSec or Halborn) | ~$60k | Premissa I-18: audited program is a hard mainnet gate. |
| RPC + indexer infrastructure for first 12 months | ~$30k | Pre-mainnet load + agent-driven traffic profile differs from typical merchant traffic; needs dedicated capacity. |
| Solana Pay reference wallet integration grants | ~$20k | Pay 3-5 community wallet teams to wire ZettaPay invoices into their Solana Pay surface. |
| DevRel: 1 FTE for SDK examples + tutorials | ~$90k/yr | The Stripe/Vercel playbook — open SDK + great docs is the moat. |

## Traction

- Devnet live and stable since Z9 (wallet binding via memo program).
- `@zettapay/sdk`, `@zettapay/widget`, `@zettapay/embed` published on
  npm with provenance attestations.
- Public bug bounty package prepared
  ([`audit/devnet-bug-bounty/`](https://github.com/leandromaiam-code/zettapay/tree/main/audit)).
- Drop-in integrations shipped for Shopify, Webflow, raw HTML, React,
  Vue (Z31.2).
- Community SDKs under MIT in Python and Rust (Z31.3).

## Team

Solo founder + autonomous build pipeline. Founder background available on
request; pipeline architecture documented in repo CLAUDE.md.

## Open source posture

- Protocol spec and SDKs: MIT.
- Backend (API, fraud rules, billing) proprietary.
- Solana program source public; bytecode reproducibility documented in
  [`docs/operations/mainnet-deploy.mdx`](https://docs.zettapay.io/operations/mainnet-deploy).

## What we are NOT asking for

- Token launch funding. ZettaPay does not have a token and has no
  intention of issuing one.
- Liquidity mining incentives. Fees come from per-tx pricing, not
  emissions.

## Contact

`founder@zettapay.io` · Discord `zettapay#0001` · GitHub `@leandromaiam-code`

---

## Status

- Drafted: 2026-05-11
- Submitted: _pending operator review_
- Outcome: _n/a_
