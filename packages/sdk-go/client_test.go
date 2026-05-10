package zettapay

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fixedJitter makes backoff deterministic in tests.
type fixedJitter struct{}

func (fixedJitter) Int63n(int64) int64 { return 0 }

func newTestClient(t *testing.T, srv *httptest.Server) *Client {
	t.Helper()
	c, err := NewClient(ClientConfig{
		BaseURL: srv.URL,
		Retry:   RetryPolicy{MaxAttempts: 3, InitialBackoff: time.Millisecond, MaxBackoff: 5 * time.Millisecond},
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c.jitter = fixedJitter{}
	return c
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func TestNewClientValidatesBaseURL(t *testing.T) {
	if _, err := NewClient(ClientConfig{}); err == nil {
		t.Fatal("expected error for empty BaseURL")
	}
	if _, err := NewClient(ClientConfig{BaseURL: "   "}); err == nil {
		t.Fatal("expected error for blank BaseURL")
	}
}

func TestHealth(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		writeJSON(w, 200, HealthStatus{Status: "ok", Merchants: 3, Payments: 7})
	}))
	defer srv.Close()
	c := newTestClient(t, srv)

	got, err := c.Health(context.Background())
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	if got.Status != "ok" || got.Merchants != 3 || got.Payments != 7 {
		t.Fatalf("unexpected response: %+v", got)
	}
}

func TestRegisterAndGetMerchant(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/merchants":
			body, _ := io.ReadAll(r.Body)
			var got map[string]any
			if err := json.Unmarshal(body, &got); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			if got["wallet_pubkey"] != "PUB" || got["usdc_ata"] != "ATA" {
				t.Fatalf("unexpected body: %+v", got)
			}
			if r.Header.Get("Content-Type") != "application/json" {
				t.Fatalf("expected json content-type, got %q", r.Header.Get("Content-Type"))
			}
			writeJSON(w, 201, Merchant{ID: 42, Name: "Acme", WalletPubkey: "PUB", UsdcATA: "ATA", CreatedAt: 1700000000})
		case r.Method == http.MethodGet && r.URL.Path == "/merchants/42":
			writeJSON(w, 200, Merchant{ID: 42, Name: "Acme", WalletPubkey: "PUB", UsdcATA: "ATA", CreatedAt: 1700000000})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	c := newTestClient(t, srv)
	ctx := context.Background()

	m, err := c.RegisterMerchant(ctx, RegisterMerchantInput{Name: "Acme", WalletPubkey: "PUB", UsdcATA: "ATA"})
	if err != nil {
		t.Fatalf("RegisterMerchant: %v", err)
	}
	if m.ID != 42 {
		t.Fatalf("unexpected id: %d", m.ID)
	}

	got, err := c.GetMerchant(ctx, 42)
	if err != nil {
		t.Fatalf("GetMerchant: %v", err)
	}
	if got.Name != "Acme" {
		t.Fatalf("unexpected merchant: %+v", got)
	}
}

func TestRegisterMerchantValidatesInput(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("server should not be called: %s %s", r.Method, r.URL.Path)
	}))
	defer srv.Close()
	c := newTestClient(t, srv)
	ctx := context.Background()

	if _, err := c.RegisterMerchant(ctx, RegisterMerchantInput{}); err == nil {
		t.Fatal("expected error for empty Name")
	}
	if _, err := c.RegisterMerchant(ctx, RegisterMerchantInput{Name: "x"}); err == nil {
		t.Fatal("expected error for empty WalletPubkey")
	}
	if _, err := c.RegisterMerchant(ctx, RegisterMerchantInput{Name: "x", WalletPubkey: "p"}); err == nil {
		t.Fatal("expected error for empty UsdcATA")
	}
}

func TestListMerchantsBuildsQuery(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") != "5" || r.URL.Query().Get("offset") != "10" {
			t.Fatalf("unexpected query: %v", r.URL.RawQuery)
		}
		writeJSON(w, 200, ListMerchantsResponse{
			Items: []Merchant{{ID: 1, Name: "a"}, {ID: 2, Name: "b"}},
			Count: 2,
		})
	}))
	defer srv.Close()
	c := newTestClient(t, srv)

	res, err := c.ListMerchants(context.Background(), ListOptions{Limit: 5, Offset: 10})
	if err != nil {
		t.Fatalf("ListMerchants: %v", err)
	}
	if res.Count != 2 || len(res.Items) != 2 {
		t.Fatalf("unexpected response: %+v", res)
	}
}

