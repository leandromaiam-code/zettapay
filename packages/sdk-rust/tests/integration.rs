//! Integration tests for the public client surface using `mockito`.

use std::time::Duration;

use mockito::Matcher;
use serde_json::json;
use zettapay::{
    Client, Error, ListOptions, RegisterMerchantInput, RetryPolicy, UpdateMerchantInput,
    X402_HEADER,
};

fn client_for(server: &mockito::ServerGuard) -> Client {
    Client::builder()
        .base_url(server.url())
        .api_key("zp_test_secret")
        .timeout(Duration::from_secs(2))
        .build()
        .expect("client builds")
}

#[tokio::test]
async fn health_returns_status() {
    let mut server = mockito::Server::new_async().await;
    let m = server
        .mock("GET", "/healthz")
        .match_header("authorization", "Bearer zp_test_secret")
        .match_header("accept", "application/json")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"status":"ok","merchants":3,"payments":7}"#)
        .create_async()
        .await;

    let client = client_for(&server);
    let h = client.health().await.expect("health ok");
    assert_eq!(h.status, "ok");
    assert_eq!(h.merchants, 3);
    assert_eq!(h.payments, 7);
    m.assert_async().await;
}

#[tokio::test]
async fn register_merchant_round_trip() {
    let mut server = mockito::Server::new_async().await;
    let m = server
        .mock("POST", "/merchants")
        .match_header("content-type", "application/json")
        .match_body(Matcher::Json(json!({
            "name": "Acme",
            "wallet_pubkey": "WALLET",
            "usdc_ata": "ATA"
        })))
        .with_status(201)
        .with_header("content-type", "application/json")
        .with_body(
            r#"{"id":42,"name":"Acme","walletPubkey":"WALLET","usdcAta":"ATA","createdAt":1700000000}"#,
        )
        .create_async()
        .await;

    let client = client_for(&server);
    let merchant = client
        .register_merchant(RegisterMerchantInput {
            name: "Acme".into(),
            wallet_pubkey: "WALLET".into(),
            usdc_ata: "ATA".into(),
        })
        .await
        .expect("merchant created");

    assert_eq!(merchant.id, 42);
    assert_eq!(merchant.name, "Acme");
    assert_eq!(merchant.wallet_pubkey, "WALLET");
    assert_eq!(merchant.usdc_ata, "ATA");
    assert_eq!(merchant.created_at, 1_700_000_000);
    m.assert_async().await;
}

#[tokio::test]
async fn register_merchant_validates_locally() {
    let server = mockito::Server::new_async().await;
    let client = client_for(&server);

    let err = client
        .register_merchant(RegisterMerchantInput {
            name: "  ".into(),
            wallet_pubkey: "WALLET".into(),
            usdc_ata: "ATA".into(),
        })
        .await
        .unwrap_err();
    assert!(err.is_code("validation_error"));
}

#[tokio::test]
async fn get_merchant_path_includes_id() {
    let mut server = mockito::Server::new_async().await;
    let m = server
        .mock("GET", "/merchants/123")
        .with_status(200)
        .with_body(
            r#"{"id":123,"name":"X","walletPubkey":"W","usdcAta":"A","createdAt":1}"#,
        )
        .create_async()
        .await;

    let client = client_for(&server);
    let merchant = client.get_merchant(123).await.expect("ok");
    assert_eq!(merchant.id, 123);
    m.assert_async().await;
}

