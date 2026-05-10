package zettapay

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// X402Header is the HTTP header carrying a base64-encoded signed Solana
// transaction blob on POST /pay, per the x402 protocol spec.
const X402Header = "x-402-payment"

// userAgent identifies SDK requests in server logs.
const userAgent = "zettapay-go-sdk/1.0"

// ClientConfig configures a new Client. Only BaseURL is required.
type ClientConfig struct {
	// BaseURL is the API origin (e.g. "https://api.zettapay.dev"). Trailing
	// slashes are trimmed.
	BaseURL string
	// APIKey, when non-empty, is sent as Authorization: Bearer <APIKey>.
	APIKey string
	// HTTPClient overrides the underlying *http.Client. When nil, a client
	// with Timeout=Timeout is created.
	HTTPClient *http.Client
	// Timeout is applied to the default HTTP client (ignored when HTTPClient
	// is set). Defaults to 10s.
	Timeout time.Duration
	// Retry controls retry behavior on idempotent requests. The zero value
	// disables retries; use DefaultRetryPolicy() for sane defaults.
	Retry RetryPolicy
	// UserAgent overrides the default User-Agent header.
	UserAgent string
	// Headers are extra headers attached to every request.
	Headers map[string]string
}

// Client is a thread-safe ZettaPay API client.
type Client struct {
	baseURL string
	apiKey  string
	http    *http.Client
	retry   RetryPolicy
	ua      string
	headers map[string]string

	// jitter is overridable for tests.
	jitter jitterSource
}

// NewClient validates cfg and returns a ready-to-use Client.
func NewClient(cfg ClientConfig) (*Client, error) {
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if base == "" {
		return nil, errors.New("zettapay: BaseURL is required")
	}
	if _, err := url.Parse(base); err != nil {
		return nil, fmt.Errorf("zettapay: invalid BaseURL: %w", err)
	}
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		timeout := cfg.Timeout
		if timeout <= 0 {
			timeout = 10 * time.Second
		}
		httpClient = &http.Client{Timeout: timeout}
	}
	ua := cfg.UserAgent
	if ua == "" {
		ua = userAgent
	}
	headers := make(map[string]string, len(cfg.Headers))
	for k, v := range cfg.Headers {
		headers[k] = v
	}
	return &Client{
		baseURL: base,
		apiKey:  strings.TrimSpace(cfg.APIKey),
		http:    httpClient,
		retry:   cfg.Retry,
		ua:      ua,
		headers: headers,
	}, nil
}

// Health probes GET /healthz.
func (c *Client) Health(ctx context.Context) (*HealthStatus, error) {
	var out HealthStatus
	if err := c.do(ctx, http.MethodGet, "/healthz", nil, nil, &out, true); err != nil {
		return nil, err
	}
	return &out, nil
}

