<?php

declare(strict_types=1);

namespace ZettaPay\Tests;

use GuzzleHttp\Psr7\HttpFactory;
use GuzzleHttp\Psr7\Response;
use PHPUnit\Framework\TestCase;
use ZettaPay\Client;
use ZettaPay\ClientConfig;
use ZettaPay\Exception\ApiException;
use ZettaPay\Exception\NetworkException;
use ZettaPay\Exception\ZettaPayException;
use ZettaPay\RetryPolicy;
use ZettaPay\Tests\Fake\FakeHttpClient;
use ZettaPay\Tests\Fake\FakeNetworkException;

final class ClientTest extends TestCase
{
    private FakeHttpClient $http;

    private HttpFactory $factory;

    protected function setUp(): void
    {
        $this->http = new FakeHttpClient();
        $this->factory = new HttpFactory();
    }

    private function buildClient(?RetryPolicy $retry = null, ?string $apiKey = null): Client
    {
        $config = new ClientConfig(
            baseUrl: 'https://api.example.test',
            apiKey: $apiKey,
            httpClient: $this->http,
            requestFactory: $this->factory,
            streamFactory: $this->factory,
            retry: $retry ?? new RetryPolicy(maxAttempts: 3, initialBackoffMs: 1, maxBackoffMs: 5),
        );
        $client = new Client($config);
        $client->withRandomSource(static fn (): int => 0);
        $client->withSleeper(static function (int $micros): void {
        });
        return $client;
    }

    public function testConfigRejectsEmptyBaseUrl(): void
    {
        $this->expectException(ZettaPayException::class);
        new ClientConfig(baseUrl: '   ');
    }

    public function testConfigFactoryTrimsTrailingSlash(): void
    {
        $config = ClientConfig::create(baseUrl: 'https://api.example.test/', apiKey: 'k');
        self::assertSame('https://api.example.test', $config->baseUrl);
        self::assertSame('k', $config->apiKey);
    }

    public function testHealthDecodesResponse(): void
    {
        $this->http->enqueue(new Response(200, ['Content-Type' => 'application/json'], json_encode([
            'status' => 'ok',
            'merchants' => 3,
            'payments' => 7,
        ])));
        $client = $this->buildClient();

        $health = $client->health();
        self::assertSame('ok', $health->status);
        self::assertSame(3, $health->merchants);
        self::assertSame(7, $health->payments);

        $req = $this->http->requests[0];
        self::assertSame('GET', $req->getMethod());
        self::assertSame('/healthz', $req->getUri()->getPath());
        self::assertStringStartsWith('zettapay-php-sdk/', $req->getHeaderLine('User-Agent'));
    }

    public function testRegisterMerchantBuildsBodyAndAuthHeader(): void
    {
        $this->http->enqueue(new Response(201, [], json_encode([
            'id' => 42,
            'name' => 'Acme',
            'walletPubkey' => 'PUB',
            'usdcAta' => 'ATA',
            'createdAt' => 1700000000,
        ])));
        $client = $this->buildClient(apiKey: 'secret');

        $merchant = $client->merchants->register('Acme', 'PUB', 'ATA');
        self::assertSame(42, $merchant->id);
        self::assertSame('PUB', $merchant->walletPubkey);
        self::assertSame(1700000000, $merchant->createdAt);

        $req = $this->http->requests[0];
        self::assertSame('POST', $req->getMethod());
        self::assertSame('/merchants', $req->getUri()->getPath());
        self::assertSame('Bearer secret', $req->getHeaderLine('Authorization'));
        self::assertSame('application/json', $req->getHeaderLine('Content-Type'));
        $body = json_decode((string) $req->getBody(), true);
        self::assertSame([
            'name' => 'Acme',
            'wallet_pubkey' => 'PUB',
            'usdc_ata' => 'ATA',
        ], $body);
    }

    public function testRegisterMerchantValidatesEmptyFields(): void
    {
        $client = $this->buildClient();
        $this->expectException(ZettaPayException::class);
        $client->merchants->register('', 'p', 'u');
    }

    public function testListMerchantsBuildsQuery(): void
    {
        $this->http->enqueue(new Response(200, [], json_encode([
            'items' => [
                ['id' => 1, 'name' => 'a', 'walletPubkey' => 'p', 'usdcAta' => 'u', 'createdAt' => 1],
                ['id' => 2, 'name' => 'b', 'walletPubkey' => 'p2', 'usdcAta' => 'u2', 'createdAt' => 2],
            ],
            'count' => 2,
        ])));
        $client = $this->buildClient();

        $list = $client->merchants->list(limit: 5, offset: 10);
        self::assertCount(2, $list->items);
        self::assertSame(2, $list->count);
        self::assertSame(2, $list->items[1]->id);

        $req = $this->http->requests[0];
        parse_str($req->getUri()->getQuery(), $query);
        self::assertSame(['limit' => '5', 'offset' => '10'], $query);
    }

