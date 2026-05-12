//! Bitcoin SPV cryptographic primitives.
//!
//! Z26.3 — chunked on-chain SPV verifier for Bitcoin payments. Bitcoin
//! itself uses double-SHA256 everywhere a hash appears, so this module
//! exposes `sha256d` plus the three pieces a payment proof needs:
//!
//!   * `compute_merkle_root_from_proof` — fold a transaction's hash up
//!     through an authentication path into the block's merkle root.
//!   * `n_bits_to_target` — decode the compact `nBits` field of a block
//!     header into a 256-bit difficulty target.
//!   * `hash_le_meets_target_le` — `block_hash <= target` as Bitcoin's
//!     proof-of-work check, comparing both as 256-bit little-endian
//!     integers.
//!
//! Endianness:
//!
//!   Bitcoin's wire encoding stores hashes in *internal* byte order — the
//!   order SHA256 emits them — which displays reversed when printed as a
//!   txid or block hash. Every byte slice that crosses this module's
//!   boundary is in that internal order. The numeric comparison in
//!   `hash_le_meets_target_le` treats byte 0 as the least significant.
//!
//! Compute-unit budget:
//!
//!   `sha256d` invokes `solana_program::hash::hash` twice. On Solana 1.18,
//!   the SHA256 syscall costs ~85 base + ~1 CU per byte. A merkle proof
//!   with N siblings does N `sha256d(64-byte buffer)` calls plus the
//!   initial `sha256d(tx_data)`. For a worst-case 1000-byte transaction
//!   and a 14-level proof (>16k tx block), that lands at roughly
//!   `~1.1k + 14 * ~430 ≈ 7.1k CU` — well within the 200k budget that
//!   keeps each instruction chunk within Solana's per-ix limit.

use solana_program::hash::hash;

/// Double-SHA256: `SHA256(SHA256(data))`. The hash function Bitcoin uses
/// for txids, block hashes, and merkle nodes.
pub fn sha256d(data: &[u8]) -> [u8; 32] {
    let first = hash(data);
    let second = hash(&first.to_bytes());
    second.to_bytes()
}

/// Hard cap on merkle-proof depth. A Bitcoin block holding 2^24 tx would
/// need a 24-level proof; real-world blocks top out near 2^14. 32 is
/// comfortably above any plausible block while still bounding the
/// per-instruction compute cost.
pub const MAX_MERKLE_PROOF_DEPTH: usize = 32;

/// Fold a `txid` up an authentication path into a merkle root.
///
/// `merkle_index` is the leaf's position in the block's transaction list.
/// The low bit selects ordering at each level: when the current node's
/// position is even it hashes as `(current || sibling)`, when odd as
/// `(sibling || current)`. Bitcoin's BIP 37 uses this exact convention.
///
/// The buffer is reused across levels rather than re-allocated; on a 14-
/// level proof that saves 13 allocations inside the BPF heap.
pub fn compute_merkle_root_from_proof(
    txid: [u8; 32],
    proof_siblings: &[[u8; 32]],
    merkle_index: u32,
) -> [u8; 32] {
    let mut current = txid;
    let mut idx = merkle_index;
    let mut buf = [0u8; 64];

    for sibling in proof_siblings {
        if idx & 1 == 0 {
            buf[..32].copy_from_slice(&current);
            buf[32..].copy_from_slice(sibling);
        } else {
            buf[..32].copy_from_slice(sibling);
            buf[32..].copy_from_slice(&current);
        }
        current = sha256d(&buf);
        idx >>= 1;
    }
    current
}

