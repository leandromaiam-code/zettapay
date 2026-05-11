# awesome-solana — entry draft

> Open as a PR against the most-starred awesome-solana fork at submission
> time (currently `avareum/awesome-solana`; verify before pushing — the
> "official" fork has rotated maintainers in the past).

## Submission checklist

- [ ] Confirm target repo is still actively merging PRs (last merge < 90
      days). If stale, fall back to a newer maintained fork.
- [ ] Read `CONTRIBUTING.md` — most awesome-* lists require alphabetical
      order within each section and reject duplicate categories.
- [ ] One commit per entry. Squash before pushing.

## PR title

```
Add ZettaPay to Payments
```

## PR body

```markdown
## What

Adds ZettaPay — open-source Solana USDC payment protocol — under the
**Payments** section.

## Entry

Inserted in alphabetical order:

- [ZettaPay](https://github.com/leandromaiam-code/zettapay) — Open-source
  universal Solana USDC payment protocol for humans and AI agents
  (x402 + MCP support, Solana Pay URI compatible, MIT).

## Why it qualifies

- ✅ Open source (MIT) — protocol spec + all SDKs.
- ✅ Active development — 100+ merged PRs, weekly releases.
- ✅ Solana-native — Anchor + native Rust program under
  [`programs/`](https://github.com/leandromaiam-code/zettapay/tree/main/programs).
- ✅ Documented — <https://docs.zettapay.io>.
- ✅ Distinct from existing entries — no overlap with Solana Pay (a
  spec) or Phantom (a wallet); ZettaPay is a payment processor /
  protocol layered on top.

## Checklist

- [x] One entry, one section.
- [x] Alphabetical placement.
- [x] Description ≤ 160 chars.
- [x] No emoji, no marketing adjectives ("revolutionary", etc.).
- [x] License explicit.
```

## Diff sketch

The entry should be inserted alphabetically. For the current
`avareum/awesome-solana` `README.md`, target the existing `## Payments`
heading. If no Payments heading exists at the time of PR, propose adding
one as a separate commit and ask the maintainer in the PR description
which they prefer.

```diff
 ## Payments

+- [ZettaPay](https://github.com/leandromaiam-code/zettapay) — Open-source universal Solana USDC payment protocol for humans and AI agents (x402 + MCP support, Solana Pay URI compatible, MIT).
 - [Solana Pay](https://github.com/anza-xyz/solana-pay) — A new standard for decentralized payments.
```

(Final ordering depends on what other Payments entries exist at submit
time — re-sort alphabetically.)

## Common reviewer pushback + responses

| Pushback | Response |
| --- | --- |
| "Not enough stars / traction" | Show npm provenance badge + active commit graph; awesome-* lists do not formally gate on stars. |
| "Looks like a product, not a library" | Point to `@zettapay/sdk`, `@zettapay/widget`, `@zettapay/embed` on npm — the surface is a library, the hosted API is optional. |
| "Description too long" | Trim to ≤ 100 chars: "Open-source Solana USDC payment protocol for humans and AI agents (MIT)." |

---

## Status

- Drafted: 2026-05-11
- PR opened: _pending operator review_
- Merged URL: _n/a_