    public function testUpdateMerchantOmitsBlankFields(): void
    {
        $this->http->enqueue(new Response(200, [], json_encode([
            'id' => 7,
            'name' => 'newname',
            'walletPubkey' => 'p',
            'usdcAta' => 'u',
            'createdAt' => 1,
        ])));
        $client = $this->buildClient();

        $client->merchants->update(7, name: 'newname');
        $req = $this->http->requests[0];
        self::assertSame('PATCH', $req->getMethod());
        self::assertSame('/merchants/7', $req->getUri()->getPath());
        $body = json_decode((string) $req->getBody(), true);
        self::assertSame(['name' => 'newname'], $body);
    }

    public function testDeleteMerchantHandlesNoContent(): void
    {
        $this->http->enqueue(new Response(204));
        $client = $this->buildClient();

        $client->merchants->delete(7);
        $req = $this->http->requests[0];
        self::assertSame('DELETE', $req->getMethod());
        self::assertSame('/merchants/7', $req->getUri()->getPath());
    }

    public function testPaySendsX402HeaderWithBase64Passthrough(): void
    {
        $this->http->enqueue(new Response(200, [], json_encode([
            'accepted' => true,
            'paymentId' => 'pay_123',
            'feePayer' => 'FP',
            'signers' => ['FP'],
            'signatureCount' => 1,
            'recentBlockhash' => 'BH',
            'isVersioned' => false,
            'transactionBytes' => 64,
        ])));
        $client = $this->buildClient();

        $res = $client->pay('AAEC');
        self::assertTrue($res->accepted);
        self::assertSame('pay_123', $res->paymentId);

        $req = $this->http->requests[0];
        self::assertSame('POST', $req->getMethod());
        self::assertSame('/pay', $req->getUri()->getPath());
        self::assertSame('AAEC', $req->getHeaderLine(Client::X402_HEADER));
    }

    public function testPayEncodesRawBytes(): void
    {
        $this->http->enqueue(new Response(200, [], json_encode([
            'accepted' => true,
            'paymentId' => 'pay_x',
            'feePayer' => 'FP',
            'signers' => [],
            'signatureCount' => 0,
            'recentBlockhash' => '',
            'isVersioned' => false,
            'transactionBytes' => 1,
        ])));
        $client = $this->buildClient();

        $client->pay("\xff");
        $hdr = $this->http->requests[0]->getHeaderLine(Client::X402_HEADER);
        self::assertSame(base64_encode("\xff"), $hdr);
    }

    public function testPayRejectsEmptyTransaction(): void
    {
        $client = $this->buildClient();
        $this->expectException(ZettaPayException::class);
        $client->pay('');
    }

    public function testApiErrorEnvelopeIsParsed(): void
    {
        $this->http->enqueue(new Response(409, [], json_encode([
            'error' => [
                'code' => 'conflict',
                'message' => 'wallet already registered',
                'details' => ['field' => 'wallet'],
            ],
        ])));
        $client = $this->buildClient();

        try {
            $client->merchants->register('a', 'p', 'u');
            self::fail('expected ApiException');
        } catch (ApiException $e) {
            self::assertSame('conflict', $e->errorCode);
            self::assertSame(409, $e->statusCode);
            self::assertSame('wallet already registered', $e->getMessage());
            self::assertSame(['field' => 'wallet'], $e->details);
        }
    }

    public function testHttpErrorWithoutEnvelope(): void
    {
        $this->http->enqueue(new Response(404, [], 'not found'));
        $client = $this->buildClient();

        try {
            $client->merchants->get(1);
            self::fail('expected ApiException');
        } catch (ApiException $e) {
            self::assertSame(404, $e->statusCode);
            self::assertSame('http_error', $e->errorCode);
        }
    }

    public function testRetryOn5xxThenSucceeds(): void
    {
        $this->http->enqueue(new Response(503, [], json_encode([
            'error' => ['code' => 'upstream_error', 'message' => 'try again'],
        ])));
        $this->http->enqueue(new Response(503, [], json_encode([
            'error' => ['code' => 'upstream_error', 'message' => 'try again'],
        ])));
        $this->http->enqueue(new Response(200, [], json_encode([
            'status' => 'ok',
            'merchants' => 0,
            'payments' => 0,
        ])));
        $client = $this->buildClient();

        $health = $client->health();
        self::assertSame('ok', $health->status);
        self::assertCount(3, $this->http->requests);
    }

    public function testRetryGivesUpAfterMaxAttempts(): void
    {
        $this->http->enqueue(new Response(503, [], json_encode([
            'error' => ['code' => 'upstream_error', 'message' => 'down'],
        ])));
        $client = $this->buildClient();

        try {
            $client->health();
            self::fail('expected ApiException');
        } catch (ApiException $e) {
            self::assertSame('upstream_error', $e->errorCode);
        }
        self::assertCount(3, $this->http->requests);
    }

