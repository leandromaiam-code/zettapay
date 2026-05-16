//! Webhook signature verification.
//!
//! Mirrors the canonical scheme used by the ZettaPay API server:
//!
//! ```text
//! signature = "sha256=" || hex( HMAC_SHA256(secret, timestamp_ms || "." || payload) )
//! ```
//!
//! Two HTTP headers carry the proof, plus an optional event id:
//!
//! - `X-ZettaPay-Signature` — hex digest, optionally prefixed with `sha256=`
//! - `X-ZettaPay-Timestamp` — Unix epoch in **milliseconds**, as a string
//! - `X-ZettaPay-Event-Id`  — opaque event id (used by merchants for idempotency)
//!
//! [`parse_webhook`] verifies all three constraints in one shot:
//!
//! 1. Signature header is present and well-formed hex.
//! 2. Timestamp header is present and a finite integer.
//! 3. Timestamp drift against `now_ms` is within `tolerance_sec`
//!    (default [`DEFAULT_TOLERANCE_SEC`], matching Stripe's 5-minute window).
//! 4. Recomputed HMAC matches the provided digest in constant time.
//!
//! On success it returns a [`ParsedWebhook`] containing the verified payload,
//! timestamp, and event id. On failure it returns a [`WebhookError`] enumerating
//! exactly which check failed — useful for emitting structured logs without
//! leaking secret material.
//!
//! # Example
//!
//! ```no_run
//! use zettapay::webhook::{parse_webhook, sign_payload, ParseWebhookResult, VerifyOptions};
//!
//! let secret = "whsec_abcd1234";
//! let payload = r#"{"event":"payment.completed","id":"pay_1"}"#;
//! let timestamp_ms = 1_700_000_000_000_i64;
//!
//! // Producer side (the API server):
//! let signature = sign_payload(secret, payload, timestamp_ms);
//!
//! // Consumer side (a merchant integration):
//! match parse_webhook(VerifyOptions {
//!     secret,
//!     payload,
//!     signature: &signature,
//!     timestamp: &timestamp_ms.to_string(),
//!     event_id: Some("evt_42"),
//!     tolerance_sec: 300,
//!     now_ms: timestamp_ms,
//! }) {
//!     ParseWebhookResult::Valid(ev) => {
//!         assert_eq!(ev.payload, payload);
//!         assert_eq!(ev.event_id.as_deref(), Some("evt_42"));
//!     }
//!     ParseWebhookResult::Invalid(_) => unreachable!(),
//! }
//! ```

use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

/// HTTP header carrying the hex-encoded HMAC signature.
pub const SIGNATURE_HEADER: &str = "X-ZettaPay-Signature";

/// HTTP header carrying the millisecond Unix timestamp.
pub const TIMESTAMP_HEADER: &str = "X-ZettaPay-Timestamp";

/// HTTP header carrying the opaque event id.
pub const EVENT_ID_HEADER: &str = "X-ZettaPay-Event-Id";

/// Prefix recognised on the signature header (Stripe-style).
pub const SIGNATURE_PREFIX: &str = "sha256=";

/// Default tolerated drift between webhook timestamp and `now`, in seconds.
///
/// Matches the API server and Stripe's webhook tolerance.
pub const DEFAULT_TOLERANCE_SEC: u64 = 300;

type HmacSha256 = Hmac<Sha256>;

/// Successful parse of a signed webhook.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedWebhook {
    /// Raw JSON body, byte-for-byte as it was signed.
    pub payload: String,
    /// Millisecond Unix timestamp from the signature header.
    pub timestamp_ms: i64,
    /// Event id from `X-ZettaPay-Event-Id`, if the header was supplied.
    pub event_id: Option<String>,
}

/// Reason a webhook failed verification.
///
/// Distinct variants let callers distinguish "client mis-configured" (missing
/// or malformed headers) from "attacker tampered with the body or replayed an
/// old event" (signature mismatch, timestamp out of tolerance) when emitting
/// metrics or logs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebhookError {
    /// `X-ZettaPay-Signature` header was empty or absent.
    MissingSignature,
    /// Signature header was present but not valid lowercase hex.
    MalformedSignature,
    /// `X-ZettaPay-Timestamp` header was empty or absent.
    MissingTimestamp,
    /// Timestamp header was present but not parseable as `i64`.
    InvalidTimestamp,
    /// Timestamp drift from `now_ms` exceeds `tolerance_sec`.
    TimestampOutOfTolerance,
    /// Recomputed HMAC did not match the provided digest.
    SignatureMismatch,
}

impl WebhookError {
    /// Stable identifier for logs/metrics. Mirrors the camel-case reason codes
    /// emitted by the TypeScript and Python SDKs.
    pub fn as_code(&self) -> &'static str {
        match self {
            Self::MissingSignature => "missing_signature",
            Self::MalformedSignature => "malformed_signature",
            Self::MissingTimestamp => "missing_timestamp",
            Self::InvalidTimestamp => "invalid_timestamp",
            Self::TimestampOutOfTolerance => "timestamp_out_of_tolerance",
            Self::SignatureMismatch => "signature_mismatch",
        }
    }
}

impl std::fmt::Display for WebhookError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_code())
    }
}

impl std::error::Error for WebhookError {}

/// Outcome of [`parse_webhook`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseWebhookResult {
    /// Headers verified and the recomputed signature matches.
    Valid(ParsedWebhook),
    /// Verification failed; the variant identifies which check tripped.
    Invalid(WebhookError),
}

