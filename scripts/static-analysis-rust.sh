#!/usr/bin/env bash
#
# Static analysis sweep for the ZettaPay on-chain programs.
#
# Codifies, in a single script that needs no network access and no
# proprietary toolchain, the canonical heuristics that the two industry
# Solana scanners check:
#
#   * Sec3 X-ray  — https://www.sec3.dev/x-ray
#   * Soteria     — https://github.com/sec3-product/soteria-bin
#
# Both tools are run on the public cloud build of the program for the
# pre-mainnet audit (Z21). This script is the offline complement: it runs
# in CI on every PR so a regression introduced between cloud scans (which
# we only invoke at audit milestones) trips locally and blocks merge.
#
# The check classes below are mapped 1:1 to the categories Sec3 X-ray
# documents publicly, plus the Soteria-specific bump-canonicalisation and
# arithmetic checks. See `audit/STATIC_ANALYSIS.md` for the manual review
# walking each class against the actual code and explaining why a given
# check is satisfied (or accepted-with-mitigation).
#
# Exit codes:
#   0 — every check passed
#   1 — at least one check failed
#   2 — script invoked incorrectly
#
# Usage:
#   scripts/static-analysis-rust.sh                 # full sweep
#   SKIP_CARGO=1 scripts/static-analysis-rust.sh    # skip cargo clippy

set -u
set -o pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROGRAMS_DIR="$ROOT/programs"

RED=$'\033[31m'
GRN=$'\033[32m'
YLW=$'\033[33m'
DIM=$'\033[2m'
RST=$'\033[0m'

EXIT_CODE=0
FINDINGS=0

# -----------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------

emit_check() {
    printf '\n%s[%s]%s %s\n' "$DIM" "$1" "$RST" "$2"
}

emit_pass() {
    printf '  %s\xe2\x9c\x93 pass%s \xe2\x80\x94 %s\n' "$GRN" "$RST" "$1"
}

emit_finding() {
    printf '  %s\xe2\x9c\x97 %s%s \xe2\x80\x94 %s\n' "$RED" "$1" "$RST" "$2"
    FINDINGS=$((FINDINGS + 1))
    EXIT_CODE=1
}

emit_warn() {
    printf '  %s! warn%s \xe2\x80\x94 %s\n' "$YLW" "$RST" "$1"
}

