#!/usr/bin/env python3
"""
Z50: Replace Solana references with BTC + USDC multichain (Base/Polygon/Ethereum).
Single-pass bulk replacement over public/*.html, public/**/*.html, public/*.js, public/*.css.
"""
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..", "public")
EXTS = (".html", ".js", ".css")

# Ordered: most specific patterns first.
# Each entry is (pattern, replacement). Pattern is either a literal string or a
# re.Pattern (compiled regex). Lower-case-only patterns are intentional where we
# need to preserve original casing; explicit casing variants below.
REPLACEMENTS = [
    # ---- Timing copy "<2s" variants (HTML entities + literal) ----
    ("&lt; 2 s", "~ 24 s"),
    ("&lt;2 s", "~24 s"),
    ("&lt; 2s", "~ 24s"),
    ("&lt;2s", "~24s"),
    ("< 2 s", "~ 24 s"),
    ("<2 s", "~24 s"),
    ("< 2s", "~ 24s"),
    ("<2s", "~24s"),
    # ---- "Solana Devnet" / "Solana Mainnet" / "Solana Explorer" specifics ----
    ("Solana Devnet", "Base Sepolia"),
    ("Solana devnet", "Base Sepolia"),
    ("solana devnet", "base sepolia"),
    ("Solana Mainnet", "Base mainnet"),
    ("Solana mainnet", "Base mainnet"),
    ("Solana Explorer", "Basescan"),
    ("solana explorer", "basescan"),
    # ---- Anchor framework / program ----
    ("Anchor program", "Smart contract"),
    ("Anchor Program", "Smart Contract"),
    ("anchor program", "smart contract"),
    ("Anchor framework", "EVM contracts"),
    ("anchor framework", "EVM contracts"),
    # ---- Helius ----
    ("Helius", "RPC provider"),
    ("HELIUS", "RPC PROVIDER"),
    ("helius", "RPC provider"),
    # ---- SPL token ----
    ("spl-token", "erc20"),
    ("SPL-Token", "ERC20"),
    ("SPL Token", "ERC20"),
    ("spl_token", "erc20"),
    # ---- Tailwind / CSS variable identifier renames (Solana brand purple) ----
    ("'solana': '#9945FF'", "'violet': '#9945FF'"),
    ("solana: '#9945FF'", "violet: '#9945FF'"),
    ('"solana": "#9945FF"', '"violet": "#9945FF"'),
    # CSS custom property
    ("--solana", "--violet"),
    # Tailwind class names
    ("text-solana", "text-violet"),
    ("bg-solana", "bg-violet"),
    ("from-solana", "from-violet"),
    ("to-solana", "to-violet"),
    ("via-solana", "via-violet"),
    ("border-solana", "border-violet"),
    ("ring-solana", "ring-violet"),
    ("hover:text-solana", "hover:text-violet"),
    # ---- "USDC on Solana" → "USDC on Base" specifically ----
    ("USDC on Solana", "USDC on Base"),
    ("USDC on solana", "USDC on Base"),
    ("usdc on solana", "usdc on base"),
    # ---- "on Solana" (timing/network) → "on Base" ----
    ("on Solana", "on Base"),
    ("on solana", "on base"),
    # ---- Generic "Solana" remaining (network name) → "Base" ----
    # Keep this LAST among Solana terms so specifics above match first.
    ("Solana", "Base"),
    ("SOLANA", "BASE"),
    # Lower-case "solana" left in data values (e.g. "network": "solana")
    ("solana", "base"),
]


def transform(text: str) -> str:
    for pat, rep in REPLACEMENTS:
        if isinstance(pat, re.Pattern):
            text = pat.sub(rep, text)
        else:
            text = text.replace(pat, rep)
    return text


def main():
    root = os.path.normpath(ROOT)
    changed = []
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            if not fn.endswith(EXTS):
                continue
            p = os.path.join(dirpath, fn)
            with open(p, "r", encoding="utf-8") as f:
                original = f.read()
            new = transform(original)
            if new != original:
                with open(p, "w", encoding="utf-8") as f:
                    f.write(new)
                changed.append(os.path.relpath(p, start=os.path.dirname(root)))
    print(f"Files changed: {len(changed)}")
    for c in changed:
        print("  -", c)


if __name__ == "__main__":
    main()
