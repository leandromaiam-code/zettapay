<?php

declare(strict_types=1);

namespace ZettaPay;

use Psr\Http\Client\ClientInterface as HttpClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\StreamFactoryInterface;
use ZettaPay\Exception\ZettaPayException;

/**
 * Immutable configuration for {@see Client}. Construct via {@see self::create()}
 * for keyword-style instantiation, or pass concrete PSR-18 / PSR-17 instances
 * to wire your own HTTP stack.
 */
final class ClientConfig
{
    /**
     * @param array<string, string> $headers
     */
    public function __construct(
        public readonly string $baseUrl,
        public readonly ?string $apiKey = null,
        public readonly ?HttpClientInterface $httpClient = null,
        public readonly ?RequestFactoryInterface $requestFactory = null,
        public readonly ?StreamFactoryInterface $streamFactory = null,
        public readonly RetryPolicy $retry = new RetryPolicy(),
        public readonly string $userAgent = 'zettapay-php-sdk/1.0',
        public readonly array $headers = [],
    ) {
        $url = trim($this->baseUrl);
        if ($url === '') {
            throw new ZettaPayException('zettapay: baseUrl is required');
        }
        if (filter_var($url, FILTER_VALIDATE_URL) === false) {
            throw new ZettaPayException('zettapay: baseUrl is not a valid URL');
        }
    }

    /**
     * Factory: build a config from a base URL plus optional named overrides.
     * Trailing slashes on baseUrl are trimmed.
     *
     * @param array<string, string> $headers
     */
    public static function create(
        string $baseUrl,
        ?string $apiKey = null,
        ?HttpClientInterface $httpClient = null,
        ?RequestFactoryInterface $requestFactory = null,
        ?StreamFactoryInterface $streamFactory = null,
        ?RetryPolicy $retry = null,
        ?string $userAgent = null,
        array $headers = [],
    ): self {
        return new self(
            baseUrl: rtrim($baseUrl, '/'),
            apiKey: $apiKey,
            httpClient: $httpClient,
            requestFactory: $requestFactory,
            streamFactory: $streamFactory,
            retry: $retry ?? new RetryPolicy(),
            userAgent: $userAgent ?? 'zettapay-php-sdk/1.0',
            headers: $headers,
        );
    }
}
