# RPC providers — awareness + outreach

> Goal: get ZettaPay listed on each major Solana RPC provider's
> "ecosystem" / "case studies" / "powered by" page, AND establish a
> support contact before mainnet so we can escalate during incidents.

## Why this matters

Premissa I-1 + III-9 + IV-13 force us to depend on third-party RPC
infrastructure end-to-end (devnet today, mainnet at Z29). Listing on
provider ecosystem pages buys us:

1. Inbound traffic from merchants who already shop providers by stack.
2. A named contact for emergency rate-limit or routing escalations.
3. Co-marketing leverage when the provider posts case studies.

## Provider inventory (2026-05-11)

| Provider | Public URL | Listing surface | Support contact form |
| -------- | ---------- | --------------- | -------------------- |
| Helius | <https://helius.dev> | Customer wall + blog | <https://helius.dev/contact> |
| Triton One | <https://triton.one> | Partners page | <https://triton.one/contact> |
| QuickNode | <https://quicknode.com/chains/sol> | "Customers" wall | <https://quicknode.com/contact> |
| Alchemy | <https://alchemy.com/solana> | Showcase | <https://alchemy.com/contact-sales> |
| Chainstack | <https://chainstack.com/build-better-with-solana/> | Featured projects | <https://chainstack.com/contact/> |

Re-verify URLs each quarter — provider marketing pages move.

## Submission checklist (per provider)

- [ ] Send cold email using the template below.
- [ ] If the provider has a self-serve "submit your project" form, use
      that AND send the email — both surfaces.
- [ ] Attach: 1-pager PDF, demo video URL, repo URL, npm SDK URL.
- [ ] Track responses in `community/listings/STATUS.md` (created on
      first reply).

## Outreach email template

> Subject line: keep it specific. Generic subjects ("Partnership
> opportunity") get filtered.

```
Subject: ZettaPay (Solana payments protocol) — listing + RPC support contact

Hi <Provider> team,

I'm <name>, founder of ZettaPay (https://zettapay.io) — an open-source
Solana USDC payment protocol for humans and AI agents. We're currently
on devnet, mainnet planned for <quarter>, and we use <Provider> for
<endpoints / regions>.

Two asks:

1. Listing — we'd like to be added to your ecosystem page. We can
   provide:
     - Logo (256×256 PNG, transparent)
     - 80-char tagline: "Open-source Solana USDC payment protocol for
       humans and AI agents."
     - Repo: https://github.com/leandromaiam-code/zettapay
     - Docs: https://docs.zettapay.io

2. Named technical contact — pre-mainnet, we'd like a Slack/email
   handle for emergency escalation (rate-limit bursts during launch
   marketing windows, region failovers). Happy to share our traffic
   profile and projected mainnet QPS under NDA.

Quick background: ZettaPay implements x402 (the AI agent payment
protocol from Anthropic) and exposes itself as an MCP tool for Claude
and other agents. Agent traffic has a different burst profile than
typical merchant traffic — short, very concurrent windows tied to agent
runs. Worth flagging early so we don't surprise your routing layer.

Happy to jump on a call. Demo video here: <video URL>.

Best,
<name>
founder@zettapay.io
```

## Provider-specific notes

### Helius
- Use `enhancedTransactions` and webhook indexing. Listing should call
  out webhook integration, since ZettaPay's payment-confirmed webhook is
  Helius-driven on devnet (see `api/webhooks/helius.ts` if/when
  applicable).
- Helius runs a co-marketing program for OSS infra — flag MIT licensing
  in the first email.

### Triton One
- Premium provider for low-latency MEV-aware customers; less relevant
  for our typical merchant load profile but very relevant for agent
  bursts (sub-200ms tail latency matters).
- Pitch angle: "AI agent traffic = best-case use case for your
  staked-connection routing."

### QuickNode
- Has a self-serve "Built with QuickNode" submission form — use it AND
  email.
- They publish regular case studies; offer to participate.

### Alchemy
- Strong on the EVM side; their Solana product is newer. Frame ZettaPay
  as a proof their Solana RPC handles real production payment workloads.

### Chainstack
- Best fit for our European customer base (EU regions matter for LGPD
  /GDPR latency budgets — premissa V-17 + Z21.4).
- Mention their dedicated nodes for mainnet — we'll need at least one.

## Awareness doc — internal architecture pointer

Engineers wiring up new endpoints should default to provider abstraction,
not provider lock-in. Concretely:

- Read RPC URLs from `RPC_URL_PRIMARY` and `RPC_URL_FALLBACK` env vars.
  Never hardcode a provider hostname in source.
- Provider-specific features (Helius enhanced transactions, Triton
  staked connections) live behind feature flags so we can fail over
  without code changes.
- Quarterly: rerun a synthetic load test against each provider's
  free/dev tier to keep the fallback list ranked by current latency.

---

## Status

- Drafted: 2026-05-11
- Outreach sent: _pending operator review_
- Listings live: _n/a_
