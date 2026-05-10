use std::time::Duration;

/// Controls retry behavior for transient failures on idempotent operations.
///
/// Construct via [`RetryPolicy::default_policy`] for sane defaults, or build
/// your own:
///
/// ```
/// use std::time::Duration;
/// use zettapay::RetryPolicy;
///
/// let policy = RetryPolicy::new(5, Duration::from_millis(50), Duration::from_secs(5));
/// ```
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    /// Total number of attempts (including the first). Values below 1 are
    /// treated as 1 (no retries).
    pub max_attempts: u32,
    /// Base delay before the first retry.
    pub initial_backoff: Duration,
    /// Per-attempt sleep cap.
    pub max_backoff: Duration,
}

impl RetryPolicy {
    /// Build a policy with explicit values.
    pub const fn new(
        max_attempts: u32,
        initial_backoff: Duration,
        max_backoff: Duration,
    ) -> Self {
        Self {
            max_attempts,
            initial_backoff,
            max_backoff,
        }
    }

    /// Sane defaults: 3 attempts, 100ms → 2s exponential growth with full
    /// jitter.
    pub const fn default_policy() -> Self {
        Self {
            max_attempts: 3,
            initial_backoff: Duration::from_millis(100),
            max_backoff: Duration::from_secs(2),
        }
    }

    /// Disabled — single attempt, no retries.
    pub const fn disabled() -> Self {
        Self {
            max_attempts: 1,
            initial_backoff: Duration::ZERO,
            max_backoff: Duration::ZERO,
        }
    }

    pub(crate) fn attempts(&self) -> u32 {
        self.max_attempts.max(1)
    }

    /// Sleep for the given attempt index (0-based), exponential growth with
    /// full jitter, clamped to `max_backoff`.
    pub(crate) fn backoff_for(&self, attempt: u32, rng: &mut impl rand::Rng) -> Duration {
        let base = if self.initial_backoff.is_zero() {
            Duration::from_millis(100)
        } else {
            self.initial_backoff
        };
        let cap = if self.max_backoff.is_zero() {
            Duration::from_secs(2)
        } else {
            self.max_backoff
        };

        // exp = base * 2^attempt, saturating to cap.
        let factor = 1u64.checked_shl(attempt).unwrap_or(u64::MAX);
        let exp_nanos = (base.as_nanos() as u64).saturating_mul(factor);
        let cap_nanos = cap.as_nanos() as u64;
        let bound = exp_nanos.min(cap_nanos);
        if bound == 0 {
            return Duration::ZERO;
        }
        let jitter = rng.gen_range(0..bound);
        Duration::from_nanos(jitter)
    }
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self::disabled()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    #[test]
    fn attempts_floor_at_one() {
        let p = RetryPolicy::new(0, Duration::from_millis(10), Duration::from_secs(1));
        assert_eq!(p.attempts(), 1);
    }

    #[test]
    fn backoff_respects_cap() {
        let p = RetryPolicy::new(10, Duration::from_millis(100), Duration::from_millis(500));
        let mut rng = rand::rngs::StdRng::seed_from_u64(42);
        for attempt in 0..8 {
            let d = p.backoff_for(attempt, &mut rng);
            assert!(d <= Duration::from_millis(500));
        }
    }

    #[test]
    fn defaults_are_sane() {
        let p = RetryPolicy::default_policy();
        assert_eq!(p.max_attempts, 3);
        assert_eq!(p.initial_backoff, Duration::from_millis(100));
        assert_eq!(p.max_backoff, Duration::from_secs(2));
    }
}
