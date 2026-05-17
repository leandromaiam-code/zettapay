<?php

declare(strict_types=1);

namespace ZettaPay;

use Http\Discovery\Psr17FactoryDiscovery;
use Http\Discovery\Psr18ClientDiscovery;
use JsonException;
use Psr\Http\Client\ClientExceptionInterface;
use Psr\Http\Client\ClientInterface as HttpClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\StreamFactoryInterface;
use ZettaPay\Exception\ApiException;
use ZettaPay\Exception\NetworkException;
use ZettaPay\Exception\ZettaPayException;
use ZettaPay\Model\HealthStatus;
use ZettaPay\Model\Merchant;
use ZettaPay\Model\PaginatedList;
use ZettaPay\Model\PayResponse;
use ZettaPay\Model\Payment;
use ZettaPay\Resource\Invoices;
use ZettaPay\Resource\Merchants;
use ZettaPay\Resource\Payments;

/**
 * Thread-agnostic ZettaPay API client. Built on PSR-18 (HTTP client) and
 * PSR-17 (request/stream factories) so callers can swap in any compliant
 * stack — Guzzle, Symfony HttpClient, cURL, etc. When the optional
 * php-http/discovery package is installed and no explicit instances are
 * passed, sane defaults are auto-discovered.
 */
final class Client
{
    /** Header carrying the base64-encoded signed transaction blob (x402 spec). */
    public const X402_HEADER = 'x-402-payment';

    private readonly HttpClientInterface $http;

    private readonly RequestFactoryInterface $requestFactory;

    private readonly StreamFactoryInterface $streamFactory;

    /** @var callable():int */
    private $randomSource;

    /** @var callable(int):void */
    private $sleeper;

    public readonly Merchants $merchants;

    public readonly Payments $payments;

    public readonly Invoices $invoices;

    public function __construct(
        public readonly ClientConfig $config,
    ) {
        $this->http = $config->httpClient ?? Psr18ClientDiscovery::find();
        $this->requestFactory = $config->requestFactory ?? Psr17FactoryDiscovery::findRequestFactory();
        $this->streamFactory = $config->streamFactory ?? Psr17FactoryDiscovery::findStreamFactory();
        $this->randomSource = static fn (): int => random_int(0, PHP_INT_MAX - 1);
        $this->sleeper = static function (int $micros): void {
            usleep(max(0, $micros));
        };
        $this->merchants = new Merchants($this);
        $this->payments = new Payments($this);
        $this->invoices = new Invoices($this);
    }

    /**
     * Factory: build a client from a base URL and optional overrides. Equivalent
     * to `new Client(ClientConfig::create(...))`.
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
        return new self(ClientConfig::create(
            baseUrl: $baseUrl,
            apiKey: $apiKey,
            httpClient: $httpClient,
            requestFactory: $requestFactory,
            streamFactory: $streamFactory,
            retry: $retry,
            userAgent: $userAgent,
            headers: $headers,
        ));
    }

    /**
     * Test seam: replace the random source backing retry jitter.
     *
     * @internal
     * @param callable():int $source
     */
    public function withRandomSource(callable $source): void
    {
        $this->randomSource = $source;
    }

    /**
     * Test seam: replace the sleep function used between retries.
     *
     * @internal
     * @param callable(int):void $sleeper
     */
    public function withSleeper(callable $sleeper): void
    {
        $this->sleeper = $sleeper;
    }

    public function health(): HealthStatus
    {
        $payload = $this->request('GET', '/healthz', retryable: true);
        return HealthStatus::fromArray($payload);
    }

    /**
     * Submit a base64-encoded signed Solana transaction via POST /pay using
     * the X-402 header. Pass either a base64 string or raw transaction bytes
     * (which the SDK will base64-encode).
     */
    public function pay(string $transaction): PayResponse
    {
        $encoded = $this->encodePayBody($transaction);
        if ($encoded === '') {
            throw new ZettaPayException('zettapay: pay: transaction is required');
        }
        $payload = $this->request(
            method: 'POST',
            path: '/pay',
            extraHeaders: [self::X402_HEADER => $encoded],
            retryable: false,
        );
        return PayResponse::fromArray($payload);
    }

    /**
     * @param array<string, mixed> $body
     * @param array<string, string|int> $query
     * @param array<string, string> $extraHeaders
     * @return array<string, mixed>
     */
    public function request(
        string $method,
        string $path,
        ?array $body = null,
        array $query = [],
        array $extraHeaders = [],
        bool $retryable = false,
    ): array {
        $attempts = max(1, $this->config->retry->maxAttempts);
        if (!$retryable) {
            $attempts = 1;
        }

        $lastException = null;
        for ($attempt = 0; $attempt < $attempts; $attempt++) {
            if ($attempt > 0) {
                $delay = $this->config->retry->backoffMicros($attempt - 1, $this->randomSource);
                ($this->sleeper)($delay);
            }
            try {
                return $this->attempt($method, $path, $body, $query, $extraHeaders);
            } catch (NetworkException $e) {
                $lastException = $e;
                if (!$retryable) {
                    throw $e;
                }
            } catch (ApiException $e) {
                if (!$retryable || !$e->isRetryable()) {
                    throw $e;
                }
                $lastException = $e;
            }
        }
        throw $lastException ?? new NetworkException('zettapay: request failed without typed cause');
    }