/// Decode Bitcoin's compact `nBits` field into a 256-bit target as a
/// little-endian byte array.
///
/// Layout: top byte is the exponent, low three bytes are the mantissa
/// (big-endian inside the u32). The numeric target is
/// `mantissa * 256^(exponent - 3)`. We refuse to materialise targets
/// that don't fit in 256 bits — those values cannot appear in a valid
/// Bitcoin block (the network rejects them at consensus) and treating
/// them as "easy" would let a forged header sneak past the PoW check.
///
/// Returns `None` for invalid encodings: the sign bit (mantissa bit 23)
/// must be zero, and `exponent` must keep `mantissa << (exponent - 3)`
/// inside 32 bytes.
pub fn n_bits_to_target(n_bits: u32) -> Option<[u8; 32]> {
    let exponent = (n_bits >> 24) as usize;
    let mantissa = n_bits & 0x007f_ffff;
    let sign = n_bits & 0x0080_0000;

    // Bitcoin reuses an OpenSSL BIGNUM compact format that allows a sign
    // bit. Negative targets are nonsensical for PoW; reject.
    if sign != 0 {
        return None;
    }
    if mantissa == 0 {
        // Zero target is unreachable in any header that survived the
        // network's consensus rules.
        return None;
    }

    let mut target = [0u8; 32];

    if exponent <= 3 {
        // Mantissa shrinks: shift right by (3 - exponent) bytes.
        let shift = 3 - exponent;
        let shrunk = mantissa >> (8 * shift);
        target[0] = (shrunk & 0xff) as u8;
        if shift < 2 {
            target[1] = ((shrunk >> 8) & 0xff) as u8;
        }
        if shift < 1 {
            target[2] = ((shrunk >> 16) & 0xff) as u8;
        }
        Some(target)
    } else {
        // Mantissa grows: place three mantissa bytes starting at byte
        // (exponent - 3). Largest valid placement puts the top mantissa
        // byte at index 31, i.e. exponent - 3 + 2 <= 31 → exponent <= 32.
        let shift = exponent - 3;
        if shift + 2 >= 32 {
            return None;
        }
        target[shift] = (mantissa & 0xff) as u8;
        target[shift + 1] = ((mantissa >> 8) & 0xff) as u8;
        target[shift + 2] = ((mantissa >> 16) & 0xff) as u8;
        Some(target)
    }
}

/// Compare two 32-byte little-endian unsigned integers: returns `true`
/// when `hash <= target`. This is the Bitcoin proof-of-work predicate.
///
/// We iterate from the most-significant byte (index 31) down so the
/// first differing position decides the outcome — branch-free on the
/// equal case isn't needed because BPF has no observable side-channels.
pub fn hash_le_meets_target_le(hash: &[u8; 32], target: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        if hash[i] < target[i] {
            return true;
        }
        if hash[i] > target[i] {
            return false;
        }
    }
    true
}

/// Read the `merkle_root` field (bytes 36..68) from an 80-byte Bitcoin
/// block header. Returns `None` if `header` is the wrong length so the
/// caller surfaces `BlockHeaderInvalid` instead of panicking on a slice.
pub fn header_merkle_root(header: &[u8]) -> Option<[u8; 32]> {
    if header.len() != BLOCK_HEADER_LEN {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&header[36..68]);
    Some(out)
}

/// Read the compact `nBits` field (bytes 72..76, little-endian u32) from
/// a Bitcoin block header.
pub fn header_n_bits(header: &[u8]) -> Option<u32> {
    if header.len() != BLOCK_HEADER_LEN {
        return None;
    }
    Some(u32::from_le_bytes([
        header[72], header[73], header[74], header[75],
    ]))
}