func TestUpdateAndDeleteMerchant(t *testing.T) {
	deleted := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPatch && r.URL.Path == "/merchants/7":
			body, _ := io.ReadAll(r.Body)
			var got map[string]any
			_ = json.Unmarshal(body, &got)
			if got["name"] != "newname" {
				t.Fatalf("unexpected patch body: %+v", got)
			}
			if _, ok := got["wallet_pubkey"]; ok {
				t.Fatalf("empty fields should be omitted, got %+v", got)
			}
			writeJSON(w, 200, Merchant{ID: 7, Name: "newname"})
		case r.Method == http.MethodDelete && r.URL.Path == "/merchants/7":
			deleted = true
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	c := newTestClient(t, srv)
	ctx := context.Background()

	patched, err := c.UpdateMerchant(ctx, 7, UpdateMerchantInput{Name: "newname"})
	if err != nil {
		t.Fatalf("UpdateMerchant: %v", err)
	}
	if patched.Name != "newname" {
		t.Fatalf("unexpected: %+v", patched)
	}
	if err := c.DeleteMerchant(ctx, 7); err != nil {
		t.Fatalf("DeleteMerchant: %v", err)
	}
	if !deleted {
		t.Fatal("delete handler not invoked")
	}
}

func TestPaySendsX402Header(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/pay" || r.Method != http.MethodPost {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		hdr := r.Header.Get(X402Header)
		if hdr == "" {
			t.Fatal("missing x-402-payment header")
		}
		writeJSON(w, 200, PayResponse{Accepted: true, PaymentID: "pay_123", SignatureCount: 1, FeePayer: "FP"})
	}))
	defer srv.Close()
	c := newTestClient(t, srv)

	res, err := c.PayBase64(context.Background(), "AAEC")
	if err != nil {
		t.Fatalf("Pay: %v", err)
	}
	if !res.Accepted || res.PaymentID != "pay_123" {
		t.Fatalf("unexpected: %+v", res)
	}

	// Raw bytes should be base64-encoded for the caller.
	res2, err := c.Pay(context.Background(), []byte{0x01, 0x02, 0x03})
	if err != nil {
		t.Fatalf("Pay raw: %v", err)
	}
	if !res2.Accepted {
		t.Fatalf("unexpected: %+v", res2)
	}
}

func TestPayValidatesEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("server should not be called: %s %s", r.Method, r.URL.Path)
	}))
	defer srv.Close()
	c := newTestClient(t, srv)
	ctx := context.Background()
	if _, err := c.PayBase64(ctx, ""); err == nil {
		t.Fatal("expected empty error")
	}
	if _, err := c.Pay(ctx, nil); err == nil {
		t.Fatal("expected empty error")
	}
}

func TestErrorEnvelopeParsed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 409, apiErrorEnvelope{Error: apiErrorBody{
			Code:    "conflict",
			Message: "wallet already registered",
			Details: map[string]any{"field": "wallet"},
		}})
	}))
	defer srv.Close()
	c := newTestClient(t, srv)

	_, err := c.RegisterMerchant(context.Background(), RegisterMerchantInput{Name: "a", WalletPubkey: "p", UsdcATA: "u"})
	if err == nil {
		t.Fatal("expected error")
	}
	var zerr *Error
	if !errors.As(err, &zerr) {
		t.Fatalf("expected *Error, got %T", err)
	}
	if zerr.Code != "conflict" || zerr.StatusCode != 409 {
		t.Fatalf("unexpected: %+v", zerr)
	}
	if zerr.Message != "wallet already registered" {
		t.Fatalf("unexpected message: %q", zerr.Message)
	}
	if !IsCode(err, "conflict") {
		t.Fatal("IsCode should match")
	}
	if !IsStatus(err, 409) {
		t.Fatal("IsStatus should match")
	}
}

func TestErrorWithoutEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_, _ = w.Write([]byte("not found"))
	}))
	defer srv.Close()
	c := newTestClient(t, srv)

	_, err := c.GetMerchant(context.Background(), 1)
	var zerr *Error
	if !errors.As(err, &zerr) {
		t.Fatalf("expected *Error, got %T", err)
	}
	if zerr.StatusCode != 404 || zerr.Code != "http_error" {
		t.Fatalf("unexpected: %+v", zerr)
	}
}

func TestRetryOn5xxThenSucceeds(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n < 3 {
			writeJSON(w, 503, apiErrorEnvelope{Error: apiErrorBody{Code: "upstream_error", Message: "try again"}})
			return
		}
		writeJSON(w, 200, HealthStatus{Status: "ok"})
	}))
	defer srv.Close()
	c := newTestClient(t, srv)

	if _, err := c.Health(context.Background()); err != nil {
		t.Fatalf("Health: %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Fatalf("expected 3 attempts, got %d", got)
	}
}

func TestRetryGivesUpAfterMaxAttempts(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		writeJSON(w, 503, apiErrorEnvelope{Error: apiErrorBody{Code: "upstream_error", Message: "down"}})
	}))
	defer srv.Close()
	c := newTestClient(t, srv)

	_, err := c.Health(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Fatalf("expected 3 attempts, got %d", got)
	}
	if !IsCode(err, "upstream_error") {
		t.Fatalf("unexpected code: %v", err)
	}
}

func TestRetryNotAttemptedOnPost(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		writeJSON(w, 503, apiErrorEnvelope{Error: apiErrorBody{Code: "upstream_error", Message: "down"}})
	}))
	defer srv.Close()
	c := newTestClient(t, srv)

	_, err := c.RegisterMerchant(context.Background(), RegisterMerchantInput{Name: "x", WalletPubkey: "y", UsdcATA: "z"})
	if err == nil {
		t.Fatal("expected error")
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("non-idempotent POST should not be retried, got %d attempts", got)
	}
}

