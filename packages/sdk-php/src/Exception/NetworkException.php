<?php

declare(strict_types=1);

namespace ZettaPay\Exception;

use Throwable;

/**
 * Thrown for transport-level failures (DNS, dial, read, timeout) before any
 * HTTP status is observed. Always retryable.
 */
final class NetworkException extends ZettaPayException
{
    public function __construct(string $message, ?Throwable $previous = null)
    {
        parent::__construct($message, 0, $previous);
    }

    public function isRetryable(): bool
    {
        return true;
    }
}
