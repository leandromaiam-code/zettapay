use std::collections::HashMap;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
use reqwest::{Method, StatusCode};
use serde::Serialize;
use url::Url;

use crate::error::Error;
use crate::retry::RetryPolicy;
use crate::types::{
    ApiErrorEnvelope, HealthStatus, ListMerchantsResponse, ListPaymentsResponse, Merchant,
    PayResponse, PaymentRecord, RegisterMerchantInput, UpdateMerchantInput,
};

/// HTTP header carrying a base64-encoded signed Solana transaction blob on
/// `POST /pay`, per the [x402 protocol spec](https://github.com/coinbase/x402).
pub const X402_HEADER: &str = "x-402-payment";

const DEFAULT_USER_AGENT: &str = concat!("zettapay-rust-sdk/", env!("CARGO_PKG_VERSION"));
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

/// Pagination options for list endpoints.
#[derive(Debug, Clone, Copy, Default)]
pub struct ListOptions {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

impl ListOptions {
    pub const fn new() -> Self {
        Self {
            limit: None,
            offset: None,
        }
    }

    pub const fn limit(mut self, n: u32) -> Self {
        self.limit = Some(n);
        self
    }

    pub const fn offset(mut self, n: u32) -> Self {
        self.offset = Some(n);
        self
    }
}

/// Builder for [`Client`]. Only `base_url` is required.
///
/// ```no_run
/// use std::time::Duration;
/// use zettapay::{Client, RetryPolicy};
///
/// let client = Client::builder()
///     .base_url("https://api.zettapay.dev")
///     .api_key("zp_live_...")
///     .timeout(Duration::from_secs(15))
///     .retry(RetryPolicy::default_policy())
///     .header("x-correlation-id", "abc123")
///     .build()
///     .expect("valid config");
/// ```
#[derive(Debug, Default)]
pub struct ClientBuilder {
    base_url: Option<String>,
    api_key: Option<String>,
    user_agent: Option<String>,
    timeout: Option<Duration>,
    retry: Option<RetryPolicy>,
    headers: HashMap<String, String>,
    http_client: Option<reqwest::Client>,
}

impl ClientBuilder {
    /// Sets the API origin (e.g. `"https://api.zettapay.dev"`).
    pub fn base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = Some(base_url.into());
        self
    }

    /// Sets the API key sent as `Authorization: Bearer <key>`.
    pub fn api_key(mut self, api_key: impl Into<String>) -> Self {
        self.api_key = Some(api_key.into());
        self
    }

    /// Overrides the default `User-Agent` header.
    pub fn user_agent(mut self, ua: impl Into<String>) -> Self {
        self.user_agent = Some(ua.into());
        self
    }

    /// Sets the per-request timeout (default 10s). Ignored when a custom
    /// `http_client` is supplied.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// Sets the retry policy. Default is no retries.
    pub fn retry(mut self, policy: RetryPolicy) -> Self {
        self.retry = Some(policy);
        self
    }

    /// Attaches an extra header to every request. Repeated calls accumulate.
    pub fn header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.insert(key.into(), value.into());
        self
    }

    /// Replaces the underlying [`reqwest::Client`]. When set, [`Self::timeout`]
    /// is ignored — configure it on the supplied client.
    pub fn http_client(mut self, client: reqwest::Client) -> Self {
        self.http_client = Some(client);
        self
    }

    /// Validates configuration and returns a [`Client`].
    pub fn build(self) -> Result<Client, Error> {
        let raw = self
            .base_url
            .ok_or_else(|| Error::new("invalid_config", "base_url is required"))?;
        let trimmed = raw.trim().trim_end_matches('/').to_string();
        if trimmed.is_empty() {
            return Err(Error::new("invalid_config", "base_url is required"));
        }
        let parsed = Url::parse(&trimmed).map_err(|e| {
            Error::new(
                "invalid_config",
                format!("invalid base_url '{trimmed}': {e}"),
            )
        })?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(Error::new(
                "invalid_config",
                format!("base_url scheme must be http or https (got {})", parsed.scheme()),
            ));
        }

        let http = match self.http_client {
            Some(c) => c,
            None => reqwest::Client::builder()
                .timeout(self.timeout.unwrap_or(DEFAULT_TIMEOUT))
                .build()
                .map_err(Error::from)?,
        };

        Ok(Client {
            base_url: trimmed,
            api_key: self.api_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()),
            http,
            retry: self.retry.unwrap_or_else(RetryPolicy::disabled),
            user_agent: self
                .user_agent
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_USER_AGENT.to_string()),
            headers: self.headers,
        })
    }
}