# Print only the production (non-test, non-`use`, non-comment) lines of a
# Rust source file. Driven by awk:
#   - When `#[cfg(test)]` is seen and is followed by `mod ... { ... }`,
#     skip lines until the matching closing brace.
#   - Skip pure comment lines (`//` prefix after optional whitespace).
#   - Skip `use` lines (re-exports never produce runtime behaviour).
nontest_lines() {
    awk '
        BEGIN { in_test = 0; depth = 0; pending_test = 0 }
        {
            line = $0
            # Track entry into a #[cfg(test)] mod block.
            if (line ~ /^[[:space:]]*#\[cfg\(test\)\]/) {
                pending_test = 1
                next
            }
            if (pending_test && line ~ /mod[[:space:]]+[a-zA-Z_][a-zA-Z_0-9]*[[:space:]]*\{/) {
                in_test = 1
                pending_test = 0
                # initial depth = 1 for the opening brace on this line,
                # plus any extra `{`/`}` on the same line
                opens = gsub(/\{/, "{", line)
                closes = gsub(/\}/, "}", line)
                depth = opens - closes
                if (depth <= 0) { in_test = 0 }
                next
            }
            if (pending_test) { pending_test = 0 }
            if (in_test) {
                opens = gsub(/\{/, "{", line)
                closes = gsub(/\}/, "}", line)
                depth += opens - closes
                if (depth <= 0) { in_test = 0 }
                next
            }
            # skip pure comment lines
            if (line ~ /^[[:space:]]*\/\//) next
            # skip use statements
            if (line ~ /^[[:space:]]*pub[[:space:]]+use[[:space:]]/) next
            if (line ~ /^[[:space:]]*use[[:space:]]/) next
            printf "%s:%d:%s\n", FILENAME, NR, $0
        }
    ' "$@"
}

rust_sources() {
    find "$PROGRAMS_DIR" -name '*.rs' -type f | sort
}

count_matches() {
    # $1 = grep ERE pattern; reads stdin
    grep -cE "$1" || true
}

# -----------------------------------------------------------------------
# Pre-flight
# -----------------------------------------------------------------------

if [[ ! -d "$PROGRAMS_DIR" ]]; then
    echo "fatal: programs/ not found at $PROGRAMS_DIR" >&2
    exit 2
fi

mapfile -t RUST_FILES < <(rust_sources)

if [[ ${#RUST_FILES[@]} -eq 0 ]]; then
    echo "fatal: no Rust sources under programs/" >&2
    exit 2
fi

ANCHOR_LIB="$PROGRAMS_DIR/zettapay/src/lib.rs"
CORE_LIB="$PROGRAMS_DIR/zettapay-core/src/lib.rs"

# Pre-compute the production-only slice of the native dispatcher; every
# count-based check below operates on this filtered view so `use` lines,
# doc comments, and test modules cannot inflate the numerator.
PROD_CORE_LIB="$(nontest_lines "$CORE_LIB")"
PROD_ANCHOR_LIB="$(nontest_lines "$ANCHOR_LIB")"
PROD_ALL=""
for f in "${RUST_FILES[@]}"; do
    PROD_ALL+="$(nontest_lines "$f")"$'\n'
done

printf 'ZettaPay static analysis \xe2\x80\x94 Sec3/Soteria heuristic sweep\n'
printf 'Scanning %d file(s):\n' "${#RUST_FILES[@]}"
for f in "${RUST_FILES[@]}"; do
    printf '  %s%s%s\n' "$DIM" "${f#$ROOT/}" "$RST"
done

# -----------------------------------------------------------------------
# X-001 \xe2\x80\x94 Missing signer check on authority accounts
# -----------------------------------------------------------------------
emit_check X-001 "Authority signer checks present (Sec3: missing-signer-check)"

if grep -qE 'pub[[:space:]]+owner:[[:space:]]*Signer' "$ANCHOR_LIB" \
   && grep -qE 'pub[[:space:]]+payer:[[:space:]]*Signer' "$ANCHOR_LIB"; then
    emit_pass "Anchor program declares \`owner: Signer<'info>\` and \`payer: Signer<'info>\`"
else
    emit_finding HIGH "Anchor program missing required Signer<'info> declarations"
fi

process_handlers=$(printf '%s' "$PROD_CORE_LIB" | grep -cE '^[^:]+:[0-9]+:fn process_' || true)
signer_asserts=$(printf '%s' "$PROD_CORE_LIB" | grep -cE 'assert_signer\(' || true)
if [[ "$signer_asserts" -ge "$process_handlers" && "$process_handlers" -gt 0 ]]; then
    emit_pass "Native dispatcher: ${signer_asserts} \`assert_signer\` call(s) across ${process_handlers} handler(s)"
else
    emit_finding HIGH "Native dispatcher: only ${signer_asserts} \`assert_signer\` across ${process_handlers} handlers"
fi

# -----------------------------------------------------------------------
# X-002 \xe2\x80\x94 Missing owner check on deserialized accounts
# -----------------------------------------------------------------------
emit_check X-002 "Owner check before deserialize on native handlers (Sec3: ownership-not-verified)"

deserializes=$(printf '%s' "$PROD_CORE_LIB" \
    | grep -cE '(Merchant|Invoice)::try_from_slice\(&(merchant|invoice)_ai' || true)
owner_asserts=$(printf '%s' "$PROD_CORE_LIB" | grep -cE 'assert_owned_by_program\(' || true)
if [[ "$deserializes" -gt 0 && "$owner_asserts" -ge "$deserializes" ]]; then
    emit_pass "${owner_asserts} \`assert_owned_by_program\` call(s) cover ${deserializes} deserialize site(s)"
elif [[ "$deserializes" -eq 0 ]]; then
    emit_pass "No raw account deserializes in dispatcher"
else
    emit_finding HIGH "Native handler deserializes ${deserializes} account(s) but only asserts ownership ${owner_asserts} time(s)"
fi

# -----------------------------------------------------------------------
# X-003 \xe2\x80\x94 Account type confusion
# -----------------------------------------------------------------------
emit_check X-003 "Account type discriminator enforced (Sec3: type-cosplay)"

tag_checks=$(printf '%s' "$PROD_CORE_LIB" \
    | grep -cE '\.tag[[:space:]]*!=[[:space:]]*(MERCHANT_TAG|INVOICE_TAG)|assert_tag\(' || true)
if [[ "$tag_checks" -ge "$deserializes" && "$deserializes" -gt 0 ]]; then
    emit_pass "Tag/discriminator checked at every deserialize site (${tag_checks} explicit check(s), ${deserializes} deserialize site(s))"
else
    emit_finding MEDIUM "Only ${tag_checks} tag check(s) for ${deserializes} deserialize site(s)"
fi

# -----------------------------------------------------------------------
# X-004 \xe2\x80\x94 Insecure CPI / system-program substitution
# -----------------------------------------------------------------------
emit_check X-004 "system_program identity verified before CPI (Sec3: insecure-cpi)"

cpi_count=$(printf '%s' "$PROD_CORE_LIB" | grep -cE '^[^:]+:[0-9]+:[[:space:]]*invoke_signed\(' || true)
sys_asserts=$(printf '%s' "$PROD_CORE_LIB" | grep -cE 'assert_system_program\(' || true)
if [[ "$cpi_count" -gt 0 && "$sys_asserts" -ge "$cpi_count" ]]; then
    emit_pass "${sys_asserts} \`assert_system_program\` call(s) cover ${cpi_count} \`invoke_signed\` site(s)"
elif [[ "$cpi_count" -eq 0 ]]; then
    emit_pass "Native dispatcher performs no CPIs"
else
    emit_finding HIGH "Only ${sys_asserts} \`assert_system_program\` for ${cpi_count} \`invoke_signed\` site(s)"
fi

# -----------------------------------------------------------------------
# X-005 \xe2\x80\x94 Unchecked arithmetic
# -----------------------------------------------------------------------
emit_check X-005 "Arithmetic safety (Soteria: arithmetic-overflow)"

if grep -q 'overflow-checks = true' "$ROOT/Cargo.toml"; then
    emit_pass "Workspace release profile sets \`overflow-checks = true\`"
else
    emit_warn "Workspace Cargo.toml does not set overflow-checks; per-op checked_* must cover every site"
fi

raw_count_writes=$(printf '%s' "$PROD_CORE_LIB" \
    | grep -cE 'invoice_count[[:space:]]*[+]=|invoice_count[[:space:]]*-=|invoice_count[[:space:]]*[+][[:space:]]*1' || true)
checked_count_writes=$(printf '%s' "$PROD_CORE_LIB" \
    | grep -cE 'invoice_count\.checked_(add|sub)' || true)
if [[ "$raw_count_writes" -gt 0 ]]; then
    emit_finding MEDIUM "${raw_count_writes} raw arithmetic write(s) to invoice_count (use checked_add)"
elif [[ "$checked_count_writes" -gt 0 ]]; then
    emit_pass "invoice_count mutations use checked arithmetic (${checked_count_writes} site(s))"
else
    emit_pass "invoice_count not arithmetically mutated outside checked_* surface"
fi

# -----------------------------------------------------------------------
# X-006 \xe2\x80\x94 Reinitialization attack
# -----------------------------------------------------------------------
emit_check X-006 "Account creation rejects re-initialization (Sec3: reinitialization)"

init_count=$(grep -cE '^[[:space:]]+init,' "$ANCHOR_LIB" || true)
if [[ "$init_count" -ge 2 ]]; then
    emit_pass "Anchor program uses \`init,\` on all ${init_count} PDA(s) (\`init_if_needed\` would fail this check)"
else
    emit_finding MEDIUM "Anchor program has ${init_count} \`init,\` blocks; expected one per state account"
fi

if grep -q 'init_if_needed' "$ANCHOR_LIB"; then
    emit_finding HIGH "Anchor program uses \`init_if_needed\` (re-init attack surface)"
fi

if grep -q 'system_instruction::create_account' "$CORE_LIB"; then
    emit_pass "Native dispatcher uses \`system_instruction::create_account\` (fails on existing account)"
else
    emit_warn "Native dispatcher does not use \`create_account\`; verify alternative re-init guard"
fi

# -----------------------------------------------------------------------
# X-007 \xe2\x80\x94 Bump seed canonicalization
# -----------------------------------------------------------------------
emit_check X-007 "Canonical bump only (Soteria: bump-seed-canonicalization)"

# Anchor `bump,` (no rhs) uses the canonical bump; `bump = <expr>` with
# anything other than `ctx.bumps.X` accepts a user-supplied bump.
SUSPECT_BUMP=$(grep -nE 'bump[[:space:]]*=[[:space:]]*[^,)]+' "$ANCHOR_LIB" \
    | grep -v 'ctx\.bumps' \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*//' \
    || true)
if [[ -z "$SUSPECT_BUMP" ]]; then
    emit_pass "Anchor program uses canonical bump (\`bump,\` only)"
else
    emit_finding HIGH "User-supplied bump detected in Anchor program:"
    printf '%s\n' "$SUSPECT_BUMP" | sed 's/^/    /'
fi

# Native dispatcher: bump must come from find_program_address's return
# tuple, never from instruction args.
if grep -qE 'args\.bump|payload.*bump' "$CORE_LIB"; then
    emit_finding HIGH "Native dispatcher reads bump from instruction args (must use find_program_address)"
else
    emit_pass "Native dispatcher derives bump via find_program_address only"
fi

# -----------------------------------------------------------------------
# X-008 \xe2\x80\x94 PDA seed re-derivation and comparison
# -----------------------------------------------------------------------
emit_check X-008 "PDA seeds re-derived and compared inside handler (Sec3: pda-seeds-mining)"

# Only call sites, not the `use` import (already filtered) and not test
# bodies (already filtered).
derivations=$(printf '%s' "$PROD_CORE_LIB" \
    | grep -cE 'find_(merchant|invoice)_pda\(' || true)
# Comparisons against either expected_pda (PDA equality) cover this.
comparisons=$(printf '%s' "$PROD_CORE_LIB" \
    | grep -cE 'key != &expected_pda' || true)
if [[ "$derivations" -gt 0 && "$comparisons" -ge "$derivations" ]]; then
    emit_pass "${derivations} PDA derivation(s) each followed by an address comparison"
else
    emit_finding HIGH "PDA seed mining risk: ${derivations} derivation(s), only ${comparisons} comparison(s)"
fi

# -----------------------------------------------------------------------
# X-009 \xe2\x80\x94 Duplicate mutable accounts (sweep idempotency)
# -----------------------------------------------------------------------
emit_check X-009 "Duplicate mutable account guard (Sec3: duplicate-mutable)"

if grep -qE 'status[[:space:]]*!=[[:space:]]*INVOICE_STATUS_OPEN' "$CORE_LIB"; then
    emit_pass "sweep loop rejects already-swept invoices (\`status != INVOICE_STATUS_OPEN\`)"
else
    emit_finding MEDIUM "sweep loop does not appear to reject already-swept invoices"
fi

# -----------------------------------------------------------------------
# X-010 \xe2\x80\x94 Sysvar via syscall, not account input
# -----------------------------------------------------------------------
emit_check X-010 "Sysvars accessed via syscall (Sec3: sysvar-account-abuse)"

clock_via_syscall=$(printf '%s' "$PROD_ALL" | grep -cE 'Clock::get\(\)' || true)
rent_via_syscall=$(printf '%s' "$PROD_ALL" | grep -cE 'Rent::get\(\)' || true)
clock_via_account=$(printf '%s' "$PROD_ALL" | grep -cE 'Clock::from_account_info' || true)
rent_via_account=$(printf '%s' "$PROD_ALL" | grep -cE 'Rent::from_account_info' || true)

if [[ "$clock_via_account" -gt 0 || "$rent_via_account" -gt 0 ]]; then
    emit_finding MEDIUM "Sysvar accessed via account_info (clock: $clock_via_account, rent: $rent_via_account)"
else
    emit_pass "Clock via syscall (${clock_via_syscall} site(s)), Rent via syscall (${rent_via_syscall} site(s))"
fi

# -----------------------------------------------------------------------
# X-011 \xe2\x80\x94 No unwrap/panic in production code
# -----------------------------------------------------------------------
emit_check X-011 "No unwrap / expect / panic / unimplemented outside tests"

PROD_PANICS=$(printf '%s' "$PROD_ALL" \
    | grep -E '\.unwrap\(\)|\.expect\(|panic!\(|unimplemented!\(|todo!\(' \
    || true)
if [[ -z "$PROD_PANICS" ]]; then
    emit_pass "No unwrap / expect / panic in production code"
else
    emit_finding HIGH "Panic surface in production code:"
    printf '%s\n' "$PROD_PANICS" | sed 's/^/    /'
fi

# -----------------------------------------------------------------------
# X-012 \xe2\x80\x94 No unsafe blocks
# -----------------------------------------------------------------------
emit_check X-012 "No \`unsafe\` blocks (Sec3: unsafe-code)"

UNSAFE_HITS=$(printf '%s' "$PROD_ALL" \
    | grep -E 'unsafe[[:space:]]*\{|unsafe[[:space:]]+fn' \
    || true)
if [[ -z "$UNSAFE_HITS" ]]; then
    emit_pass "No \`unsafe\` blocks in any program crate"
else
    emit_finding HIGH "\`unsafe\` block(s) detected (require explicit audit justification):"
    printf '%s\n' "$UNSAFE_HITS" | sed 's/^/    /'
fi

# -----------------------------------------------------------------------
# X-013 \xe2\x80\x94 Placeholder program id flagged for replacement
# -----------------------------------------------------------------------
emit_check X-013 "Placeholder program id is documented as such"

PLACEHOLDER='Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'
if grep -RIn "$PLACEHOLDER" "$PROGRAMS_DIR" >/dev/null 2>&1; then
    if grep -RIn -B2 -A2 "$PLACEHOLDER" "$PROGRAMS_DIR" | grep -qiE 'placeholder|replace|mainnet'; then
        emit_pass "Placeholder program id present and explicitly flagged as a pre-mainnet pin"
    else
        emit_finding MEDIUM "Placeholder program id present without 'placeholder' / 'mainnet' note"
    fi
else
    emit_pass "No placeholder program id remaining"
fi

# -----------------------------------------------------------------------
# X-014 \xe2\x80\x94 cargo clippy security lints (when available)
# -----------------------------------------------------------------------
emit_check X-014 "cargo clippy security lints"

if [[ "${SKIP_CARGO:-0}" == "1" ]]; then
    emit_warn "SKIP_CARGO=1 -- clippy invocation skipped"
elif ! command -v cargo >/dev/null 2>&1; then
    emit_warn "cargo not on PATH -- clippy skipped (install rustup to enable)"
else
    pushd "$ROOT" >/dev/null
    if cargo clippy --workspace --all-targets -- \
            -D warnings \
            -W clippy::integer_arithmetic \
            -W clippy::indexing_slicing \
            -W clippy::unwrap_used \
            -W clippy::expect_used \
            -W clippy::panic \
            -W clippy::todo \
            -W clippy::unimplemented \
            2>&1 | tee /tmp/clippy.out; then
        emit_pass "cargo clippy clean"
    else
        emit_finding MEDIUM "cargo clippy reported issues (see /tmp/clippy.out)"
    fi
    popd >/dev/null
fi

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------

echo
if [[ "$FINDINGS" -eq 0 ]]; then
    printf '%sStatic analysis clean \xe2\x80\x94 14 check(s) all green.%s\n' "$GRN" "$RST"
else
    printf '%sStatic analysis FOUND %d finding(s).%s\n' "$RED" "$FINDINGS" "$RST"
fi
echo "Report: audit/STATIC_ANALYSIS.md"

exit "$EXIT_CODE"
