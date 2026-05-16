//! Integration tests for the webhook signature verifier.
//!
//! These mirror, case for case, the canonical test matrix in
//! `packages/api/test/webhook-signature.test.ts` so that all three SDKs
//! (TypeScript, Python, Rust) and the API server stay byte-identical.

use zettapay::webhook::{
    parse_webhook, sign_payload, ParseWebhookResult, ParsedWebhook, VerifyOptions, WebhookError,
    DEFAULT_TOLERANCE_SEC, SIGNATURE_PREFIX,
};

const SECRET: &str = "whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAYLOAD: &str = r#"{"event":"payment.completed","id":"pay_1"}"#;
const FIXED_TS_MS: i64 = 1_700_000_000_000;

fn base_opts<'a>(sig: &'a str, ts: &'a str, now_ms: i64) -> VerifyOptions<'a> {
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

fn expect_valid(result: ParseWebhookResult) -> ParsedWebhook {
    match result {
        ParseWebhookResult::Valid(p) => p,
        ParseWebhookResult::Invalid(err) => panic!("expected Valid, got Invalid({err:?})"),
    }
}

fn expect_invalid(result: ParseWebhookResult, want: WebhookError) {
    match result {
        ParseWebhookResult::Valid(_) => panic!("expected Invalid({want:?}), got Valid"),
        ParseWebhookResult::Invalid(got) => assert_eq!(got, want, "wrong failure reason"),
    }
}

#[test]
fn signs_and_verifies_round_trip() {
    let sig = sign_payload(SECRET, PAYLOAD, FIXED_TS_MS);
    assert!(sig.starts_with(SIGNATURE_PREFIX));
    assert_eq!(sig.len(), SIGNATURE_PREFIX.len() + 64);

    let ts = FIXED_TS_MS.to_string();
    let parsed = expect_valid(parse_webhook(base_opts(&sig, &ts, FIXED_TS_MS)));
    assert_eq!(parsed.payload, PAYLOAD);
    assert_eq!(parsed.timestamp_ms, FIXED_TS_MS);
    assert_eq!(parsed.event_id, None);
}

#[test]
fn surfaces_event_id_when_provided() {
    let sig = sign_payload(SECRET, PAYLOAD, FIXED_TS_MS);
    let ts = FIXED_TS_MS.to_string();
    let mut opts = base_opts(&sig, &ts, FIXED_TS_MS);
    opts.event_id = Some("evt_42");

    let parsed = expect_valid(parse_webhook(opts));
    assert_eq!(parsed.event_id.as_deref(), Some("evt_42"));
}

#[test]
fn rejects_tampered_payload() {
    let sig = sign_payload(SECRET, PAYLOAD, FIXED_TS_MS);
    let ts = FIXED_TS_MS.to_string();
    let mut opts = base_opts(&sig, &ts, FIXED_TS_MS);
    let tampered = format!("{PAYLOAD}x");
    opts.payload = &tampered;

    expect_invalid(parse_webhook(opts), WebhookError::SignatureMismatch);
}

#[test]
fn rejects_wrong_secret() {
    let sig = sign_payload(SECRET, PAYLOAD, FIXED_TS_MS);
    let ts = FIXED_TS_MS.to_string();
    let mut opts = base_opts(&sig, &ts, FIXED_TS_MS);
    opts.secret = "whsec_wrong";

    expect_invalid(parse_webhook(opts), WebhookError::SignatureMismatch);
}

#[test]
fn rejects_timestamp_outside_tolerance_window() {
    let sig = sign_payload(SECRET, PAYLOAD, FIXED_TS_MS);
    let ts = FIXED_TS_MS.to_string();
    let ten_minutes_later = FIXED_TS_MS + 10 * 60 * 1_000;

    expect_invalid(
        parse_webhook(base_opts(&sig, &ts, ten_minutes_later)),
        WebhookError::TimestampOutOfTolerance,
    );
}

#[test]
fn accepts_drift_inside_tolerance_window() {
    let sig = sign_payload(SECRET, PAYLOAD, FIXED_TS_MS);
    let ts = FIXED_TS_MS.to_string();
    let four_minutes_later = FIXED_TS_MS + 4 * 60 * 1_000;

    expect_valid(parse_webhook(base_opts(&sig, &ts, four_minutes_later)));
}

#[test]
fn rejects_malformed_signature_header() {
    let ts = FIXED_TS_MS.to_string();
    expect_invalid(
        parse_webhook(base_opts("sha256=not-hex", &ts, FIXED_TS_MS)),
        WebhookError::MalformedSignature,
    );
}

#[test]
fn rejects_odd_length_signature() {
    let ts = FIXED_TS_MS.to_string();
    expect_invalid(
        parse_webhook(base_opts("sha256=abc", &ts, FIXED_TS_MS)),
        WebhookError::MalformedSignature,
    );
}

#[test]
fn rejects_missing_signature() {
    let ts = FIXED_TS_MS.to_string();
    expect_invalid(
        parse_webhook(base_opts("", &ts, FIXED_TS_MS)),
        WebhookError::MissingSignature,
    );
}

#[test]
fn rejects_missing_timestamp() {
    let sig = sign_payload(SECRET, PAYLOAD, FIXED_TS_MS);
    expect_invalid(
        parse_webhook(base_opts(&sig, "", FIXED_TS_MS)),
        WebhookError::MissingTimestamp,
    );
}

#[test]
fn rejects_non_numeric_timestamp() {
    let sig = sign_payload(SECRET, PAYLOAD, FIXED_TS_MS);
    expect_invalid(
        parse_webhook(base_opts(&sig, "not-a-number", FIXED_TS_MS)),
        WebhookError::InvalidTimestamp,
    );
}

#[test]
fn accepts_signature_with_or_without_prefix() {
    let sig = sign_payload(SECRET, PAYLOAD, FIXED_TS_MS);
    let bare = sig.strip_prefix(SIGNATURE_PREFIX).unwrap().to_owned();
    let ts = FIXED_TS_MS.to_string();

    expect_valid(parse_webhook(base_opts(&bare, &ts, FIXED_TS_MS)));
}

#[test]
fn accepts_uppercase_hex_signature() {
    let sig = sign_payload(SECRET, PAYLOAD, FIXED_TS_MS).to_uppercase();
    // `SHA256=` would not match our case-sensitive prefix; submit the bare hex.
    let bare = sig.replace("SHA256=", "");
    let ts = FIXED_TS_MS.to_string();

    expect_valid(parse_webhook(base_opts(&bare, &ts, FIXED_TS_MS)));
}

#[test]
fn signature_changes_with_timestamp() {
    let a = sign_payload(SECRET, PAYLOAD, FIXED_TS_MS);
    let b = sign_payload(SECRET, PAYLOAD, FIXED_TS_MS + 1);
    assert_ne!(a, b, "signature must depend on timestamp");
}

#[test]
fn invalid_result_into_result_returns_err() {
    let ts = FIXED_TS_MS.to_string();
    let result = parse_webhook(base_opts("", &ts, FIXED_TS_MS));
    assert!(!result.is_valid());
    let err = result.into_result().unwrap_err();
    assert_eq!(err.as_code(), "missing_signature");
}