/// Thread-safe ZettaPay API client. Cheap to clone — wraps an `Arc`-backed
/// [`reqwest::Client`].
#[derive(Debug, Clone)]
pub struct Client {
    base_url: String,
    api_key: Option<String>,
    http: reqwest::Client,
    retry: RetryPolicy,
    user_agent: String,
    headers: HashMap<String, String>,
}

impl Client {
    /// Returns a new [`ClientBuilder`].
    pub fn builder() -> ClientBuilder {
        ClientBuilder::default()
    }

    /// Convenience constructor — equivalent to
    /// `Client::builder().base_url(url).build()`.
    pub fn new(base_url: impl Into<String>) -> Result<Self, Error> {
        Self::builder().base_url(base_url).build()
    }

    /// API origin, with trailing slash trimmed.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    // ---- API surface --------------------------------------------------------

    /// `GET /healthz` — liveness probe.
    pub async fn health(&self) -> Result<HealthStatus, Error> {
        self.request_json(Method::GET, "/healthz", None, NoBody, true, None)
            .await
    }

    /// `POST /merchants` — create a merchant. Validates required fields
    /// client-side before issuing the request.
    pub async fn register_merchant(
        &self,
        input: RegisterMerchantInput,
    ) -> Result<Merchant, Error> {
        if input.name.trim().is_empty() {
            return Err(Error::new(
                "validation_error",
                "register_merchant: name is required",
            ));
        }
        if input.wallet_pubkey.trim().is_empty() {
            return Err(Error::new(
                "validation_error",
                "register_merchant: wallet_pubkey is required",
            ));
        }
        if input.usdc_ata.trim().is_empty() {
            return Err(Error::new(
                "validation_error",
                "register_merchant: usdc_ata is required",
            ));
        }
        self.request_json(Method::POST, "/merchants", None, Some(&input), false, None)
            .await
    }

    /// `GET /merchants/:id`.
    pub async fn get_merchant(&self, id: i64) -> Result<Merchant, Error> {
        let path = format!("/merchants/{id}");
        self.request_json(Method::GET, &path, None, NoBody, true, None)
            .await
    }

    /// `GET /merchants` — paginated list.
    pub async fn list_merchants(
        &self,
        opts: ListOptions,
    ) -> Result<ListMerchantsResponse, Error> {
        let query = list_query(opts);
        self.request_json(
            Method::GET,
            "/merchants",
            Some(query),
            NoBody,
            true,
            None,
        )
        .await
    }

    /// `PATCH /merchants/:id`.
    pub async fn update_merchant(
        &self,
        id: i64,
        patch: UpdateMerchantInput,
    ) -> Result<Merchant, Error> {
        let path = format!("/merchants/{id}");
        self.request_json(Method::PATCH, &path, None, Some(&patch), false, None)
            .await
    }

    /// `DELETE /merchants/:id`.
    pub async fn delete_merchant(&self, id: i64) -> Result<(), Error> {
        let path = format!("/merchants/{id}");
        self.request_no_body(Method::DELETE, &path, None, NoBody, true, None)
            .await
    }

    /// `POST /pay` — submits a base64-encoded signed Solana transaction via
    /// the `x-402-payment` header.
    ///
    /// Accepts either raw bytes (which the SDK base64-encodes) or a string
    /// that already looks like base64.
    pub async fn pay(&self, transaction: &[u8]) -> Result<PayResponse, Error> {
        let encoded = encode_pay_body(transaction);
        if encoded.is_empty() {
            return Err(Error::new("validation_error", "pay: transaction is required"));
        }
        let mut headers = HashMap::new();
        headers.insert(X402_HEADER.to_string(), encoded);
        self.request_json(Method::POST, "/pay", None, NoBody, false, Some(headers))
            .await
    }

    /// `POST /pay` — convenience for callers that already hold a base64 string.
    pub async fn pay_base64(&self, transaction_base64: &str) -> Result<PayResponse, Error> {
        let trimmed = transaction_base64.trim();
        if trimmed.is_empty() {
            return Err(Error::new(
                "validation_error",
                "pay_base64: transaction is required",
            ));
        }
        let mut headers = HashMap::new();
        headers.insert(X402_HEADER.to_string(), trimmed.to_string());
        self.request_json(Method::POST, "/pay", None, NoBody, false, Some(headers))
            .await
    }

    /// `GET /payments/:id`.
    pub async fn get_payment(&self, id: &str) -> Result<PaymentRecord, Error> {
        let id = id.trim();
        if id.is_empty() {
            return Err(Error::new(
                "validation_error",
                "get_payment: id is required",
            ));
        }
        let path = format!("/payments/{}", urlencode_segment(id));
        self.request_json(Method::GET, &path, None, NoBody, true, None)
            .await
    }

