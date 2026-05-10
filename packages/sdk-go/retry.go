package zettapay

import (
	"context"
	"math/rand"
	"sync"
	"time"
)

// RetryPolicy controls the client's retry behavior for transient failures.
// The zero value disables retries.
type RetryPolicy struct {
	// MaxAttempts is the total number of attempts (including the first).
	// Values below 1 are treated as 1 (no retries).
	MaxAttempts int
	// InitialBackoff is the base delay before the first retry.
	InitialBackoff time.Duration
	// MaxBackoff caps the per-attempt sleep.
	MaxBackoff time.Duration
}

// DefaultRetryPolicy returns sane defaults: 3 attempts, 100ms → 2s with
// exponential growth and full jitter.
func DefaultRetryPolicy() RetryPolicy {
	return RetryPolicy{
		MaxAttempts:    3,
		InitialBackoff: 100 * time.Millisecond,
		MaxBackoff:     2 * time.Second,
	}
}

func (p RetryPolicy) attempts() int {
	if p.MaxAttempts < 1 {
		return 1
	}
	return p.MaxAttempts
}

// jitterSource lets tests inject deterministic randomness; production code
// uses a process-wide source seeded once.
type jitterSource interface {
	Int63n(n int64) int64
}

var (
	defaultJitterOnce sync.Once
	defaultJitter     jitterSource
)

func sharedJitter() jitterSource {
	defaultJitterOnce.Do(func() {
		defaultJitter = rand.New(rand.NewSource(time.Now().UnixNano()))
	})
	return defaultJitter
}

// backoffFor returns the sleep duration for the given attempt index (0-based)
// using exponential growth with full jitter, clamped to MaxBackoff.
func (p RetryPolicy) backoffFor(attempt int, src jitterSource) time.Duration {
	base := p.InitialBackoff
	if base <= 0 {
		base = 100 * time.Millisecond
	}
	max := p.MaxBackoff
	if max <= 0 {
		max = 2 * time.Second
	}
	// exp = base * 2^attempt, clamped
	exp := base << attempt
	if exp <= 0 || exp > max {
		exp = max
	}
	if src == nil {
		src = sharedJitter()
	}
	// full jitter: random in [0, exp)
	if exp <= 0 {
		return 0
	}
	return time.Duration(src.Int63n(int64(exp)))
}

// sleepCtx sleeps for d unless ctx is canceled first.
func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
