//! Multi-chain invoice surface (Z52).
//!
//! ZettaPay watches BTC + USDC across EVM (Base / Polygon / Ethereum).
//! Callers create an invoice with a required `chain` field; the listener
//! detects the inbound tx to the per-invoice receive address and fires the
//! webhook.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// Chain enum accepted by `POST /api/invoices`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Chain {
    Btc,
    Base,
    Polygon,
    Ethereum,
}

impl Chain {
    pub const ALL: &'static [Chain] = &[Chain::Btc, Chain::Base, Chain::Polygon, Chain::Ethereum];

    pub fn as_str(&self) -> &'static str {
        match self {
            Chain::Btc => "btc",
            Chain::Base => "base",
            Chain::Polygon => "polygon",
            Chain::Ethereum => "ethereum",
        }
    }
}

impl fmt::Display for Chain {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Chain {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "btc" => Ok(Chain::Btc),
            "base" => Ok(Chain::Base),
            "polygon" => Ok(Chain::Polygon),
            "ethereum" => Ok(Chain::Ethereum),
            other => Err(format!("unsupported chain: {other}")),
        }
    }
}

/// Webhook chain — either a [`Chain`] or `"unknown"` for legacy (pre-Z52)
/// events that lack the field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WebhookChain {
    Btc,
    Base,
    Polygon,
    Ethereum,
    Unknown,
}

impl WebhookChain {
    pub fn from_optional(value: Option<&str>) -> Self {
        match value {
            Some("btc") => WebhookChain::Btc,
            Some("base") => WebhookChain::Base,
            Some("polygon") => WebhookChain::Polygon,
            Some("ethereum") => WebhookChain::Ethereum,
            _ => WebhookChain::Unknown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InvoiceStatus {
    Pending,
    Detected,
    Confirming,
    Confirmed,
    Expired,
    Canceled,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CreateInvoiceInput {
    pub amount_usd: f64,
    pub chain: Chain,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merchant_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Invoice {
    pub invoice_id: String,
    pub chain: Chain,
    pub receive_address: String,
    pub amount_usd: f64,
    pub amount_native: String,
    pub qr_uri: String,
    pub expires_at: i64,
    pub status: InvoiceStatus,
    pub verify_url: String,
    #[serde(default)]
    pub merchant_id: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WebhookInvoicePayload {
    pub invoice_id: String,
    pub status: InvoiceStatus,
    #[serde(default = "default_webhook_chain")]
    pub chain: WebhookChain,
    pub tx_hash: Option<String>,
    pub amount_native: String,
    pub confirmations: u32,
    pub receive_address: String,
    pub merchant_id: String,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

fn default_webhook_chain() -> WebhookChain {
    WebhookChain::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_str_round_trip() {
        for c in Chain::ALL {
            let s = c.as_str();
            let parsed: Chain = s.parse().unwrap();
            assert_eq!(parsed, *c);
        }
    }

    #[test]
    fn chain_rejects_solana() {
        assert!("solana".parse::<Chain>().is_err());
        assert!("BTC".parse::<Chain>().is_err());
    }

    #[test]
    fn chain_serializes_lowercase() {
        let json = serde_json::to_string(&Chain::Base).unwrap();
        assert_eq!(json, "\"base\"");
    }

    #[test]
    fn chain_deserializes_lowercase() {
        let c: Chain = serde_json::from_str("\"polygon\"").unwrap();
        assert_eq!(c, Chain::Polygon);
    }

    #[test]
    fn webhook_chain_falls_back_to_unknown() {
        assert_eq!(WebhookChain::from_optional(None), WebhookChain::Unknown);
        assert_eq!(
            WebhookChain::from_optional(Some("solana")),
            WebhookChain::Unknown,
        );
        assert_eq!(
            WebhookChain::from_optional(Some("base")),
            WebhookChain::Base,
        );
    }

    #[test]
    fn webhook_payload_legacy_event_has_unknown_chain() {
        let raw = serde_json::json!({
            "invoice_id": "inv_legacy",
            "status": "confirmed",
            "tx_hash": "0xabc",
            "amount_native": "29.00",
            "confirmations": 3,
            "receive_address": "0xMerchant",
            "merchant_id": "mer_42"
        });
        let payload: WebhookInvoicePayload = serde_json::from_value(raw).unwrap();
        assert!(matches!(payload.chain, WebhookChain::Unknown));
    }

    #[test]
    fn webhook_payload_parses_chain_field() {
        let raw = serde_json::json!({
            "invoice_id": "inv_001",
            "status": "confirmed",
            "chain": "base",
            "tx_hash": "0xabc",
            "amount_native": "29.00",
            "confirmations": 3,
            "receive_address": "0xMerchant",
            "merchant_id": "mer_42"
        });
        let payload: WebhookInvoicePayload = serde_json::from_value(raw).unwrap();
        assert!(matches!(payload.chain, WebhookChain::Base));
        assert_eq!(payload.confirmations, 3);
    }

    #[test]
    fn create_input_skips_optional_fields_in_json() {
        let input = CreateInvoiceInput {
            amount_usd: 29.0,
            chain: Chain::Base,
            merchant_id: None,
            ttl_seconds: None,
            metadata: None,
        };
        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(json["amount_usd"], 29.0);
        assert_eq!(json["chain"], "base");
        assert!(json.get("merchant_id").is_none());
        assert!(json.get("ttl_seconds").is_none());
        assert!(json.get("metadata").is_none());
    }
}
