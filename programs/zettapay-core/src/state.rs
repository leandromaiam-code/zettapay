//! On-chain account state — manual Borsh, no `#[account]` macro.
//!
//! Each owned account begins with a single-byte `tag` so a wrong-type
//! account passed to an instruction is rejected with one equality check
//! before any deserialization side effect is observable. This is the
//! defensive role Anchor's 8-byte discriminator plays, at 1/8th the rent.
//!
//! Layouts are fixed-size so `Account::SIZE` can be passed verbatim to
//! `system_instruction::create_account`. Borsh's `Vec<u8>` length prefix
//! is accounted for via a hard cap (`MAX_CHAINS`).

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

// Account type tags. First byte of every owned account.
pub const MERCHANT_TAG: u8 = 1;
pub const INVOICE_TAG: u8 = 2;
/// Bitcoin SPV payment proof. Z26.3 added a cross-chain settlement path
/// where a merchant accepts a Bitcoin payment that satisfies a USDC-
/// denominated invoice; the proof account records the multi-step SPV
/// verification so `submit_btc_proof_part_*` can stay under the per-
/// instruction compute-unit budget.
pub const SPV_PROOF_BTC_TAG: u8 = 3;
/// Singleton global Bitcoin header chain. Z26.5 added a rolling window
/// of the most-recent Bitcoin block headers, validated for PoW +
/// continuity on every update. SPV proofs (Z26.3) and any future cross-
/// chain settlement logic anchor their block-hash references here.
pub const BTC_HEADER_CHAIN_TAG: u8 = 4;
/// Singleton global program config (Z30.1). Holds the protocol authority
/// pubkey and the per-invoice USDC cap enforced inside `create_invoice`.
/// One account program-wide; updates are gated on the authority's
/// signature so the cap is operator-only.
pub const PROGRAM_CONFIG_TAG: u8 = 5;

// Currency tags. Premise 2 keeps V1 USDC-only; the tag byte exists so Z11
// can add stablecoins without an account-layout migration.
pub const CURRENCY_USDC: u8 = 0;

// Chain tags. Premise 1 keeps V1 Solana-only; the registered chain set is
// still recorded so the off-chain index can route Z11 multi-chain
// settlement without forcing merchants to re-register.
pub const CHAIN_SOLANA: u8 = 0;
pub const CHAIN_ETHEREUM: u8 = 1;
pub const CHAIN_BASE: u8 = 2;
pub const CHAIN_POLYGON: u8 = 3;
pub const CHAIN_ARBITRUM: u8 = 4;
pub const CHAIN_AVALANCHE: u8 = 5;

pub const INVOICE_STATUS_OPEN: u8 = 0;
pub const INVOICE_STATUS_SWEPT: u8 = 1;
/// Invoice was settled by a finalised Bitcoin SPV proof (Z26.3). The
/// status is distinct from `SWEPT` because the on-chain settlement
/// rail is different — there is no USDC transfer to follow, and
/// downstream indexers route disputes through the BTC chain instead.
pub const INVOICE_STATUS_PAID_BTC: u8 = 2;

/// SPV proof account lifecycle. Each step is a separate transaction so
/// the per-instruction CU budget stays under Solana's 200k chunk.
pub const SPV_STATUS_PART1_DONE: u8 = 0;
pub const SPV_STATUS_PART2_DONE: u8 = 1;
pub const SPV_STATUS_FINALIZED: u8 = 2;

/// Cap on the merchant's declared chain set. Bounding this fixes the
/// merchant PDA size at registration time so rent calculations are stable.
pub const MAX_CHAINS: usize = 16;

/// Merchant identity PDA. Seeds: see [`crate::pda::find_merchant_pda`].
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct Merchant {
    pub tag: u8,
    pub bump: u8,
    pub master_pubkey: Pubkey,
    pub chains: Vec<u8>,
    /// Monotonic invoice counter. Becomes the `invoice_index` seed of the
    /// next invoice PDA — never decremented, never reused.
    pub invoice_count: u64,
    pub registered_at: i64,
}

