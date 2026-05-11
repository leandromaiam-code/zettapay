# solana.com/ecosystem + Superteam — listing draft

> Two-target file. Both surfaces are owned by the Solana Foundation
> orbit and are the canonical "official" discovery directories.

## Submission checklist

- [ ] Brand kit prepared: wordmark light + dark, symbol, 256×256 logo.
- [ ] One demo video (Loom unlisted, ≤ 3 min).
- [ ] Production URL live, healthcheck returning 200
      (<https://zettapay.vercel.app/healthz>).
- [ ] Founder LinkedIn / Twitter / GitHub identity tied to the
      submission email — both surfaces filter spam by checking these.
- [ ] Confirm category taxonomy at submission time (taxonomy changed
      twice in 2025).

---

## Surface 1 — solana.com/ecosystem

Submission URL: <https://solana.com/ecosystem> → "Submit a project"
button (footer of the page; the form lives at a different path each
quarter).

### Form fields (best-known schema as of 2026-05-11)

| Field | Value |
| ----- | ----- |
| Project name | ZettaPay |
| Tagline (≤ 80 chars) | Open-source Solana USDC payment protocol for humans and AI agents. |
| Long description (≤ 600 chars) | _see below_ |
| Category | Payments |
| Sub-category | Merchant tooling / Developer infrastructure |
| Website | https://zettapay.io |
| Docs | https://docs.zettapay.io |
| GitHub | https://github.com/leandromaiam-code/zettapay |
| Twitter / X | https://twitter.com/zettapay |
| Discord | https://discord.gg/zettapay |
| Logo (256×256, transparent PNG) | `public/brand/zettapay-symbol.png` |
| Status | Devnet (mainnet pending audit) |
| Open source? | Yes — protocol spec + SDKs MIT |
| Audited? | Pending — bug bounty package live, Z21 audit scheduled |

### Long description

```
ZettaPay is a Solana-native payment protocol that lets merchants accept
USDC and AI agents pay autonomously. Built on a custom Anchor program
with native SPL transferChecked, it ships SDKs in TypeScript, Python,
and Rust, plus drop-in widgets for Shopify, Webflow, React, and Vue.
ZettaPay implements the Solana Pay URI scheme natively and exposes
itself to AI agents via x402 (Anthropic's agent payment header) and
MCP. Open source under MIT for protocol and SDKs; per-tx fees of 0.30%
fund the hosted API. Devnet live since Q4 2025; mainnet planned post
audit.
```

(594 chars — fits the 600-char cap with margin.)

---

## Surface 2 — Superteam Earn / Superteam directory

Submission URL: <https://earn.superteam.fun> (sponsor onboarding) +
<https://superteam.fun/directory> (project directory submission).

### Why both

- **Earn**: lets us post bounties (community-built integrations,
  translations, SDK ports). Pays for itself the first time a community
  developer ships a wallet adapter.
- **Directory**: discoverability inside Superteam's high-signal builder
  network — an order of magnitude smaller traffic than solana.com but
  much higher conversion.

### Sponsor application — short answers

| Question | Answer |
| -------- | ------ |
| What does your project do? | Open-source Solana payment protocol for merchants and AI agents. |
| Why Superteam? | Bounty distribution for SDK ports (Go, Swift, Kotlin) + community wallet integrations. |
| Bounty budget per quarter | $5–10k USDC, paid from project treasury. |
| Geographic focus | Global — strong interest in LATAM (founder is BR-based) and SEA. |
| Open to local Superteam co-marketing? | Yes — happy to host AMAs, sponsor local hackathons. |

### First three planned bounties

1. **Go SDK skeleton** — port the Python skeleton structure (sync +
   async client, builder pattern, MIT license). Bounty: 1000 USDC.
2. **Mobile wallet adapter integration** — wire ZettaPay invoice flow
   into Solflare or Backpack mobile, ship a working PR. Bounty: 1500
   USDC.
3. **Translation: docs PT-BR + ES** — mintlify supports localization;
   port the top 20 docs pages. Bounty: 800 USDC each language.

---

## Status

- Drafted: 2026-05-11
- solana.com submission: _pending operator review_
- Superteam Earn submission: _pending operator review_
- Listings live: _n/a_