    /**
     * @param array<string, mixed>|null $body
     * @param array<string, string|int> $query
     * @param array<string, string> $extraHeaders
     * @return array<string, mixed>
     */
    private function attempt(
        string $method,
        string $path,
        ?array $body,
        array $query,
        array $extraHeaders,
    ): array {
        $request = $this->buildRequest($method, $path, $body, $query, $extraHeaders);

        try {
            $response = $this->http->sendRequest($request);
        } catch (ClientExceptionInterface $e) {
            throw new NetworkException('zettapay: ' . $e->getMessage(), $e);
        }

        return $this->decodeResponse($response);
    }

    /**
     * @param array<string, mixed>|null $body
     * @param array<string, string|int> $query
     * @param array<string, string> $extraHeaders
     */
    private function buildRequest(
        string $method,
        string $path,
        ?array $body,
        array $query,
        array $extraHeaders,
    ): RequestInterface {
        $url = $this->config->baseUrl . $path;
        if ($query !== []) {
            $url .= '?' . http_build_query($query);
        }

        $request = $this->requestFactory
            ->createRequest($method, $url)
            ->withHeader('Accept', 'application/json')
            ->withHeader('User-Agent', $this->config->userAgent);

        if ($body !== null) {
            try {
                $encoded = json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
            } catch (JsonException $e) {
                throw new ZettaPayException('zettapay: failed to encode request body: ' . $e->getMessage(), 0, $e);
            }
            $request = $request
                ->withHeader('Content-Type', 'application/json')
                ->withBody($this->streamFactory->createStream($encoded));
        }

        if ($this->config->apiKey !== null && $this->config->apiKey !== '') {
            $request = $request->withHeader('Authorization', 'Bearer ' . $this->config->apiKey);
        }

        foreach ($this->config->headers as $name => $value) {
            $request = $request->withHeader($name, $value);
        }
        foreach ($extraHeaders as $name => $value) {
            $request = $request->withHeader($name, $value);
        }
        return $request;
    }

    /**
     * @return array<string, mixed>
     */
    private function decodeResponse(ResponseInterface $response): array
    {
        $status = $response->getStatusCode();
        $raw = (string) $response->getBody();

        if ($status === 204 || $raw === '') {
            $decoded = [];
        } else {
            try {
                $decoded = json_decode($raw, true, flags: JSON_THROW_ON_ERROR);
            } catch (JsonException $e) {
                if ($status >= 200 && $status < 300) {
                    throw new ZettaPayException('zettapay: invalid JSON response: ' . $e->getMessage(), 0, $e);
                }
                $decoded = null;
            }
        }

        if ($status >= 200 && $status < 300) {
            return is_array($decoded) ? $decoded : [];
        }

        if (is_array($decoded) && isset($decoded['error']) && is_array($decoded['error'])) {
            $err = $decoded['error'];
            throw new ApiException(
                errorCode: (string) ($err['code'] ?? 'http_error'),
                message: (string) ($err['message'] ?? 'request failed'),
                statusCode: $status,
                details: $err['details'] ?? null,
            );
        }

        $message = $raw !== '' ? mb_substr($raw, 0, 200) : sprintf('request failed with status %d', $status);
        throw new ApiException(
            errorCode: 'http_error',
            message: $message,
            statusCode: $status,
        );
    }

    /**
     * Pass-through if the input already looks like base64 (decodable + ASCII
     * alphabet); otherwise base64-encode the raw bytes.
     */
    private function encodePayBody(string $transaction): string
    {
        $trimmed = trim($transaction);
        if ($trimmed === '') {
            return '';
        }
        if (preg_match('/^[A-Za-z0-9+\/]+={0,2}$/', $trimmed) === 1) {
            $decoded = base64_decode($trimmed, true);
            if ($decoded !== false) {
                return $trimmed;
            }
        }
        return base64_encode($transaction);
    }

    /**
     * @internal Used by resource classes to materialize lists.
     * @param array<string, mixed> $payload
     * @param callable(array<string, mixed>): object $factory
     * @return PaginatedList<object>
     */
    public function decodeList(array $payload, callable $factory): PaginatedList
    {
        $items = [];
        $rawItems = $payload['items'] ?? [];
        if (is_array($rawItems)) {
            foreach ($rawItems as $item) {
                if (is_array($item)) {
                    $items[] = $factory($item);
                }
            }
        }
        return new PaginatedList(
            items: $items,
            count: (int) ($payload['count'] ?? count($items)),
            total: isset($payload['total']) ? (int) $payload['total'] : null,
        );
    }
}