#[tokio::test]
async fn list_merchants_serializes_pagination() {
    let mut server = mockito::Server::new_async().await;
    let m = server
        .mock("GET", "/merchants")
        .match_query(Matcher::AllOf(vec![
            Matcher::UrlEncoded("limit".into(), "10".into()),
            Matcher::UrlEncoded("offset".into(), "20".into()),
        ]))
        .with_status(200)
        .with_body(r#"{"items":[],"count":0}"#)
        .create_async()
        .await;

    let client = client_for(&server);
    let list = client
        .list_merchants(ListOptions::new().limit(10).offset(20))
        .await
        .expect("ok");
    assert_eq!(list.count, 0);
    m.assert_async().await;
}

#[tokio::test]
async fn update_merchant_omits_none_fields() {
    let mut server = mockito::Server::new_async().await;
    let m = server
        .mock("PATCH", "/merchants/7")
        .match_body(Matcher::Json(json!({ "name": "NewName" })))
        .with_status(200)
        .with_body(
            r#"{"id":7,"name":"NewName","walletPubkey":"W","usdcAta":"A","createdAt":1}"#,
        )
        .create_async()
        .await;

    let client = client_for(&server);
    let patched = client
        .update_merchant(
            7,
            UpdateMerchantInput {
                name: Some("NewName".into()),
                ..Default::default()
            },
        )
        .await
        .expect("ok");
    assert_eq!(patched.name, "NewName");
    m.assert_async().await;
}

#[tokio::test]
async fn delete_merchant_succeeds_on_204() {
    let mut server = mockito::Server::new_async().await;
    let m = server
        .mock("DELETE", "/merchants/9")
        .with_status(204)
        .create_async()
        .await;

    let client = client_for(&server);
    client.delete_merchant(9).await.expect("ok");
    m.assert_async().await;
}

#[tokio::test]
async fn pay_sets_x402_header_with_base64_passthrough() {
    let mut server = mockito::Server::new_async().await;
    let b64 = "SGVsbG8="; // "Hello"
    let m = server
        .mock("POST", "/pay")
        .match_header(X402_HEADER, b64)
        .with_status(200)
        .with_body(
            r#"{"accepted":true,"paymentId":"pay_1","feePayer":"FP","signers":[],"signatureCount":1,"recentBlockhash":"BH","isVersioned":false,"version":null,"transactionBytes":64}"#,
        )
        .create_async()
        .await;

    let client = client_for(&server);
    let resp = client.pay(b64.as_bytes()).await.expect("ok");
    assert!(resp.accepted);
    assert_eq!(resp.payment_id, "pay_1");
    m.assert_async().await;
}

#[tokio::test]
async fn pay_base64_short_circuits_encode() {
    let mut server = mockito::Server::new_async().await;
    let m = server
        .mock("POST", "/pay")
        .match_header(X402_HEADER, "AQID")
        .with_status(200)
        .with_body(
            r#"{"accepted":true,"paymentId":"p","feePayer":"FP","signers":[],"signatureCount":0,"recentBlockhash":"BH","isVersioned":false,"version":null,"transactionBytes":3}"#,
        )
        .create_async()
        .await;

    let client = client_for(&server);
    client.pay_base64("AQID").await.expect("ok");
    m.assert_async().await;
}

#[tokio::test]
async fn errors_decode_typed_envelope() {
    let mut server = mockito::Server::new_async().await;
    let m = server
        .mock("GET", "/merchants/404")
        .with_status(404)
        .with_header("content-type", "application/json")
        .with_body(r#"{"error":{"code":"not_found","message":"merchant 404 missing"}}"#)
        .create_async()
        .await;

    let client = client_for(&server);
    let err = client.get_merchant(404).await.unwrap_err();
    assert!(err.is_code("not_found"));
    assert!(err.is_status(404));
    assert_eq!(err.message, "merchant 404 missing");
    m.assert_async().await;
}

#[tokio::test]
async fn errors_fall_back_when_envelope_missing() {
    let mut server = mockito::Server::new_async().await;
    let m = server
        .mock("GET", "/merchants/500")
        .with_status(503)
        .with_body("upstream unavailable")
        .create_async()
        .await;

    let client = client_for(&server);
    let err = client.get_merchant(500).await.unwrap_err();
    assert!(err.is_code("http_error"));
    assert!(err.is_status(503));
    m.assert_async().await;
}

#[tokio::test]
async fn retries_on_5xx_for_idempotent_get() {
    let mut server = mockito::Server::new_async().await;
    let m_fail = server
        .mock("GET", "/merchants/1")
        .with_status(503)
        .with_body("oops")
        .expect(2)
        .create_async()
        .await;
    let m_ok = server
        .mock("GET", "/merchants/1")
        .with_status(200)
        .with_body(r#"{"id":1,"name":"X","walletPubkey":"W","usdcAta":"A","createdAt":1}"#)
        .create_async()
        .await;

    let client = Client::builder()
        .base_url(server.url())
        .timeout(Duration::from_secs(2))
        .retry(RetryPolicy::new(
            3,
            Duration::from_millis(1),
            Duration::from_millis(5),
        ))
        .build()
        .unwrap();

    let m = client.get_merchant(1).await.expect("eventually ok");
    assert_eq!(m.id, 1);
    m_fail.assert_async().await;
    m_ok.assert_async().await;
}

#[tokio::test]
async fn no_retry_on_post_when_5xx() {
    let mut server = mockito::Server::new_async().await;
    let m = server
        .mock("POST", "/merchants")
        .with_status(503)
        .with_body(r#"{"error":{"code":"server_error","message":"down"}}"#)
        .expect(1)
        .create_async()
        .await;

    let client = Client::builder()
        .base_url(server.url())
        .timeout(Duration::from_secs(2))
        .retry(RetryPolicy::default_policy())
        .build()
        .unwrap();

    let err: Error = client
        .register_merchant(RegisterMerchantInput {
            name: "A".into(),
            wallet_pubkey: "W".into(),
            usdc_ata: "ATA".into(),
        })
        .await
        .unwrap_err();
    assert!(err.is_status(503));
    m.assert_async().await;
}

#[tokio::test]
async fn no_retry_on_400() {
    let mut server = mockito::Server::new_async().await;
    let m = server
        .mock("GET", "/merchants/2")
        .with_status(400)
        .with_body(r#"{"error":{"code":"bad_request","message":"nope"}}"#)
        .expect(1)
        .create_async()
        .await;

    let client = Client::builder()
        .base_url(server.url())
        .retry(RetryPolicy::new(
            3,
            Duration::from_millis(1),
            Duration::from_millis(5),
        ))
        .build()
        .unwrap();

    let err = client.get_merchant(2).await.unwrap_err();
    assert!(err.is_code("bad_request"));
    m.assert_async().await;
}

#[tokio::test]
async fn extra_headers_propagate() {
    let mut server = mockito::Server::new_async().await;
    let m = server
        .mock("GET", "/healthz")
        .match_header("x-tenant", "acme")
        .with_status(200)
        .with_body(r#"{"status":"ok","merchants":0,"payments":0}"#)
        .create_async()
        .await;

    let client = Client::builder()
        .base_url(server.url())
        .header("x-tenant", "acme")
        .build()
        .unwrap();

    client.health().await.expect("ok");
    m.assert_async().await;
}

#[tokio::test]
async fn get_payment_percent_encodes_id() {
    let mut server = mockito::Server::new_async().await;
    let m = server
        .mock("GET", "/payments/abc%2Fdef")
        .with_status(200)
        .with_body(
            r#"{"id":"abc/def","feePayer":"FP","signers":[],"signatures":[],"recentBlockhash":"BH","isVersioned":false,"version":null,"transactionBytes":10,"acceptedAt":1}"#,
        )
        .create_async()
        .await;

    let client = client_for(&server);
    let rec = client.get_payment("abc/def").await.expect("ok");
    assert_eq!(rec.id, "abc/def");
    m.assert_async().await;
}
