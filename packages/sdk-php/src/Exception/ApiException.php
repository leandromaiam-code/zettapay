<?php

declare(strict_types=1);

namespace ZettaPay\Exception;

use Throwable;

/**
 * Thrown when the API returns a non-2xx response. Mirrors the JSON envelope
 * emitted by the API: {"error":{"code","message","details"}}.
 */
final class ApiException extends ZettaPayException
{
    public function __construct(
        public readonly string $errorCode,
        string $message,
        public readonly int $statusCode,
        public readonly mixed $details = null,
        ?Throwable $previous = null,
    ) {
        parent::__construct($message, $statusCode, $previous);
    }

    public function isRetryable(): bool
    {
        return $this->statusCode === 429 || ($this->statusCode >= 500 && $this->statusCode <= 599);
    }
}
