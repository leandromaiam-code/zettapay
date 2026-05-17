//! Official Rust SDK for the ZettaPay Solana payment protocol.
//!
//! - Async-first via [`tokio`] and [`reqwest`].
//! - Strongly typed [`serde`] models for every API resource.
//! - Builder pattern on [`Client`] (see [`Client::builder`]).
//! - Typed [`Error`] envelope mirroring the API contract.
//! - Built-in retries with exponential backoff + full jitter for idempotent
//!   operations.
//!
//! # Quick start
//!
//! ```no_run
//! use std::time::Duration;
//! use zettapay::{Client, RegisterMerchantInput, RetryPolicy};
//!
//! # async fn run() -> Result<(), zettapay::Error> {
//! let client = Client::builder()
//!     .base_url("https://api.zettapay.dev")
//!     .api_key("zp_live_...")
//!     .timeout(Duration::from_secs(10))
//!     .retry(RetryPolicy::default_policy())
//!     .build()?;
//!
//! let merchant = client
//!     .register_merchant(RegisterMerchantInput {
//!         name: "Acme Coffee".into(),
//!         wallet_pubkey: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT".into(),
//!         usdc_ata: "EhpbDdUDKv2Ah6yyhyqz7n9zUQqvmW1qzPKNaqgQ4kZK".into(),
//!     })
//!     .await?;
//! println!("merchant id={} createdAt={}", merchant.id, merchant.created_at);
//! # Ok(())
//! # }
//! ```

mod client;
mod error;
pub mod invoices;
mod retry;
mod types;
pub mod webhook;

pub use client::{Client, ClientBuilder, ListOptions, X402_HEADER};
pub use error::Error;
pub use invoices::{
    Chain, CreateInvoiceInput, Invoice, InvoiceStatus, WebhookChain, WebhookInvoicePayload,
};
pub use retry::RetryPolicy;
pub use types::{
    HealthStatus, ListMerchantsResponse, ListPaymentsResponse, Merchant, PayResponse,
    PaymentRecord, RegisterMerchantInput, UpdateMerchantInput,
};