impl Merchant {
    pub const SIZE: usize = 1     // tag
        + 1                       // bump
        + 32                      // master_pubkey
        + 4 + MAX_CHAINS          // borsh Vec<u8>: u32 length prefix + bytes
        + 8                       // invoice_count
        + 8;                      // registered_at
}

/// Invoice receipt PDA. Seeds: see [`crate::pda::find_invoice_pda`].
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct Invoice {
    pub tag: u8,
    pub bump: u8,
    pub merchant: Pubkey,
    pub invoice_index: u64,
    /// USDC base units (6 decimals). Must be > 0.
    pub amount: u64,
    pub currency: u8,
    pub status: u8,
    pub created_at: i64,
    /// 0 while `status == INVOICE_STATUS_OPEN`. Set at sweep time.
    pub swept_at: i64,
}

impl Invoice {
    pub const SIZE: usize = 1     // tag
        + 1                       // bump
        + 32                      // merchant
        + 8                       // invoice_index
        + 8                       // amount
        + 1                       // currency
        + 1                       // status
        + 8                       // created_at
        + 8;                      // swept_at
}

/// Bitcoin SPV payment proof PDA. Seeds: see
/// [`crate::pda::find_spv_proof_btc_pda`].
///
/// The account is initialised in `submit_btc_proof_part_1` with the
/// merkle inclusion result, updated in `submit_btc_proof_part_2` with
/// the validated block-header hash, and finalised in
/// `finalize_btc_payment` where it flips the matching `Invoice` to
/// `INVOICE_STATUS_PAID_BTC`. The `submitter` field binds part 2 and
/// finalisation back to the same signer that paid the rent on part 1,
/// closing the door on a third party hijacking an in-flight proof.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct SpvProofBtc {
    pub tag: u8,
    pub bump: u8,
    /// Invoice this proof settles. Bound at part_1 — the PDA seeds
    /// already pin the relationship; storing it lets finalize verify
    /// without re-deriving.
    pub invoice: Pubkey,
    /// Wallet that funded the proof account and signed part_1. Part_2
    /// and finalize require this same signer to prevent griefing.
    pub submitter: Pubkey,
    /// Bitcoin txid in internal byte order (the order SHA256d emits).
    pub txid: [u8; 32],
    /// Merkle root computed from `txid` + part_1 proof path; must match
    /// the block header's merkle_root field in part_2.
    pub merkle_root: [u8; 32],
    /// Block hash committed in part_2, internal byte order. Stays
    /// `[0u8; 32]` until part_2 runs.
    pub block_hash: [u8; 32],
    /// One of `SPV_STATUS_PART1_DONE | SPV_STATUS_PART2_DONE |
    /// SPV_STATUS_FINALIZED`.
    pub status: u8,
    pub created_at: i64,
    /// 0 until `finalize_btc_payment` flips it.
    pub finalized_at: i64,
}

impl SpvProofBtc {
    pub const SIZE: usize = 1     // tag
        + 1                       // bump
        + 32                      // invoice
        + 32                      // submitter
        + 32                      // txid
        + 32                      // merkle_root
        + 32                      // block_hash
        + 1                       // status
        + 8                       // created_at
        + 8;                      // finalized_at
}

// --- Z26.5: Bitcoin header chain (singleton PDA) --------------------------
//
// One global account tracks the most-recent `BTC_HEADER_CHAIN_WINDOW`
// Bitcoin block headers as a flat ring buffer. Each entry is the raw
// 80-byte block header in wire format. `update_btc_header` advances the
// ring by one slot, validating PoW + continuity against `latest_hash`
// before accepting the new tip.
//
// The chain is callable by any wallet — keeping it permissionless lets
// an off-chain cron (Z30.x program-health) refresh the tip without
// holding a privileged key on chain. Replay protection comes for free
// from the continuity check: a tx submitted twice would fail on the
// second attempt because the chain's `latest_hash` already advanced.

/// Rolling window size: the most-recent N Bitcoin block headers are
/// retained. 144 ≈ one day of Bitcoin blocks at the 10-minute target —
/// enough lookback for SPV finality (Bitcoin's de-facto 6-confirmation
/// rule) without paying rent on a deeper archive.
pub const BTC_HEADER_CHAIN_WINDOW: usize = 144;