/// Wire size of a Bitcoin block header. Fixed at consensus.
pub const BLOCK_HEADER_LEN: usize = 80;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256d_matches_known_empty_vector() {
        // SHA256d("") = SHA256(SHA256("")) — well-known anchor for
        // catching any accidental single-hash regression.
        // SHA256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        // SHA256d("") = 5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456
        let got = sha256d(b"");
        let expected: [u8; 32] = [
            0x5d, 0xf6, 0xe0, 0xe2, 0x76, 0x13, 0x59, 0xd3,
            0x0a, 0x82, 0x75, 0x05, 0x8e, 0x29, 0x9f, 0xcc,
            0x03, 0x81, 0x53, 0x45, 0x45, 0xf5, 0x5c, 0xf4,
            0x3e, 0x41, 0x98, 0x3f, 0x5d, 0x4c, 0x94, 0x56,
        ];
        assert_eq!(got, expected);
    }

    #[test]
    fn merkle_proof_single_tx_block_yields_txid_as_root() {
        // A block with exactly one transaction has merkle_root == txid:
        // there is no sibling to hash against. The proof is empty.
        let txid = [9u8; 32];
        let root = compute_merkle_root_from_proof(txid, &[], 0);
        assert_eq!(root, txid);
    }

    #[test]
    fn merkle_proof_two_tx_block_left_position() {
        // index 0 → current is left, sibling right → root = SHA256d(txid || sibling)
        let txid = [1u8; 32];
        let sibling = [2u8; 32];
        let mut buf = [0u8; 64];
        buf[..32].copy_from_slice(&txid);
        buf[32..].copy_from_slice(&sibling);
        let expected = sha256d(&buf);
        let got = compute_merkle_root_from_proof(txid, &[sibling], 0);
        assert_eq!(got, expected);
    }

    #[test]
    fn merkle_proof_two_tx_block_right_position_swaps_operand_order() {
        // index 1 → current is right, sibling left → root = SHA256d(sibling || txid)
        // The ordering swap is the entire point of merkle_index — losing
        // it lets a forged proof place the tx at any sibling slot.
        let txid = [1u8; 32];
        let sibling = [2u8; 32];
        let mut buf = [0u8; 64];
        buf[..32].copy_from_slice(&sibling);
        buf[32..].copy_from_slice(&txid);
        let expected = sha256d(&buf);
        let got = compute_merkle_root_from_proof(txid, &[sibling], 1);
        assert_eq!(got, expected);
    }

    #[test]
    fn merkle_proof_three_level_round_trip() {
        // 8-tx block, prove the leaf at index 5 (binary 101). Build the
        // tree bottom-up and confirm the verifier's fold equals the root.
        let leaves: [[u8; 32]; 8] = [
            [10u8; 32], [11u8; 32], [12u8; 32], [13u8; 32],
            [14u8; 32], [15u8; 32], [16u8; 32], [17u8; 32],
        ];
        let pair = |a: [u8; 32], b: [u8; 32]| {
            let mut buf = [0u8; 64];
            buf[..32].copy_from_slice(&a);
            buf[32..].copy_from_slice(&b);
            sha256d(&buf)
        };
        let l0 = pair(leaves[0], leaves[1]);
        let l1 = pair(leaves[2], leaves[3]);
        let l2 = pair(leaves[4], leaves[5]);
        let l3 = pair(leaves[6], leaves[7]);
        let m0 = pair(l0, l1);
        let m1 = pair(l2, l3);
        let root = pair(m0, m1);

        // Authentication path for leaf 5 (binary 101): sibling at each
        // level — leaves[4], l3, m0 — with the bit indicating the leaf
        // side (low bit first, so index 5 = ...101).
        let proof = [leaves[4], l3, m0];
        let got = compute_merkle_root_from_proof(leaves[5], &proof, 5);
        assert_eq!(got, root);
    }

    #[test]
    fn n_bits_to_target_decodes_genesis_difficulty_1() {
        // Bitcoin genesis nBits = 0x1d00ffff. Target = 0x00000000ffff0000…0
        // when written big-endian, or 0xffff at byte 26 in little-endian.
        let target = n_bits_to_target(0x1d00ffff).expect("valid encoding");
        let mut expected = [0u8; 32];
        // exponent = 0x1d = 29, shift = exponent - 3 = 26.
        // mantissa = 0x00ffff. Bytes at [26], [27], [28].
        expected[26] = 0xff;
        expected[27] = 0xff;
        expected[28] = 0x00;
        assert_eq!(target, expected);
    }

    #[test]
    fn n_bits_to_target_rejects_negative_sign_bit() {
        // Sign bit set in mantissa means the BIGNUM is negative — no
        // valid Bitcoin block uses it. Reject.
        assert!(n_bits_to_target(0x1d80_ffff).is_none());
    }

    #[test]
    fn n_bits_to_target_rejects_zero_mantissa() {
        // mantissa == 0 means target == 0, which no real block hits
        // (you'd need a 0 SHA256d output). Treating it as "easy" would
        // be the opposite of correct.
        assert!(n_bits_to_target(0x1d00_0000).is_none());
    }

    #[test]
    fn n_bits_to_target_rejects_overflow() {
        // exponent = 34 would place mantissa beyond byte 31. Reject so
        // the PoW check can't be bypassed with an absurd target.
        assert!(n_bits_to_target(0x2200_ffff).is_none());
    }

    #[test]
    fn n_bits_to_target_small_exponent_shrinks_mantissa() {
        // exponent = 2 < 3 → shift right one byte, mantissa = 0xffff
        // becomes 0xff at byte 0 only (the 0xff that shifted out is gone).
        let target = n_bits_to_target(0x0200_ffff).expect("valid encoding");
        let mut expected = [0u8; 32];
        expected[0] = 0xff;
        assert_eq!(target, expected);
    }

    #[test]
    fn hash_le_meets_target_le_strictly_less() {
        let mut hash = [0u8; 32];
        let mut target = [0u8; 32];
        hash[31] = 0x01;
        target[31] = 0x02;
        assert!(hash_le_meets_target_le(&hash, &target));
    }

    #[test]
    fn hash_le_meets_target_le_equal_is_valid_pow() {
        // Bitcoin's predicate is `hash <= target` (inclusive). A header
        // landing exactly on the target is rare but valid.
        let v = [0xab; 32];
        assert!(hash_le_meets_target_le(&v, &v));
    }

    #[test]
    fn hash_le_meets_target_le_strictly_greater_rejected() {
        let mut hash = [0u8; 32];
        let mut target = [0u8; 32];
        hash[31] = 0x02;
        target[31] = 0x01;
        assert!(!hash_le_meets_target_le(&hash, &target));
    }

    #[test]
    fn hash_le_meets_target_le_msb_dominates() {
        // The most-significant byte (index 31 in LE order) decides
        // when it differs, regardless of low bytes. A bug that walked
        // bytes in the wrong direction would let any "fits" decision
        // be overruled by a single low-byte difference.
        let mut hash = [0xff; 32];
        let mut target = [0x00; 32];
        hash[31] = 0x00;
        target[31] = 0x01;
        // hash MSB=0, target MSB=1 → hash < target → meets predicate.
        assert!(hash_le_meets_target_le(&hash, &target));
    }

    #[test]
    fn header_helpers_reject_wrong_length() {
        // Anything other than exactly 80 bytes is not a Bitcoin block
        // header. Returning None forces the caller into the explicit
        // BlockHeaderInvalid path instead of a slice panic.
        assert!(header_merkle_root(&[0u8; 79]).is_none());
        assert!(header_merkle_root(&[0u8; 81]).is_none());
        assert!(header_n_bits(&[0u8; 79]).is_none());
    }

    #[test]
    fn header_helpers_read_merkle_root_and_nbits() {
        let mut header = [0u8; BLOCK_HEADER_LEN];
        // Sentinel pattern in the merkle_root field.
        for i in 0..32 {
            header[36 + i] = (i as u8).wrapping_add(0x10);
        }
        // nBits = 0x1d00ffff little-endian → bytes ff ff 00 1d
        header[72] = 0xff;
        header[73] = 0xff;
        header[74] = 0x00;
        header[75] = 0x1d;

        let root = header_merkle_root(&header).unwrap();
        for i in 0..32 {
            assert_eq!(root[i], (i as u8).wrapping_add(0x10));
        }
        assert_eq!(header_n_bits(&header).unwrap(), 0x1d00_ffff);
    }
}