    /// `GET /payments` — paginated list.
    pub async fn list_payments(
        &self,
        opts: ListOptions,
    ) -> Result<ListPaymentsResponse, Error> {
        let query = list_query(opts);
        self.request_json(Method::GET, "/payments", Some(query), NoBody, true, None)
            .await
    }

    // ---- request plumbing ---------------------------------------------------

    async fn request_json<B, T>(
        &self,
        method: Method,
        path: &str,
        query: Option<Vec<(&'static str, String)>>,
        body: B,
        retryable: bool,
        extra_headers: Option<HashMap<String, String>>,
    ) -> Result<T, Error>
    where
        B: BodyOpt,
        T: serde::de::DeserializeOwned,
    {
        let bytes = self
            .request_raw(method, path, query, body, retryable, extra_headers)
            .await?;
        if bytes.is_empty() {
            return Err(Error::new("decode_error", "empty response body"));
        }
        serde_json::from_slice(&bytes).map_err(|e| Error::new("decode_error", e.to_string()))
    }

    async fn request_no_body<B>(
        &self,
        method: Method,
        path: &str,
        query: Option<Vec<(&'static str, String)>>,
        body: B,
        retryable: bool,
        extra_headers: Option<HashMap<String, String>>,
    ) -> Result<(), Error>
    where
        B: BodyOpt,
    {
        self.request_raw(method, path, query, body, retryable, extra_headers)
            .await?;
        Ok(())
    }

    async fn request_raw<B>(
        &self,
        method: Method,
        path: &str,
        query: Option<Vec<(&'static str, String)>>,
        body: B,
        retryable: bool,
        extra_headers: Option<HashMap<String, String>>,
    ) -> Result<Vec<u8>, Error>
    where
        B: BodyOpt,
    {
        let body_bytes = body.to_json_bytes()?;
        let attempts = if retryable { self.retry.attempts() } else { 1 };
        let mut last_err: Option<Error> = None;

        for attempt in 0..attempts {
            if attempt > 0 {
                let delay = {
                    let mut rng = rand::thread_rng();
                    self.retry.backoff_for(attempt - 1, &mut rng)
                };
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
            }

            let result = self
                .one_attempt(
                    method.clone(),
                    path,
                    query.as_deref(),
                    body_bytes.as_deref(),
                    extra_headers.as_ref(),
                )
                .await;

            match result {
                Ok(bytes) => return Ok(bytes),
                Err(err) => {
                    if !retryable || !err.is_retryable() {
                        return Err(err);
                    }
                    last_err = Some(err);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| Error::new("network_error", "exhausted retries")))
    }

    async fn one_attempt(
        &self,
        method: Method,
        path: &str,
        query: Option<&[(&'static str, String)]>,
        body: Option<&[u8]>,
        extra_headers: Option<&HashMap<String, String>>,
    ) -> Result<Vec<u8>, Error> {
        let mut url = Url::parse(&format!("{}{}", self.base_url, path))?;
        if let Some(pairs) = query {
            if !pairs.is_empty() {
                let mut q = url.query_pairs_mut();
                for (k, v) in pairs {
                    q.append_pair(k, v);
                }
            }
        }

        let mut headers = HeaderMap::new();
        headers.insert(
            USER_AGENT,
            HeaderValue::from_str(&self.user_agent)
                .map_err(|e| Error::new("invalid_config", e.to_string()))?,
        );
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        if body.is_some() {
            headers.insert(
                reqwest::header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
        }
        if let Some(key) = &self.api_key {
            let value = HeaderValue::from_str(&format!("Bearer {key}"))
                .map_err(|e| Error::new("invalid_config", e.to_string()))?;
            headers.insert(AUTHORIZATION, value);
        }
        for (k, v) in &self.headers {
            insert_header(&mut headers, k, v)?;
        }
        if let Some(extra) = extra_headers {
            for (k, v) in extra {
                insert_header(&mut headers, k, v)?;
            }
        }

        let mut req = self.http.request(method, url).headers(headers);
        if let Some(b) = body {
            req = req.body(b.to_vec());
        }

        let resp = req.send().await.map_err(Error::from)?;
        let status = resp.status();
        let body = resp.bytes().await.map_err(Error::from)?.to_vec();

        if status.is_success() {
            return Ok(body);
        }
        Err(parse_error_response(status, &body))
    }
}

fn insert_header(headers: &mut HeaderMap, key: &str, value: &str) -> Result<(), Error> {
    let name = HeaderName::from_bytes(key.as_bytes())
        .map_err(|e| Error::new("invalid_config", format!("invalid header name '{key}': {e}")))?;
    let val = HeaderValue::from_str(value)
        .map_err(|e| Error::new("invalid_config", format!("invalid header value: {e}")))?;
    headers.insert(name, val);
    Ok(())
}

fn parse_error_response(status: StatusCode, body: &[u8]) -> Error {
    if let Ok(envelope) = serde_json::from_slice::<ApiErrorEnvelope>(body) {
        if !envelope.error.code.is_empty() {
            return Error::new(envelope.error.code, envelope.error.message)
                .with_status(status.as_u16())
                .with_details(envelope.error.details);
        }
    }
    let message = if body.is_empty() {
        format!("request failed with status {}", status.as_u16())
    } else {
        let text = String::from_utf8_lossy(body).trim().to_string();
        if text.chars().count() > 200 {
            let truncated: String = text.chars().take(200).collect();
            format!("{truncated}…")
        } else {
            text
        }
    };
    Error::new("http_error", message).with_status(status.as_u16())
}

fn list_query(opts: ListOptions) -> Vec<(&'static str, String)> {
    let mut q = Vec::with_capacity(2);
    if let Some(limit) = opts.limit {
        q.push(("limit", limit.to_string()));
    }
    if let Some(offset) = opts.offset {
        if offset > 0 {
            q.push(("offset", offset.to_string()));
        }
    }
    q
}

fn encode_pay_body(transaction: &[u8]) -> String {
    if transaction.is_empty() {
        return String::new();
    }
    if is_likely_base64(transaction) {
        if let Ok(s) = std::str::from_utf8(transaction) {
            if BASE64.decode(s).is_ok() {
                return s.to_string();
            }
        }
    }
    BASE64.encode(transaction)
}

fn is_likely_base64(b: &[u8]) -> bool {
    if b.is_empty() {
        return false;
    }
    b.iter().all(|c| {
        matches!(c, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' | b'=')
    })
}

fn urlencode_segment(s: &str) -> String {
    // Percent-encode reserved characters in a URL path segment.
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}

// ---- internal body trait ---------------------------------------------------

trait BodyOpt {
    fn to_json_bytes(&self) -> Result<Option<Vec<u8>>, Error>;
}

#[derive(Copy, Clone)]
struct NoBodyMarker;

#[allow(non_upper_case_globals)]
const NoBody: NoBodyMarker = NoBodyMarker;

impl BodyOpt for NoBodyMarker {
    fn to_json_bytes(&self) -> Result<Option<Vec<u8>>, Error> {
        Ok(None)
    }
}

impl<T: Serialize> BodyOpt for Option<&T> {
    fn to_json_bytes(&self) -> Result<Option<Vec<u8>>, Error> {
        match self {
            Some(v) => Ok(Some(serde_json::to_vec(v)?)),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_pay_body_passes_through_base64() {
        let s = b"SGVsbG8sIFdvcmxkIQ==";
        assert_eq!(encode_pay_body(s), "SGVsbG8sIFdvcmxkIQ==");
    }

    #[test]
    fn encode_pay_body_encodes_raw_bytes() {
        let raw = &[0xDE, 0xAD, 0xBE, 0xEF];
        assert_eq!(encode_pay_body(raw), "3q2+7w==");
    }

    #[test]
    fn encode_pay_body_empty_input() {
        assert_eq!(encode_pay_body(&[]), "");
    }

    #[test]
    fn list_query_omits_zero_offset() {
        let q = list_query(ListOptions::new().limit(10));
        assert_eq!(q.len(), 1);
        assert_eq!(q[0], ("limit", "10".to_string()));
    }

    #[test]
    fn list_query_includes_both() {
        let q = list_query(ListOptions::new().limit(5).offset(20));
        assert_eq!(q.len(), 2);
    }

    #[test]
    fn list_query_empty() {
        let q = list_query(ListOptions::new());
        assert!(q.is_empty());
    }

    #[test]
    fn urlencode_segment_preserves_unreserved() {
        assert_eq!(urlencode_segment("abc-XYZ_123.~"), "abc-XYZ_123.~");
    }

    #[test]
    fn urlencode_segment_escapes_reserved() {
        assert_eq!(urlencode_segment("a/b c"), "a%2Fb%20c");
    }

    #[test]
    fn builder_requires_base_url() {
        let err = Client::builder().build().unwrap_err();
        assert_eq!(err.code, "invalid_config");
    }

    #[test]
    fn builder_rejects_invalid_scheme() {
        let err = Client::builder().base_url("ftp://x.com").build().unwrap_err();
        assert_eq!(err.code, "invalid_config");
    }

    #[test]
    fn builder_trims_trailing_slash() {
        let c = Client::new("https://api.example.com/").unwrap();
        assert_eq!(c.base_url(), "https://api.example.com");
    }
}