    public function testNonIdempotentPostNotRetried(): void
    {
        $this->http->enqueue(new Response(503, [], json_encode([
            'error' => ['code' => 'upstream_error', 'message' => 'down'],
        ])));
        $client = $this->buildClient();

        try {
            $client->merchants->register('a', 'p', 'u');
            self::fail('expected ApiException');
        } catch (ApiException $e) {
            self::assertSame(503, $e->statusCode);
        }
        self::assertCount(1, $this->http->requests, 'POST should not be retried');
    }

    public function testNoRetryOn4xx(): void
    {
        $this->http->enqueue(new Response(404, [], json_encode([
            'error' => ['code' => 'not_found', 'message' => 'missing'],
        ])));
        $client = $this->buildClient();

        try {
            $client->merchants->get(1);
            self::fail();
        } catch (ApiException $e) {
            self::assertSame('not_found', $e->errorCode);
        }
        self::assertCount(1, $this->http->requests);
    }

    public function testRetryOn429(): void
    {
        $this->http->enqueue(new Response(429, [], json_encode([
            'error' => ['code' => 'rate_limited', 'message' => 'slow'],
        ])));
        $this->http->enqueue(new Response(200, [], json_encode([
            'status' => 'ok', 'merchants' => 0, 'payments' => 0,
        ])));
        $client = $this->buildClient();

        $client->health();
        self::assertCount(2, $this->http->requests);
    }

    public function testNetworkExceptionWrappedAndRetryable(): void
    {
        $req = $this->factory->createRequest('GET', 'https://api.example.test/healthz');
        $this->http->enqueue(new FakeNetworkException($req));
        $this->http->enqueue(new Response(200, [], json_encode([
            'status' => 'ok', 'merchants' => 0, 'payments' => 0,
        ])));
        $client = $this->buildClient();

        $client->health();
        self::assertCount(2, $this->http->requests);
    }

    public function testNetworkErrorOnPostNotRetried(): void
    {
        $req = $this->factory->createRequest('POST', 'https://api.example.test/merchants');
        $this->http->enqueue(new FakeNetworkException($req, 'dns'));
        $client = $this->buildClient();

        $this->expectException(NetworkException::class);
        try {
            $client->merchants->register('a', 'p', 'u');
        } finally {
            self::assertCount(1, $this->http->requests);
        }
    }

    public function testGetPaymentEncodesPathSegment(): void
    {
        $this->http->enqueue(new Response(200, [], json_encode([
            'id' => 'pay/with space',
            'feePayer' => 'fp',
            'signers' => [],
            'signatures' => [],
            'recentBlockhash' => 'bh',
            'isVersioned' => false,
            'version' => null,
            'transactionBytes' => 32,
            'acceptedAt' => 1700000000,
        ])));
        $client = $this->buildClient();

        $payment = $client->payments->get('pay/with space');
        self::assertSame('pay/with space', $payment->id);

        $req = $this->http->requests[0];
        self::assertSame('/payments/pay%2Fwith%20space', $req->getUri()->getPath());
    }

    public function testListPaymentsDecodesEnvelope(): void
    {
        $this->http->enqueue(new Response(200, [], json_encode([
            'items' => [[
                'id' => 'p1',
                'feePayer' => 'fp',
                'signers' => [],
                'signatures' => [],
                'recentBlockhash' => 'bh',
                'isVersioned' => false,
                'version' => null,
                'transactionBytes' => 16,
                'acceptedAt' => 1,
            ]],
            'count' => 1,
            'total' => 1,
        ])));
        $client = $this->buildClient();

        $list = $client->payments->list(limit: 1);
        self::assertCount(1, $list->items);
        self::assertSame(1, $list->total);
    }

    public function testCustomHeadersForwarded(): void
    {
        $this->http->enqueue(new Response(200, [], json_encode([
            'status' => 'ok', 'merchants' => 0, 'payments' => 0,
        ])));
        $config = new ClientConfig(
            baseUrl: 'https://api.example.test',
            httpClient: $this->http,
            requestFactory: $this->factory,
            streamFactory: $this->factory,
            headers: ['X-Custom' => 'yes'],
        );
        $client = new Client($config);

        $client->health();
        self::assertSame('yes', $this->http->requests[0]->getHeaderLine('X-Custom'));
    }

    public function testFactoryCreate(): void
    {
        $client = Client::create(
            baseUrl: 'https://api.example.test/',
            apiKey: 'k',
            httpClient: $this->http,
            requestFactory: $this->factory,
            streamFactory: $this->factory,
        );
        self::assertSame('https://api.example.test', $client->config->baseUrl);
        self::assertSame('k', $client->config->apiKey);
    }
}
