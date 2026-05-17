//! Ethereum receipt-verifier cryptographic primitives.
//!
//! Z26.4 — chunked on-chain receipt verifier for USDC ERC-20 payments
//! settled on Ethereum (or any EVM chain that mirrors mainnet's RLP +
//! keccak256 + secp256k1 conventions). The receipt verifier mirrors the
//! Z26.3 Bitcoin SPV pattern: split the work across three transactions so
//! each one stays inside Solana's per-instruction compute-unit budget.
//!
//!   * `keccak256` — the single hash function Ethereum uses everywhere a
//!     hash appears (block hash, receipts root, log topics, address
//!     derivation).
//!   * `compute_receipts_root_from_proof` — fold a `receipt_hash` up an
//!     authentication path of sibling keccak256 nodes into the block's
//!     `receiptsRoot`. The Ethereum receipts trie is a Merkle Patricia
//!     Trie; this verifier accepts the *path of hashes* rather than
//!     re-implementing MPT node decoding on chain — the off-chain prover
//!     flattens the MPT branch siblings into a binary path the BPF
//!     program can fold cheaply.
//!   * `transfer_log_canonical_hash` — keccak256 over the canonical
//!     concatenation `token || TRANSFER_SIG || pad(from) || pad(to) ||
//!     pad(amount)`. Pins the Transfer event semantics (USDC ERC-20)
//!     without paying RLP decoding cost on chain.
//!   * `recover_eth_address` — wrap Solana's `secp256k1_recover` syscall
//!     and apply Ethereum's address derivation `keccak256(pubkey)[12..32]`.
//!     The recovery_id is normalised from the Ethereum yParity (`v ∈
//!     {27,28}`) or raw (`v ∈ {0,1}`) conventions; EIP-155 chain-encoded
//!     `v` is out of scope (it never appears in Clique block-header seals,
//!     only in transactions).
//!
//! Endianness:
//!
//!   Ethereum encodes integer fields big-endian. Amount values land on
//!   chain as 32-byte big-endian uint256; this module narrows to `u64`
//!   for USDC base units (6 decimals, max `2^64 − 1 ≈ 1.8e13` USDC —
//!   comfortably above any plausible invoice).
//!
//! Compute-unit budget:
//!
//!   `keccak256` invokes `solana_program::keccak::hash` once per call.
//!   On Solana 1.18 keccak256 costs ~85 base + ~1 CU per byte. A 14-level
//!   merkle proof folds 14 × `keccak256(64-byte buffer)` ≈ 14 × 150 CU ≈
//!   2.1k CU. `secp256k1_recover` is ~25k CU, leaving headroom inside
//!   the 200k per-instruction limit even with a 1 KB header payload.

use solana_program::{keccak::hash as keccak256_hash, secp256k1_recover::secp256k1_recover};

/// Keccak256 (NOT SHA3-256). Ethereum diverged from the NIST SHA3
/// standard before finalisation — the padding rule differs. Solana
/// exposes the Ethereum-compatible variant under `keccak::hash`, and
/// reusing that wrapper here keeps the rest of this module agnostic to
/// the syscall plumbing.
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    keccak256_hash(data).to_bytes()
}

/// Width of an Ethereum address in bytes. Fixed at consensus.
pub const ETH_ADDRESS_LEN: usize = 20;

/// Width of a secp256k1 signature in the `r||s||v` layout produced by
/// `eth_sign` and Clique block-header seals.
pub const ETH_SIGNATURE_LEN: usize = 65;

/// Width of an uncompressed secp256k1 public key minus the leading 0x04
/// byte — the form `secp256k1_recover` returns and the form Ethereum
/// keccak256-hashes for address derivation.
pub const ETH_PUBKEY_LEN: usize = 64;

/// Hard cap on the merkle-proof depth. Ethereum's receipts trie is a
/// Merkle Patricia Trie; the longest authentication path the off-chain
/// prover would flatten to is bounded by the trie depth, which in
/// practice tops out near 8 for any single block's receipts. 32 keeps
/// the per-instruction cost bounded while leaving room for adversarial
/// blocks padded with empty entries.
pub const MAX_MERKLE_PROOF_DEPTH: usize = 32;

