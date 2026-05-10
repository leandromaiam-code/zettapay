use serde_json::Value;

/// Typed error returned by every client method on a non-2xx response or
/// transport failure.
///
/// Mirrors the JSON envelope emitted by the API:
/// `{"error":{"code","message","details"}}`.
///
/// # Example
///
/// ```no_run
/// # use zettapay::{Client, Error};
/// # async fn run(client: Client) {
/// match client.get_merchant(42).await {
///     Ok(m) => println!("{}", m.name),
///     Err(err) if err.is_code("not_found") => println!("missing"),
///     Err(err) if err.is_status(429) => println!("rate limited"),
///     Err(err) => eprintln!("unexpected: {err}"),
/// }
/// # }
/// ```
#[derive(Debug)]
pub struct Error {
    /// API error code (e.g. `"not_found"`, `"validation_error"`,
    /// `"rate_limited"`). For transport failures (DNS, dial, timeout) this is
    /// `"network_error"`, `"timeout"`, or `"canceled"`.
    pub code: String,
    /// Human-readable explanation, taken from the API body when available,
    /// otherwise from the underlying transport error.
    pub message: String,
    /// HTTP status code, or `None` for transport failures.
    pub status_code: Option<u16>,
    /// Optional structured payload (typically a list of validation problems).
    pub details: Option<Value>,
}

impl Error {
    pub(crate) fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status_code: None,
            details: None,
        }
    }

    pub(crate) fn with_status(mut self, status: u16) -> Self {
        self.status_code = Some(status);
        self
    }

    pub(crate) fn with_details(mut self, details: Option<Value>) -> Self {
        self.details = details;
        self
    }

    /// Returns true when the error code matches.
    pub fn is_code(&self, code: &str) -> bool {
        self.code == code
    }

    /// Returns true when the HTTP status matches. Always false for transport
    /// failures.
    pub fn is_status(&self, status: u16) -> bool {
        self.status_code == Some(status)
    }

    /// Whether this error is safe to retry. Network errors (no status) and
    /// HTTP 429 / 5xx are retryable; everything else is not.
    pub(crate) fn is_retryable(&self) -> bool {
        match self.status_code {
            None => true,
            Some(429) => true,
            Some(s) => (500..=599).contains(&s),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status_code {
            Some(s) => write!(
                f,
                "zettapay: {} (code={}, status={})",
                self.message, self.code, s
            ),
            None => write!(f, "zettapay: {} (code={})", self.message, self.code),
        }
    }
}

impl std::error::Error for Error {}

impl From<reqwest::Error> for Error {
    fn from(err: reqwest::Error) -> Self {
        let code = if err.is_timeout() {
            "timeout"
        } else if err.is_connect() || err.is_request() {
            "network_error"
        } else if err.is_decode() {
            "decode_error"
        } else {
            "network_error"
        };
        let status = err.status().map(|s| s.as_u16());
        Self {
            code: code.into(),
            message: err.to_string(),
            status_code: status,
            details: None,
        }
    }
}

impl From<url::ParseError> for Error {
    fn from(err: url::ParseError) -> Self {
        Error::new("invalid_url", err.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(err: serde_json::Error) -> Self {
        Error::new("encode_error", err.to_string())
    }
}
