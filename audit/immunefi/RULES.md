# Rules of engagement

These rules apply to every report submitted through the Immunefi
listing. Reports that violate the rules are closed without payout
and may, in extreme cases, result in a researcher being delisted.

## Testing environment

1. **Test only against the devnet program** at
   `Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS` on
   `https://api.devnet.solana.com`, or against your own
   `solana-test-validator` running the same source.
2. **Bring your own SOL** for fees and rent on devnet. The public
   devnet faucet is rate-limited; do not abuse it. If your testing
   requires more SOL than the faucet provides, run a local validator.
3. **Do not run sustained traffic** against the public devnet RPCs
   from your testing — this slows down the cluster for every other
   user. Local validator is the right place for fuzzing, property
   tests, and any test that loops.

## What you cannot do, ever

4. **No DoS** against shared infrastructure. Do not flood our RPC
   providers, the ZettaPay API endpoints, the public dashboard, the
   docs site, or any third-party service we depend on. Targeted DoS
   PoCs that consume more than a single transaction per minute on
   the public cluster forfeit the bounty.
5. **No social engineering** against ZettaPay employees, contractors,
   or anyone in the merchant ecosystem. No phishing. No pretexting.
   No "spear engineering" of a target merchant to extract their
   private key.
6. **No physical access attacks** against ZettaPay infrastructure or
   personnel. Out of scope and out of bounds.
7. **No tampering with the published source** — do not file PRs that
   introduce a bug and then claim a bounty on the bug you
   introduced. The listing is pinned to a specific commit; reports
   are judged against that commit.
8. **No exploitation against live merchants**, even on devnet. If
   your PoC would steal another devnet user's bound merchant
   handle, stop. File the conceptual report instead, with a local
   validator reproducer.
9. **No public disclosure** before a fix ships or the 90-day
   coordinated disclosure window expires, whichever comes first.
   Public disclosure prior to fix forfeits the bounty.

## Disclosure window

10. **Coordinated disclosure**: 90 days from the day we acknowledge
    the report as a valid finding, or the day a fix ships,
    whichever is sooner.
11. If 90 days elapse with no fix and no extension agreement, the
    researcher may disclose publicly **after** notifying ZettaPay
    security with 14 days' notice. We may agree to an extension if
    a fix is materially in flight and a CVE-style coordinated
    disclosure helps the broader ecosystem.

## Proof of concept (PoC) requirements

A report is **valid** only when it includes all of:

12. **A specific instruction or PDA path.** "We found a bug in
    `record_payment`" is not enough; it must name the exact branch
    in `programs/zettapay/src/lib.rs` and the seed pair involved.
13. **A threat description.** What does the attacker gain? Who is
    the victim? How much can a single instance of the attack
    extract on mainnet?
14. **A reproducer.** Any of:
    - A failing Anchor test in `tests/zettapay.ts` style. Preferred.
    - A devnet transaction signature against the listed program ID,
      with the failing post-condition explained.
    - A step-by-step that a triager can replay against
      `solana-test-validator` in <30 minutes.
15. **The commit you are testing against.** The Immunefi listing
    pins a commit; report against the same commit. If you found the
    bug against an older commit but the listed commit no longer
    exhibits it, the report is out of scope.

Reports that lack any of the above are returned with a request for
clarification. After two clarifications, an incomplete report is
closed.

## What we do **not** count as a finding

16. **Documented behaviour.** Anything in
    [`../KNOWN_ISSUES.md`](../KNOWN_ISSUES.md) (K1 through K8) is
    accepted; reports re-discovering these are closed as duplicate
    of public disclosure.
17. **Upstream bugs.** Bugs in the SPL Token program, Anchor, the
    Solana runtime, the USDC mint, RPC providers, or wallet
    adapters. Report those to the upstream project; we may file a
    courtesy notice but will not pay.
18. **Operational issues.** RPC downtime, API rate-limit responses,
    Vercel build failures, npm dependency vulnerabilities in
    development tooling.
19. **Hypothetical attacks** with no PoC. A bug class that
    *could* be present is not a finding; a bug that *is* present,
    with a reproducer, is.
20. **Style / quality / theoretical improvements.** Suggestions to
    re-architect the program (e.g. "you should CPI to SPL Token to
    verify `usdc_token_account`") are not findings; they are
    welcome via PR.

## Duplicates

21. **One report per finding.** If multiple researchers report the
    same issue, the **first** valid Immunefi submission wins the
    payout. Subsequent reports are credited in the hall of fame
    only.
22. If the second report demonstrates a strictly higher-impact
    variant of the same root cause, we re-assess and may award the
    second reporter the difference. See [`REWARDS.md`](REWARDS.md).

## Communication

23. Submit through **Immunefi's submission form** for the ZettaPay
    listing. Do not email `security@zettapay.io` for in-scope
    findings — the Immunefi platform is the single intake and the
    audit trail.
24. We acknowledge new reports within **two business days**.
25. We provide a severity assessment and triage decision within
    **ten business days**.
26. We provide a fix ETA within **20 business days** of acceptance.

## Hall of fame

27. Researchers may opt to be credited by handle, GitHub, X, or
    remain anonymous. The hall of fame is published at
    `https://zettapay.io/security/researchers` and is updated after
    each fix ships.

## Eligibility

28. **Open to researchers worldwide**, subject to local law. If
    sanctions or other restrictions apply to your jurisdiction (OFAC,
    EU, UK, etc.), payout may be withheld; the finding is still
    credited in the hall of fame.
29. **No active ZettaPay employees, contractors, or anyone with
    repo write access** is eligible for payout. Internal findings
    are handled through the normal engineering process.
30. **No researcher acting on behalf of a competitor for the express
    purpose of harming ZettaPay's reputation** is eligible. We
    define competitor narrowly and will not invoke this clause to
    avoid paying legitimate findings; it exists to address bad-faith
    submissions.