impl ParseWebhookResult {
    /// Convert into a `Result` for ergonomic use with `?`.
    pub fn into_result(self) -> Result<ParsedWebhook, WebhookError> {
        match self {
            Self::Valid(ev) => Ok(ev),
            Self::Invalid(err) => Err(err),
        }
    }

    /// `true` if the webhook verified successfully.
    pub fn is_valid(&self) -> bool {
        matches!(self, Self::Valid(_))
    }
}

/// Inputs to [`parse_webhook`].
#[derive(Debug, Clone, Copy)]
pub struct VerifyOptions<'a> {
    /// Shared webhook secret (`whsec_...`).
    pub secret: &'a str,
    /// Raw request body, exactly as transmitted.
    pub payload: &'a str,
    /// Value of `X-ZettaPay-Signature`.
    pub signature: &'a str,
    /// Value of `X-ZettaPay-Timestamp`, as a decimal string.
    pub timestamp: &'a str,
    /// Optional value of `X-ZettaPay-Event-Id` to surface in [`ParsedWebhook`].
    pub event_id: Option<&'a str>,
    /// Tolerated drift in seconds; use [`DEFAULT_TOLERANCE_SEC`] when unsure.
    pub tolerance_sec: u64,
    /// Current time in milliseconds since the Unix epoch.
    pub now_ms: i64,
}

/// Sign `payload` for the given `timestamp_ms`, returning the `sha256=…` header
/// value.
///
/// Producers (the API server, tests, replay tools) call this; merchant
/// integrations only ever need [`parse_webhook`].
pub fn sign_payload(secret: &str, payload: &str, timestamp_ms: i64) -> String {
    let digest = compute_digest(secret.as_bytes(), timestamp_ms, payload.as_bytes());
    let mut out = String::with_capacity(SIGNATURE_PREFIX.len() + digest.len() * 2);
    out.push_str(SIGNATURE_PREFIX);
    hex_encode_into(&digest, &mut out);
    out
}

/// Parse and verify a signed webhook.
///
/// Returns [`ParseWebhookResult::Valid`] if every check passes, otherwise
/// [`ParseWebhookResult::Invalid`] with the specific failure reason.
pub fn parse_webhook(opts: VerifyOptions<'_>) -> ParseWebhookResult {
    if opts.signature.trim().is_empty() {
        return ParseWebhookResult::Invalid(WebhookError::MissingSignature);
    }
    if opts.timestamp.trim().is_empty() {
        return ParseWebhookResult::Invalid(WebhookError::MissingTimestamp);
    }

    let ts_ms: i64 = match opts.timestamp.trim().parse() {
        Ok(v) => v,
        Err(_) => return ParseWebhookResult::Invalid(WebhookError::InvalidTimestamp),
    };

    let drift_ms = opts.now_ms.saturating_sub(ts_ms).unsigned_abs();
    let tolerance_ms = (opts.tolerance_sec as u128).saturating_mul(1_000);
    if (drift_ms as u128) > tolerance_ms {
        return ParseWebhookResult::Invalid(WebhookError::TimestampOutOfTolerance);
    }

    let provided = match parse_signature(opts.signature) {
        Some(bytes) => bytes,
        None => return ParseWebhookResult::Invalid(WebhookError::MalformedSignature),
    };

    let expected = compute_digest(opts.secret.as_bytes(), ts_ms, opts.payload.as_bytes());
    if provided.len() != expected.len()
        || provided.as_slice().ct_eq(expected.as_slice()).unwrap_u8() == 0
    {
        return ParseWebhookResult::Invalid(WebhookError::SignatureMismatch);
    }

    ParseWebhookResult::Valid(ParsedWebhook {
        payload: opts.payload.to_owned(),
        timestamp_ms: ts_ms,
        event_id: opts.event_id.map(str::to_owned),
    })
}

fn compute_digest(secret: &[u8], timestamp_ms: i64, payload: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(timestamp_ms.to_string().as_bytes());
    mac.update(b".");
    mac.update(payload);
    mac.finalize().into_bytes().to_vec()
}

fn parse_signature(raw: &str) -> Option<Vec<u8>> {
    let trimmed = raw.trim();
    let body = trimmed.strip_prefix(SIGNATURE_PREFIX).unwrap_or(trimmed);
    if body.is_empty() || body.len() % 2 != 0 {
        return None;
    }
    hex_decode(body)
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks(2) {
        let hi = hex_nibble(chunk[0])?;
        let lo = hex_nibble(chunk[1])?;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn hex_encode_into(bytes: &[u8], out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const PAYLOAD: &str = r#"{"event":"payment.completed","id":"pay_1"}"#;

    fn opts<'a>(sig: &'a str, ts: &'a str, now_ms: i64) -> VerifyOptions<'a> {
        VerifyOptions {
            secret: SECRET,
            payload: PAYLOAD,
            signature: sig,
            timestamp: ts,
            event_id: None,
            tolerance_sec: DEFAULT_TOLERANCE_SEC,
            now_ms,
        }
    }

    #[test]
    fn sign_payload_emits_prefixed_lowercase_hex() {
        let sig = sign_payload(SECRET, PAYLOAD, 1_700_000_000_000);
        assert!(sig.starts_with(SIGNATURE_PREFIX));
        let body = &sig[SIGNATURE_PREFIX.len()..];
        assert_eq!(body.len(), 64);
        assert!(body.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn hex_decode_rejects_odd_length_and_garbage() {
        assert!(parse_signature("sha256=abc").is_none());
        assert!(parse_signature("sha256=zz").is_none());
        assert!(parse_signature("").is_none());
    }
}
