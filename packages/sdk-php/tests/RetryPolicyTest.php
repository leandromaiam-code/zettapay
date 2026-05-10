<?php

declare(strict_types=1);

namespace ZettaPay\Tests;

use PHPUnit\Framework\TestCase;
use ZettaPay\RetryPolicy;

final class RetryPolicyTest extends TestCase
{
    public function testDefaultsAreSane(): void
    {
        $p = RetryPolicy::default();
        self::assertSame(3, $p->maxAttempts);
        self::assertSame(100, $p->initialBackoffMs);
        self::assertSame(2000, $p->maxBackoffMs);
    }

    public function testZeroJitterReturnsZeroDelay(): void
    {
        $p = new RetryPolicy(maxAttempts: 5, initialBackoffMs: 10, maxBackoffMs: 80);
        for ($i = 0; $i < 5; $i++) {
            self::assertSame(0, $p->backoffMicros($i, static fn (): int => 0));
        }
    }

    public function testBackoffIsCappedAtMax(): void
    {
        $p = new RetryPolicy(maxAttempts: 10, initialBackoffMs: 100, maxBackoffMs: 250);
        // Force the random source to PHP_INT_MAX-1 so jitter == exp - 1.
        $delay = $p->backoffMicros(8, static fn (): int => PHP_INT_MAX - 1);
        self::assertLessThanOrEqual(250 * 1000, $delay);
        self::assertGreaterThan(0, $delay);
    }

    public function testDisabledMeansNoRetries(): void
    {
        $p = RetryPolicy::disabled();
        self::assertSame(1, $p->maxAttempts);
    }
}