/// Width of a raw Bitcoin block header in wire format. Fixed at consensus.
/// Duplicated as a compile-time constant alongside `spv::BLOCK_HEADER_LEN`
/// to keep `state.rs` self-contained for the `SIZE` calculation below.
pub const BTC_HEADER_LEN: usize = 80;

/// Total byte length of the headers ring buffer.
pub const BTC_HEADER_CHAIN_BUFFER_LEN: usize = BTC_HEADER_CHAIN_WINDOW * BTC_HEADER_LEN;

/// Singleton global PDA. Seeds: see [`crate::pda::find_btc_header_chain_pda`].
///
/// `headers_data` is borsh-encoded as a `Vec<u8>` (4-byte length prefix
/// followed by bytes) because borsh 0.10 cannot derive serializers for
/// `[u8; N]` with `N > 32`. The Vec is allocated full-size at init time
/// and its length is verified to stay at exactly
/// `BTC_HEADER_CHAIN_BUFFER_LEN` on every load — drift would corrupt the
/// ring-buffer indexing.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct BitcoinHeaderChain {
    pub tag: u8,
    pub bump: u8,
    /// Ring-buffer position of the newest (chain tip) header. Wraps mod
    /// `BTC_HEADER_CHAIN_WINDOW`. Meaningful only while `count > 0`.
    pub head_index: u16,
    /// Number of headers populated in the ring. Saturates at the window
    /// size; once full the buffer evicts the oldest slot on every update.
    pub count: u16,
    /// Block height at chain tip. Advisory: Bitcoin block headers do not
    /// self-attest height (BIP34 moved it into the coinbase, not the
    /// header). Initialised from the anchor caller's value, then
    /// monotonically incremented by one per `update_btc_header`.
    pub latest_height: u64,
    /// Solana unix timestamp at which the chain tip was last advanced.
    /// Used by Z30.x program-health monitoring to alarm when the cron
    /// updater falls behind.
    pub last_updated_at: i64,
    /// Block height at chain anchor (init time). Immutable; documents
    /// the chain instance's starting reference.
    pub anchor_height: u64,
    /// SHA256d of the anchor header. Immutable; off-chain auditors can
    /// reconstruct the chain instance's identity from this single value.
    pub anchor_hash: [u8; 32],
    /// SHA256d of the chain-tip header. Compared byte-for-byte against
    /// the supplied new header's `prev_block_hash` field on every update.
    pub latest_hash: [u8; 32],
    /// Flat byte buffer holding `BTC_HEADER_CHAIN_WINDOW` × 80-byte
    /// headers in ring-buffer order. Slot `i` lives at
    /// `headers_data[i*80 .. (i+1)*80]`.
    pub headers_data: Vec<u8>,
}

impl BitcoinHeaderChain {
    pub const SIZE: usize = 1     // tag
        + 1                        // bump
        + 2                        // head_index
        + 2                        // count
        + 8                        // latest_height
        + 8                        // last_updated_at
        + 8                        // anchor_height
        + 32                       // anchor_hash
        + 32                       // latest_hash
        + 4                        // borsh Vec<u8> length prefix
        + BTC_HEADER_CHAIN_BUFFER_LEN; // headers ring buffer
}

// --- Z30.1: Program config (per-invoice cap) ------------------------------
//
// Beta mainnet launches with a $100 cap per invoice. The cap is enforced
// inside `create_invoice` and adjusted by `set_max_invoice_amount`,
// callable only by the authority recorded at `init_program_config` time
// (the deploy operator). Sprint Z30 graduates the cap upward — $100 at
// D+0, $500 at D+30 (Z30.4), removed at D+60 (Z30.5) — so the value is
// kept on-chain rather than hard-coded into the bytecode.
//
// "Deploy authority" semantics: the deployment runbook calls
// `init_program_config` in the same operator session that runs
// `solana program deploy`, binding the captured authority to the same
// key that holds the BPF Loader Upgradeable upgrade authority. From that
// point on, only that key can call `set_max_invoice_amount`.
//
// A sentinel value of `0` means "no cap" — used at D+60 to disable
// enforcement without re-deploying. See `process_create_invoice` for the
// comparison logic.

