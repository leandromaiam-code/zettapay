use serde::{Deserialize, Serialize};

/// A registered ZettaPay merchant returned by the API.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Merchant {
    pub id: i64,
    pub name: String,
    #[serde(rename = "walletPubkey")]
    pub wallet_pubkey: String,
    #[serde(rename = "usdcAta")]
    pub usdc_ata: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

/// Body of `Client::register_merchant`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RegisterMerchantInput {
    pub name: String,
    #[serde(rename = "wallet_pubkey")]
    pub wallet_pubkey: String,
    #[serde(rename = "usdc_ata")]
    pub usdc_ata: String,
}

/// Patch body for `Client::update_merchant`. `None` fields are omitted from
/// the JSON request so the API treats them as "not provided".
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateMerchantInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "wallet_pubkey", skip_serializing_if = "Option::is_none")]
    pub wallet_pubkey: Option<String>,
    #[serde(rename = "usdc_ata", skip_serializing_if = "Option::is_none")]
    pub usdc_ata: Option<String>,
}

/// Envelope returned by `Client::list_merchants`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ListMerchantsResponse {
    pub items: Vec<Merchant>,
    pub count: u32,
}

/// A payment recovered from the ledger.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PaymentRecord {
    pub id: String,
    #[serde(rename = "feePayer")]
    pub fee_payer: String,
    pub signers: Vec<String>,
    pub signatures: Vec<String>,
    #[serde(rename = "recentBlockhash")]
    pub recent_blockhash: String,
    #[serde(rename = "isVersioned")]
    pub is_versioned: bool,
    pub version: Option<i32>,
    #[serde(rename = "transactionBytes")]
    pub transaction_bytes: u32,
    #[serde(rename = "acceptedAt")]
    pub accepted_at: i64,
}

/// Receipt returned by `Client::pay` / `Client::pay_base64`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PayResponse {
    pub accepted: bool,
    #[serde(rename = "paymentId")]
    pub payment_id: String,
    #[serde(rename = "feePayer")]
    pub fee_payer: String,
    pub signers: Vec<String>,
    #[serde(rename = "signatureCount")]
    pub signature_count: u32,
    #[serde(rename = "recentBlockhash")]
    pub recent_blockhash: String,
    #[serde(rename = "isVersioned")]
    pub is_versioned: bool,
    pub version: Option<i32>,
    #[serde(rename = "transactionBytes")]
    pub transaction_bytes: u32,
}

/// Envelope returned by `Client::list_payments`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ListPaymentsResponse {
    pub items: Vec<PaymentRecord>,
    pub count: u32,
    pub total: u32,
}

/// Response of the `/healthz` probe.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HealthStatus {
    pub status: String,
    pub merchants: u32,
    pub payments: u32,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ApiErrorEnvelope {
    pub error: ApiErrorBody,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ApiErrorBody {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub details: Option<serde_json::Value>,
}
