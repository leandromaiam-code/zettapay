<?php

declare(strict_types=1);

namespace ZettaPay;

/**
 * Controls retry behavior for idempotent requests. Backoff is exponential with
 * full jitter, capped at maxBackoffMs.
 */
final class RetryPolicy
{
    public function __construct(
        public readonly int $maxAttempts = 1,
        public readonly int $initialBackoffMs = 100,
        public readonly int $maxBackoffMs = 2000,
    ) {
    }

    public static function disabled(): self
    {
        return new self(maxAttempts: 1);
    }

    public static function default(): self
    {
        return new self(maxAttempts: 3, initialBackoffMs: 100, maxBackoffMs: 2000);
    }

    /**
     * Returns the delay in microseconds for the given 0-based retry attempt,
     * using exponential growth and full jitter.
     *
     * @param callable():int|null $randomSource Test seam returning an int in [0, PHP_INT_MAX).
     */
    public function backoffMicros(int $attempt, ?callable $randomSource = null): int
    {
        $base = max(1, $this->initialBackoffMs);
        $cap = max($base, $this->maxBackoffMs);
        $exp = $base * (1 << min($attempt, 30));
        if ($exp <= 0 || $exp > $cap) {
            $exp = $cap;
        }
        $rand = $randomSource ?? static fn (): int => random_int(0, PHP_INT_MAX - 1);
        $jitterMs = $rand() % $exp;
        return $jitterMs * 1000;
    }
}
