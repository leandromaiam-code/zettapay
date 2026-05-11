//! End-to-end ZettaPay Rust SDK quickstart.
//!
//! Walks the full happy path against a live API:
//!
//! 1. Health probe.
//! 2. Register a merchant.
//! 3. Read it back, list with pagination, patch it.
//! 4. Submit a base64-encoded x402 payment (requires a real signed tx).
//! 5. Clean up.
//!
//! ## Run
//!
//! Local dev API (no auth):
//!
//! ```bash
//! cargo run --example quickstart
//! ```
//!
//! Deployed environment:
//!
//! ```bash
//! ZETTAPAY_BASE_URL=https://api.zettapay.dev \
//! ZETTAPAY_API_KEY=zp_live_... \
//! cargo run --example quickstart
//! ```
//!
//! The payment step is skipped unless `ZETTAPAY_SIGNED_TX_BASE64` is set —
//! the SDK does not sign transactions. Produce a base64-encoded signed
//! Solana USDC transfer with your wallet/keypair tooling and pass it via
//! env var.

use std::env;
use std::time::Duration;

use zettapay::{
    Client, Error, ListOptions, RegisterMerchantInput, RetryPolicy, UpdateMerchantInput,
};

#[tokio::main]
async fn main() -> Result<(), Error> {
    let base_url = env::var("ZETTAPAY_BASE_URL").unwrap_or_else(|_| "http://localhost:3000".into());
    let api_key = env::var("ZETTAPAY_API_KEY").ok();
    let signed_tx = env::var("ZETTAPAY_SIGNED_TX_BASE64").ok();

    let mut builder = Client::builder()
        .base_url(&base_url)
        .timeout(Duration::from_secs(10))
        .retry(RetryPolicy::default_policy());
    if let Some(key) = api_key {
        builder = builder.api_key(key);
    }
    let client = builder.build()?;

    println!("→ ZettaPay quickstart against {base_url}");

    let health = client.health().await?;
    println!(
        "  health: status={} merchants={} payments={}",
        health.status, health.merchants, health.payments
    );

    let merchant = client
        .register_merchant(RegisterMerchantInput {
            name: "Acme Coffee".into(),
            wallet_pubkey: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT".into(),
            usdc_ata: "EhpbDdUDKv2Ah6yyhyqz7n9zUQqvmW1qzPKNaqgQ4kZK".into(),
        })
        .await?;
    println!(
        "  registered merchant id={} name={:?}",
        merchant.id, merchant.name
    );

    let fetched = client.get_merchant(merchant.id).await?;
    assert_eq!(fetched.id, merchant.id);
    println!(
        "  fetched merchant id={} createdAt={}",
        fetched.id, fetched.created_at
    );

    let listing = client.list_merchants(ListOptions::new().limit(5)).await?;
    println!(
        "  list_merchants: count={} returned={}",
        listing.count,
        listing.items.len()
    );

    let patched = client
        .update_merchant(
            merchant.id,
            UpdateMerchantInput {
                name: Some("Acme Coffee — Downtown".into()),
                ..Default::default()
            },
        )
        .await?;
    println!("  patched merchant name={:?}", patched.name);

    if let Some(tx) = signed_tx {
        let receipt = client.pay_base64(&tx).await?;
        println!(
            "  pay: accepted={} payment_id={} feePayer={}",
            receipt.accepted, receipt.payment_id, receipt.fee_payer
        );
        let record = client.get_payment(&receipt.payment_id).await?;
        println!(
            "  get_payment: id={} signers={}",
            record.id,
            record.signers.len()
        );
    } else {
        println!("  pay: skipped (set ZETTAPAY_SIGNED_TX_BASE64 to exercise /pay)");
    }

    client.delete_merchant(merchant.id).await?;
    println!("  deleted merchant id={}", merchant.id);

    match client.get_merchant(merchant.id).await {
        Err(err) if err.is_code("not_found") || err.is_status(404) => {
            println!("  confirmed deletion (404 not_found)");
        }
        Err(err) => return Err(err),
        Ok(_) => {
            return Err(Error {
                code: "assertion_failed".into(),
                message: "merchant still exists after delete".into(),
                status_code: None,
                details: None,
            });
        }
    }

    println!("✓ done");
    Ok(())
}