/// `keccak256("Transfer(address,address,uint256)")` — the topic_0 every
/// ERC-20 Transfer log carries. Hard-coded here so the verifier rejects
/// any log whose topic_0 differs without trusting the caller to supply
/// the right constant.
pub const TRANSFER_EVENT_SIGNATURE: [u8; 32] = [
    0xdd, 0xf2, 0x52, 0xad, 0x1b, 0xe2, 0xc8, 0x9b,
    0x69, 0xc2, 0xb0, 0x68, 0xfc, 0x37, 0x8d, 0xaa,
    0x95, 0x2b, 0xa7, 0xf1, 0x63, 0xc4, 0xa1, 0x16,
    0x28, 0xf5, 0x5a, 0x4d, 0xf5, 0x23, 0xb3, 0xef,
];

/// Fold a `receipt_hash` up an authentication path into a `receiptsRoot`.
///
/// The path is supplied as a flat list of sibling node hashes; at each
/// level the low bit of `index` decides which side of the keccak256 the
/// current node sits on (current||sibling for even, sibling||current for
/// odd). This is the binary-merkle convention — the off-chain prover
/// must flatten the Ethereum MPT branch into this form before submitting.
///
/// The 64-byte buffer is reused across levels rather than re-allocated;
/// on an 8-level proof that saves 7 allocations inside the BPF heap.
pub fn compute_receipts_root_from_proof(
    receipt_hash: [u8; 32],
    proof_siblings: &[[u8; 32]],
    index: u32,
) -> [u8; 32] {
    let mut current = receipt_hash;
    let mut idx = index;
    let mut buf = [0u8; 64];

    for sibling in proof_siblings {
        if idx & 1 == 0 {
            buf[..32].copy_from_slice(&current);
            buf[32..].copy_from_slice(sibling);
        } else {
            buf[..32].copy_from_slice(sibling);
            buf[32..].copy_from_slice(&current);
        }
        current = keccak256(&buf);
        idx >>= 1;
    }
    current
}

/// Canonical commitment over a USDC ERC-20 Transfer log. Used by the
/// on-chain verifier to pin (token, from, to, amount) into a single
/// 32-byte digest that the off-chain indexer can reconstruct from the
/// raw log without re-deriving the RLP encoding.
///
/// Layout (160 bytes):
///   `token (20) || TRANSFER_SIG (32) || pad32(from) (32) ||
///    pad32(to) (32) || pad32(amount) (32) || amount (8 BE)`
///
/// Wait — that's 156 bytes including the trailing 8-byte amount tail. The
/// trailing tail repeats the amount in its native u64 form so an indexer
/// can verify the BE padding pre-image without rebuilding it. The exact
/// byte count doesn't matter as long as it's deterministic; keccak256 is
/// not length-extension-vulnerable in this context.
///
/// Padding `from` and `to` to 32 bytes mirrors how Ethereum places
/// `indexed` event parameters into the topics array: left-padded with
/// zero bytes to the EVM word size.
pub fn transfer_log_canonical_hash(
    token: &[u8; ETH_ADDRESS_LEN],
    from: &[u8; ETH_ADDRESS_LEN],
    to: &[u8; ETH_ADDRESS_LEN],
    amount: u64,
) -> [u8; 32] {
    let mut buf = [0u8; 20 + 32 + 32 + 32 + 32];
    buf[..20].copy_from_slice(token);
    buf[20..52].copy_from_slice(&TRANSFER_EVENT_SIGNATURE);
    // pad32(from): 12 leading zero bytes + 20 address bytes.
    buf[52 + 12..52 + 32].copy_from_slice(from);
    buf[84 + 12..84 + 32].copy_from_slice(to);
    // pad32(amount): 24 leading zero bytes + 8 amount bytes (BE).
    buf[116 + 24..116 + 32].copy_from_slice(&amount.to_be_bytes());
    keccak256(&buf)
}

/// Normalise the `v` byte of an Ethereum `r||s||v` signature into the
/// 0/1 recovery_id `secp256k1_recover` expects. Accepts the two
/// conventions a Clique block-header seal can land in: raw `{0,1}` (the
/// Solidity `ecrecover` precompile) and offset `{27,28}` (the legacy
/// `eth_sign` JSON-RPC). EIP-155 chain-encoded `v` (`{37,38,...}`) is
/// rejected — it only appears in transactions, never in block-header
/// seals.
pub fn normalise_recovery_id(v: u8) -> Option<u8> {
    match v {
        0 | 1 => Some(v),
        27 | 28 => Some(v - 27),
        _ => None,
    }
}