func TestNoRetryOn4xx(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		writeJSON(w, 404, apiErrorEnvelope{Error: apiErrorBody{Code: "not_found", Message: "missing"}})
	}))
	defer srv.Close()
	c := newTestClient(t, srv)

	_, err := c.GetMerchant(context.Background(), 1)
	if !IsCode(err, "not_found") {
		t.Fatalf("unexpected: %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("4xx should not retry, got %d attempts", got)
	}
}

func TestRetryOn429(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n == 1 {
			writeJSON(w, 429, apiErrorEnvelope{Error: apiErrorBody{Code: "rate_limited", Message: "slow down"}})
			return
		}
		writeJSON(w, 200, HealthStatus{Status: "ok"})
	}))
	defer srv.Close()
	c := newTestClient(t, srv)

	if _, err := c.Health(context.Background()); err != nil {
		t.Fatalf("Health: %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("expected 2 attempts, got %d", got)
	}
}

func TestContextCancellationStopsRetry(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 503, apiErrorEnvelope{Error: apiErrorBody{Code: "upstream_error", Message: "down"}})
	}))
	defer srv.Close()
	c, err := NewClient(ClientConfig{
		BaseURL: srv.URL,
		Retry:   RetryPolicy{MaxAttempts: 5, InitialBackoff: 50 * time.Millisecond, MaxBackoff: time.Second},
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c.jitter = fixedJitter{}

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	_, err = c.Health(ctx)
	wg.Wait()
	if err == nil {
		t.Fatal("expected error on cancel")
	}
	if !errors.Is(err, context.Canceled) && !IsCode(err, "canceled") {
		t.Fatalf("expected canceled error, got %v", err)
	}
}

func TestAuthHeaderAndUserAgent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Fatalf("missing auth header: %q", r.Header.Get("Authorization"))
		}
		if !strings.HasPrefix(r.Header.Get("User-Agent"), "zettapay-go-sdk/") {
			t.Fatalf("unexpected UA: %q", r.Header.Get("User-Agent"))
		}
		if r.Header.Get("X-Custom") != "yes" {
			t.Fatalf("missing custom header")
		}
		writeJSON(w, 200, HealthStatus{Status: "ok"})
	}))
	defer srv.Close()

	c, err := NewClient(ClientConfig{
		BaseURL: srv.URL,
		APIKey:  "secret",
		Headers: map[string]string{"X-Custom": "yes"},
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if _, err := c.Health(context.Background()); err != nil {
		t.Fatalf("Health: %v", err)
	}
}

func TestPaymentRoundTrip(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/payments/abc":
			writeJSON(w, 200, PaymentRecord{ID: "abc", FeePayer: "fp", AcceptedAt: 1700000000})
		case r.Method == http.MethodGet && r.URL.Path == "/payments":
			writeJSON(w, 200, ListPaymentsResponse{Items: []PaymentRecord{{ID: "abc"}}, Count: 1, Total: 1})
		default:
			t.Fatalf("unexpected: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	c := newTestClient(t, srv)
	ctx := context.Background()

	rec, err := c.GetPayment(ctx, "abc")
	if err != nil || rec.ID != "abc" {
		t.Fatalf("GetPayment: %v %+v", err, rec)
	}
	if _, err := c.GetPayment(ctx, ""); err == nil {
		t.Fatal("expected validation error for empty id")
	}
	list, err := c.ListPayments(ctx, ListOptions{Limit: 5})
	if err != nil {
		t.Fatalf("ListPayments: %v", err)
	}
	if list.Total != 1 || len(list.Items) != 1 {
		t.Fatalf("unexpected: %+v", list)
	}
}

func TestRetryPolicyBackoff(t *testing.T) {
	p := RetryPolicy{MaxAttempts: 5, InitialBackoff: 10 * time.Millisecond, MaxBackoff: 80 * time.Millisecond}
	for i := 0; i < 5; i++ {
		got := p.backoffFor(i, fixedJitter{})
		if got != 0 {
			t.Fatalf("with zero jitter, attempt %d should be 0, got %v", i, got)
		}
	}
	if p.attempts() != 5 {
		t.Fatalf("attempts(): %d", p.attempts())
	}
	zero := RetryPolicy{}
	if zero.attempts() != 1 {
		t.Fatalf("zero policy should be 1 attempt, got %d", zero.attempts())
	}
}

func TestEncodePayBody(t *testing.T) {
	if got := encodePayBody(nil); got != "" {
		t.Fatalf("nil should encode to empty: %q", got)
	}
	// Already valid base64 → passthrough.
	if got := encodePayBody([]byte("AAEC")); got != "AAEC" {
		t.Fatalf("base64 passthrough failed: %q", got)
	}
	// Raw bytes → encoded.
	if got := encodePayBody([]byte{0xff}); got != "/w==" {
		t.Fatalf("expected base64 of 0xff, got %q", got)
	}
}