/// Default per-invoice cap at config init time: 100 USDC in base units
/// (6 decimals). Matches the Z30 sprint goal: low cap at launch, raised
/// gradually as the protocol clocks bug-free hours.
pub const DEFAULT_MAX_INVOICE_AMOUNT: u64 = 100 * 1_000_000;

/// Sentinel value that disables cap enforcement (Z30.5 D+60 removal).
/// When `ProgramConfig.max_invoice_amount == 0`, `create_invoice` skips
/// the cap comparison entirely.
pub const MAX_INVOICE_AMOUNT_UNLIMITED: u64 = 0;

/// Singleton global program config PDA. Seeds: see
/// [`crate::pda::find_program_config_pda`].
///
/// `authority` is bound at `init_program_config` time to the signer that
/// ran the initial deployment script; afterward, only that key can call
/// `set_max_invoice_amount`. There is no on-chain transfer of the
/// authority field in V1 — rotation would land as a separate instruction.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct ProgramConfig {
    pub tag: u8,
    pub bump: u8,
    pub authority: Pubkey,
    /// Per-invoice USDC cap in base units (6 decimals). `0` disables
    /// enforcement (see `MAX_INVOICE_AMOUNT_UNLIMITED`).
    pub max_invoice_amount: u64,
}

impl ProgramConfig {
    pub const SIZE: usize = 1  // tag
        + 1                    // bump
        + 32                   // authority
        + 8;                   // max_invoice_amount
}

#[cfg(test)]
mod tests {
    use super::*;
    use borsh::BorshSerialize as _;

    #[test]
    fn merchant_size_within_pda_max() {
        assert!(Merchant::SIZE < 10_240);
    }

    #[test]
    fn invoice_size_within_pda_max() {
        assert!(Invoice::SIZE < 10_240);
    }

    #[test]
    fn merchant_size_matches_field_layout() {
        assert_eq!(Merchant::SIZE, 1 + 1 + 32 + (4 + MAX_CHAINS) + 8 + 8);
    }

    #[test]
    fn invoice_size_matches_field_layout() {
        assert_eq!(Invoice::SIZE, 1 + 1 + 32 + 8 + 8 + 1 + 1 + 8 + 8);
    }