// RegisterMerchant creates a new merchant via POST /merchants.
func (c *Client) RegisterMerchant(ctx context.Context, input RegisterMerchantInput) (*Merchant, error) {
	if input.Name == "" {
		return nil, errors.New("zettapay: RegisterMerchant: Name is required")
	}
	if input.WalletPubkey == "" {
		return nil, errors.New("zettapay: RegisterMerchant: WalletPubkey is required")
	}
	if input.UsdcATA == "" {
		return nil, errors.New("zettapay: RegisterMerchant: UsdcATA is required")
	}
	var out Merchant
	if err := c.do(ctx, http.MethodPost, "/merchants", nil, input, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetMerchant fetches a merchant by id via GET /merchants/:id.
func (c *Client) GetMerchant(ctx context.Context, id int64) (*Merchant, error) {
	var out Merchant
	path := "/merchants/" + strconv.FormatInt(id, 10)
	if err := c.do(ctx, http.MethodGet, path, nil, nil, &out, true); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListMerchants fetches a page of merchants via GET /merchants.
func (c *Client) ListMerchants(ctx context.Context, opts ListOptions) (*ListMerchantsResponse, error) {
	q := listOptsToQuery(opts)
	var out ListMerchantsResponse
	if err := c.do(ctx, http.MethodGet, "/merchants", q, nil, &out, true); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateMerchant patches a merchant via PATCH /merchants/:id.
func (c *Client) UpdateMerchant(ctx context.Context, id int64, patch UpdateMerchantInput) (*Merchant, error) {
	var out Merchant
	path := "/merchants/" + strconv.FormatInt(id, 10)
	if err := c.do(ctx, http.MethodPatch, path, nil, patch, &out, false); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteMerchant removes a merchant via DELETE /merchants/:id.
func (c *Client) DeleteMerchant(ctx context.Context, id int64) error {
	path := "/merchants/" + strconv.FormatInt(id, 10)
	return c.do(ctx, http.MethodDelete, path, nil, nil, nil, true)
}

// Pay submits a base64-encoded signed Solana transaction via POST /pay using
// the X-402 header. transaction may be a base64 string or raw transaction
// bytes (which the SDK will base64-encode).
func (c *Client) Pay(ctx context.Context, transaction []byte) (*PayResponse, error) {
	encoded := encodePayBody(transaction)
	if encoded == "" {
		return nil, errors.New("zettapay: Pay: transaction is required")
	}
	var out PayResponse
	headers := map[string]string{X402Header: encoded}
	if err := c.doWithHeaders(ctx, http.MethodPost, "/pay", nil, nil, &out, false, headers); err != nil {
		return nil, err
	}
	return &out, nil
}

// PayBase64 is a convenience wrapper for callers that already hold a base64
// string and want to skip the encode step.
func (c *Client) PayBase64(ctx context.Context, transactionBase64 string) (*PayResponse, error) {
	transactionBase64 = strings.TrimSpace(transactionBase64)
	if transactionBase64 == "" {
		return nil, errors.New("zettapay: PayBase64: transaction is required")
	}
	var out PayResponse
	headers := map[string]string{X402Header: transactionBase64}
	if err := c.doWithHeaders(ctx, http.MethodPost, "/pay", nil, nil, &out, false, headers); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetPayment fetches a payment receipt via GET /payments/:id.
func (c *Client) GetPayment(ctx context.Context, id string) (*PaymentRecord, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, errors.New("zettapay: GetPayment: id is required")
	}
	var out PaymentRecord
	path := "/payments/" + url.PathEscape(id)
	if err := c.do(ctx, http.MethodGet, path, nil, nil, &out, true); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListPayments fetches a page of payments via GET /payments.
func (c *Client) ListPayments(ctx context.Context, opts ListOptions) (*ListPaymentsResponse, error) {
	q := listOptsToQuery(opts)
	var out ListPaymentsResponse
	if err := c.do(ctx, http.MethodGet, "/payments", q, nil, &out, true); err != nil {
		return nil, err
	}
	return &out, nil
}

func encodePayBody(transaction []byte) string {
	if len(transaction) == 0 {
		return ""
	}
	// Heuristic: if the input is already valid base64 (and ASCII), pass through.
	if isLikelyBase64(transaction) {
		if _, err := base64.StdEncoding.DecodeString(string(transaction)); err == nil {
			return string(transaction)
		}
	}
	return base64.StdEncoding.EncodeToString(transaction)
}

func isLikelyBase64(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	for _, c := range b {
		switch {
		case c >= 'A' && c <= 'Z':
		case c >= 'a' && c <= 'z':
		case c >= '0' && c <= '9':
		case c == '+' || c == '/' || c == '=':
		default:
			return false
		}
	}
	return true
}

func listOptsToQuery(opts ListOptions) url.Values {
	if opts.Limit == 0 && opts.Offset == 0 {
		return nil
	}
	q := url.Values{}
	if opts.Limit > 0 {
		q.Set("limit", strconv.Itoa(opts.Limit))
	}
	if opts.Offset > 0 {
		q.Set("offset", strconv.Itoa(opts.Offset))
	}
	return q
}

// do executes an HTTP request with retry support. retryable indicates whether
// the operation is safe to retry on transient failures (idempotent reads,
// DELETE). Non-idempotent writes are attempted exactly once.
func (c *Client) do(
	ctx context.Context,
	method, path string,
	query url.Values,
	body any,
	out any,
	retryable bool,
) error {
	return c.doWithHeaders(ctx, method, path, query, body, out, retryable, nil)
}

func (c *Client) doWithHeaders(
	ctx context.Context,
	method, path string,
	query url.Values,
	body any,
	out any,
	retryable bool,
	extraHeaders map[string]string,
) error {
	if ctx == nil {
		return errors.New("zettapay: nil context")
	}
	var encoded []byte
	if body != nil {
		var err error
		encoded, err = json.Marshal(body)
		if err != nil {
			return &Error{Code: "encode_error", Message: err.Error(), Cause: err}
		}
	}

	attempts := 1
	if retryable {
		attempts = c.retry.attempts()
	}

	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			delay := c.retry.backoffFor(attempt-1, c.jitter)
			if err := sleepCtx(ctx, delay); err != nil {
				return &Error{
					Code:    classifyContextError(err),
					Message: err.Error(),
					Cause:   err,
				}
			}
		}
		err := c.attempt(ctx, method, path, query, encoded, out, extraHeaders)
		if err == nil {
			return nil
		}
		var zerr *Error
		if errors.As(err, &zerr) {
			if !retryable || !zerr.retryable() {
				return err
			}
			lastErr = err
			continue
		}
		// non-typed error — surface immediately.
		return err
	}
	return lastErr
}

func (c *Client) attempt(
	ctx context.Context,
	method, path string,
	query url.Values,
	body []byte,
	out any,
	extraHeaders map[string]string,
) error {
	endpoint := c.baseURL + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}

	var bodyReader io.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bodyReader)
	if err != nil {
		return &Error{Code: "request_error", Message: err.Error(), Cause: err}
	}
	req.Header.Set("User-Agent", c.ua)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	for k, v := range c.headers {
		req.Header.Set(k, v)
	}
	for k, v := range extraHeaders {
		req.Header.Set(k, v)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return &Error{
			Code:    classifyContextError(err),
			Message: err.Error(),
			Cause:   err,
		}
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return &Error{
			Code:       "read_error",
			Message:    err.Error(),
			StatusCode: resp.StatusCode,
			Cause:      err,
		}
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if out == nil || resp.StatusCode == http.StatusNoContent || len(respBody) == 0 {
			return nil
		}
		if err := json.Unmarshal(respBody, out); err != nil {
			return &Error{
				Code:       "decode_error",
				Message:    err.Error(),
				StatusCode: resp.StatusCode,
				Cause:      err,
			}
		}
		return nil
	}

	// Non-2xx — try to parse the typed envelope.
	var envelope apiErrorEnvelope
	if json.Unmarshal(respBody, &envelope) == nil && envelope.Error.Code != "" {
		return &Error{
			Code:       envelope.Error.Code,
			Message:    envelope.Error.Message,
			StatusCode: resp.StatusCode,
			Details:    envelope.Error.Details,
		}
	}
	return &Error{
		Code:       "http_error",
		Message:    httpStatusMessage(resp.StatusCode, respBody),
		StatusCode: resp.StatusCode,
	}
}

func classifyContextError(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	return "network_error"
}

func httpStatusMessage(status int, body []byte) string {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return fmt.Sprintf("request failed with status %d", status)
	}
	if len(trimmed) > 200 {
		trimmed = trimmed[:200] + "…"
	}
	return trimmed
}