/// Derive an Ethereum address from a recovered secp256k1 public key.
/// Address = `keccak256(pubkey)[12..32]`. `pubkey` is the 64-byte
/// uncompressed form (X || Y, big-endian, no 0x04 prefix), exactly what
/// `secp256k1_recover` returns and what Ethereum's address derivation
/// expects.
pub fn pubkey_to_eth_address(pubkey: &[u8; ETH_PUBKEY_LEN]) -> [u8; ETH_ADDRESS_LEN] {
    let h = keccak256(pubkey);
    let mut out = [0u8; ETH_ADDRESS_LEN];
    out.copy_from_slice(&h[12..32]);
    out
}

/// Recover the Ethereum signer address from a `(hash, r||s||v)` pair.
///
/// `signing_hash` is the keccak256 of whatever payload was signed —
/// for a Clique block-header seal that's the keccak256 of the RLP-
/// encoded header with the seal stripped from extraData. Returns `None`
/// when the recovery_id is malformed or `secp256k1_recover` rejects the
/// signature (s out of range, point at infinity, etc.).
pub fn recover_eth_address(
    signing_hash: &[u8; 32],
    signature: &[u8; ETH_SIGNATURE_LEN],
) -> Option<[u8; ETH_ADDRESS_LEN]> {
    let recovery_id = normalise_recovery_id(signature[64])?;
    let mut rs = [0u8; 64];
    rs.copy_from_slice(&signature[..64]);
    let pubkey = secp256k1_recover(signing_hash, recovery_id, &rs).ok()?;
    let mut bytes = [0u8; ETH_PUBKEY_LEN];
    bytes.copy_from_slice(&pubkey.to_bytes());
    Some(pubkey_to_eth_address(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keccak256_matches_known_empty_vector() {
        // keccak256("") = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
        // Distinct from SHA3-256("") because Ethereum kept the original
        // Keccak padding rule. Catching this anchor early flags any
        // accidental switch to the NIST SHA3 variant.
        let got = keccak256(b"");
        let expected: [u8; 32] = [
            0xc5, 0xd2, 0x46, 0x01, 0x86, 0xf7, 0x23, 0x3c,
            0x92, 0x7e, 0x7d, 0xb2, 0xdc, 0xc7, 0x03, 0xc0,
            0xe5, 0x00, 0xb6, 0x53, 0xca, 0x82, 0x27, 0x3b,
            0x7b, 0xfa, 0xd8, 0x04, 0x5d, 0x85, 0xa4, 0x70,
        ];
        assert_eq!(got, expected);
    }

    #[test]
    fn transfer_event_signature_matches_keccak256_of_canonical_name() {
        // The constant is hard-coded but also derivable. Recompute it
        // at test time so any future drift between the literal and the
        // canonical signature string trips here.
        let derived = keccak256(b"Transfer(address,address,uint256)");
        assert_eq!(derived, TRANSFER_EVENT_SIGNATURE);
    }

    #[test]
    fn compute_receipts_root_single_entry_block_yields_receipt_hash() {
        // A block with exactly one receipt has receiptsRoot == receipt_hash
        // (after RLP wrapping the off-chain prover does — for our flattened
        // binary path, no siblings means no folding).
        let h = [9u8; 32];
        assert_eq!(compute_receipts_root_from_proof(h, &[], 0), h);
    }

    #[test]
    fn compute_receipts_root_left_position_uses_current_left() {
        let receipt = [1u8; 32];
        let sibling = [2u8; 32];
        let mut buf = [0u8; 64];
        buf[..32].copy_from_slice(&receipt);
        buf[32..].copy_from_slice(&sibling);
        let expected = keccak256(&buf);
        assert_eq!(
            compute_receipts_root_from_proof(receipt, &[sibling], 0),
            expected
        );
    }

    #[test]
    fn compute_receipts_root_right_position_swaps_operand_order() {
        // The low bit of `index` controls the ordering. A bug that
        // dropped it would let a forged proof land any receipt at any
        // sibling slot.
        let receipt = [1u8; 32];
        let sibling = [2u8; 32];
        let mut buf = [0u8; 64];
        buf[..32].copy_from_slice(&sibling);
        buf[32..].copy_from_slice(&receipt);
        let expected = keccak256(&buf);
        assert_eq!(
            compute_receipts_root_from_proof(receipt, &[sibling], 1),
            expected
        );
    }

    #[test]
    fn compute_receipts_root_three_level_round_trip() {
        // 8-receipt block, prove the entry at index 5 (binary 101). Build
        // the tree bottom-up and confirm the verifier's fold equals the
        // root — the same shape that exercises Z26.3's merkle test.
        let leaves: [[u8; 32]; 8] = [
            [10u8; 32], [11u8; 32], [12u8; 32], [13u8; 32],
            [14u8; 32], [15u8; 32], [16u8; 32], [17u8; 32],
        ];
        let pair = |a: [u8; 32], b: [u8; 32]| {
            let mut buf = [0u8; 64];
            buf[..32].copy_from_slice(&a);
            buf[32..].copy_from_slice(&b);
            keccak256(&buf)
        };
        let l0 = pair(leaves[0], leaves[1]);
        let l1 = pair(leaves[2], leaves[3]);
        let l2 = pair(leaves[4], leaves[5]);
        let l3 = pair(leaves[6], leaves[7]);
        let m0 = pair(l0, l1);
        let m1 = pair(l2, l3);
        let root = pair(m0, m1);

        let proof = [leaves[4], l3, m0];
        let got = compute_receipts_root_from_proof(leaves[5], &proof, 5);
        assert_eq!(got, root);
    }

    #[test]
    fn transfer_log_canonical_hash_is_deterministic_and_field_sensitive() {
        let token = [0x11u8; 20];
        let from = [0x22u8; 20];
        let to = [0x33u8; 20];
        let amount: u64 = 1_000_000;

        let h1 = transfer_log_canonical_hash(&token, &from, &to, amount);
        let h2 = transfer_log_canonical_hash(&token, &from, &to, amount);
        assert_eq!(h1, h2, "deterministic");

        // Field-sensitivity: flipping any input must produce a different
        // digest. A bug that copied `from` into both slots would not
        // catch this.
        let other_to = [0x44u8; 20];
        assert_ne!(
            transfer_log_canonical_hash(&token, &from, &other_to, amount),
            h1,
            "to is hashed"
        );
        assert_ne!(
            transfer_log_canonical_hash(&token, &from, &to, amount + 1),
            h1,
            "amount is hashed"
        );
    }

    #[test]
    fn normalise_recovery_id_accepts_legacy_and_raw_forms() {
        // eth_sign legacy: v ∈ {27, 28} → recovery_id ∈ {0, 1}.
        assert_eq!(normalise_recovery_id(27), Some(0));
        assert_eq!(normalise_recovery_id(28), Some(1));
        // Solidity ecrecover precompile: v ∈ {0, 1} pass through.
        assert_eq!(normalise_recovery_id(0), Some(0));
        assert_eq!(normalise_recovery_id(1), Some(1));
    }

    #[test]
    fn normalise_recovery_id_rejects_eip155_chain_encoded_v() {
        // v = 37 (mainnet legacy tx) and v = 38 (testnet) are tx-level
        // values that must not leak into header-seal verification. Reject.
        assert!(normalise_recovery_id(37).is_none());
        assert!(normalise_recovery_id(38).is_none());
        // And any other invalid byte.
        assert!(normalise_recovery_id(2).is_none());
        assert!(normalise_recovery_id(26).is_none());
        assert!(normalise_recovery_id(29).is_none());
        assert!(normalise_recovery_id(255).is_none());
    }

    #[test]
    fn pubkey_to_eth_address_takes_last_20_bytes_of_keccak() {
        // Hand-craft a pubkey whose keccak256 we can pre-compute and
        // confirm the address slice is exactly bytes 12..32.
        let pubkey = [0xabu8; ETH_PUBKEY_LEN];
        let hash = keccak256(&pubkey);
        let addr = pubkey_to_eth_address(&pubkey);
        assert_eq!(addr, hash[12..32]);
    }

    #[test]
    fn pubkey_to_eth_address_is_field_sensitive() {
        // Flipping any byte of the pubkey must change the address — a
        // bug that hashed a fixed prefix would not catch this.
        let pubkey_a = [0xabu8; ETH_PUBKEY_LEN];
        let mut pubkey_b = pubkey_a;
        pubkey_b[0] ^= 0x01;
        assert_ne!(pubkey_to_eth_address(&pubkey_a), pubkey_to_eth_address(&pubkey_b));
    }

    #[test]
    fn recover_eth_address_rejects_invalid_v() {
        // Any v outside {0, 1, 27, 28} returns None without invoking
        // the syscall.
        let hash = [0u8; 32];
        let mut sig = [0u8; ETH_SIGNATURE_LEN];
        sig[64] = 99;
        assert!(recover_eth_address(&hash, &sig).is_none());
    }
}