    #[test]
    fn merchant_roundtrip_via_borsh() {
        let m = Merchant {
            tag: MERCHANT_TAG,
            bump: 254,
            master_pubkey: Pubkey::new_from_array([7u8; 32]),
            chains: vec![CHAIN_SOLANA, CHAIN_BASE, CHAIN_POLYGON],
            invoice_count: 41,
            registered_at: 1_700_000_000,
        };
        let bytes = m.try_to_vec().unwrap();
        let decoded = Merchant::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded, m);
    }

    #[test]
    fn invoice_roundtrip_via_borsh() {
        let inv = Invoice {
            tag: INVOICE_TAG,
            bump: 253,
            merchant: Pubkey::new_from_array([3u8; 32]),
            invoice_index: 9,
            amount: 5_000_000,
            currency: CURRENCY_USDC,
            status: INVOICE_STATUS_OPEN,
            created_at: 1_700_000_001,
            swept_at: 0,
        };
        let bytes = inv.try_to_vec().unwrap();
        let decoded = Invoice::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded, inv);
    }

    #[test]
    fn merchant_borsh_length_matches_fixed_size_when_chains_full() {
        // The fixed `Merchant::SIZE` must hold the serialized form when
        // the chain set is at MAX_CHAINS. If the two diverge, a
        // fully-loaded merchant would overflow the allocated account
        // data. This test fails before that ships.
        let m = Merchant {
            tag: MERCHANT_TAG,
            bump: 0,
            master_pubkey: Pubkey::default(),
            chains: vec![CHAIN_SOLANA; MAX_CHAINS],
            invoice_count: 0,
            registered_at: 0,
        };
        let bytes = m.try_to_vec().unwrap();
        assert_eq!(bytes.len(), Merchant::SIZE);
    }

    #[test]
    fn spv_proof_btc_size_within_pda_max() {
        assert!(SpvProofBtc::SIZE < 10_240);
    }

    #[test]
    fn spv_proof_btc_size_matches_field_layout() {
        assert_eq!(
            SpvProofBtc::SIZE,
            1 + 1 + 32 + 32 + 32 + 32 + 32 + 1 + 8 + 8
        );
    }

    #[test]
    fn spv_proof_btc_roundtrip_via_borsh() {
        let proof = SpvProofBtc {
            tag: SPV_PROOF_BTC_TAG,
            bump: 255,
            invoice: Pubkey::new_from_array([4u8; 32]),
            submitter: Pubkey::new_from_array([5u8; 32]),
            txid: [6u8; 32],
            merkle_root: [7u8; 32],
            block_hash: [8u8; 32],
            status: SPV_STATUS_PART2_DONE,
            created_at: 1_700_000_002,
            finalized_at: 0,
        };
        let bytes = proof.try_to_vec().unwrap();
        assert_eq!(bytes.len(), SpvProofBtc::SIZE);
        let decoded = SpvProofBtc::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded, proof);
    }

    #[test]
    fn btc_header_chain_buffer_len_is_144_x_80() {
        assert_eq!(BTC_HEADER_CHAIN_BUFFER_LEN, 11_520);
    }

    #[test]
    fn btc_header_chain_size_matches_field_layout() {
        // Pin the byte budget. The mission spec calls for a ~11.5 KB
        // singleton; the actual on-chain footprint is the ring buffer
        // plus a handful of header fields plus the 4-byte borsh Vec
        // length prefix.
        assert_eq!(
            BitcoinHeaderChain::SIZE,
            1 + 1 + 2 + 2 + 8 + 8 + 8 + 32 + 32 + 4 + BTC_HEADER_CHAIN_BUFFER_LEN
        );
    }

    #[test]
    fn btc_header_chain_roundtrip_via_borsh() {
        let chain = BitcoinHeaderChain {
            tag: BTC_HEADER_CHAIN_TAG,
            bump: 254,
            head_index: 7,
            count: 8,
            latest_height: 850_007,
            last_updated_at: 1_700_000_500,
            anchor_height: 850_000,
            anchor_hash: [9u8; 32],
            latest_hash: [10u8; 32],
            headers_data: vec![0u8; BTC_HEADER_CHAIN_BUFFER_LEN],
        };
        let bytes = chain.try_to_vec().unwrap();
        assert_eq!(bytes.len(), BitcoinHeaderChain::SIZE);
        let decoded = BitcoinHeaderChain::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded, chain);
    }

    #[test]
    fn program_config_size_matches_field_layout() {
        assert_eq!(ProgramConfig::SIZE, 1 + 1 + 32 + 8);
    }

    #[test]
    fn program_config_roundtrip_via_borsh() {
        let cfg = ProgramConfig {
            tag: PROGRAM_CONFIG_TAG,
            bump: 252,
            authority: Pubkey::new_from_array([19u8; 32]),
            max_invoice_amount: DEFAULT_MAX_INVOICE_AMOUNT,
        };
        let bytes = cfg.try_to_vec().unwrap();
        assert_eq!(bytes.len(), ProgramConfig::SIZE);
        let decoded = ProgramConfig::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded, cfg);
    }

    #[test]
    fn default_max_invoice_amount_is_100_usdc() {
        // Sprint Z30 launch cap. If this changes, the off-chain
        // orchestrator (`packages/api/src/beta/cap_upgrade.ts`) needs to
        // be re-aligned — keep the constant pinned.
        assert_eq!(DEFAULT_MAX_INVOICE_AMOUNT, 100_000_000);
    }

    #[test]
    fn invoice_borsh_length_matches_fixed_size() {
        let inv = Invoice {
            tag: INVOICE_TAG,
            bump: 0,
            merchant: Pubkey::default(),
            invoice_index: 0,
            amount: 0,
            currency: CURRENCY_USDC,
            status: INVOICE_STATUS_OPEN,
            created_at: 0,
            swept_at: 0,
        };
        let bytes = inv.try_to_vec().unwrap();
        assert_eq!(bytes.len(), Invoice::SIZE);
    }
}
