<?php

declare(strict_types=1);

namespace ZettaPay\Tests;

use GuzzleHttp\Psr7\HttpFactory;
use GuzzleHttp\Psr7\Response;
use PHPUnit\Framework\TestCase;
use ZettaPay\Client;
use ZettaPay\ClientConfig;
use ZettaPay\Exception\ZettaPayException;
use ZettaPay\Model\Invoice;
use ZettaPay\Tests\Fake\FakeHttpClient;

final class InvoicesTest extends TestCase
{
    private FakeHttpClient $http;

    private HttpFactory $factory;

    protected function setUp(): void
    {
        $this->http = new FakeHttpClient();
        $this->factory = new HttpFactory();
    }

    private function buildClient(): Client
    {
        $config = new ClientConfig(
            baseUrl: 'https://api.example.test',
            httpClient: $this->http,
            requestFactory: $this->factory,
            streamFactory: $this->factory,
        );
        return new Client($config);
    }

    /**
     * @return array<string, mixed>
     */
    private function invoiceBody(string $chain): array
    {
        return [
            'invoice_id' => 'inv_abc',
            'chain' => $chain,
            'receive_address' => $chain === 'btc' ? 'bc1qexample' : '0xExample',
            'amount_usd' => 29,
            'amount_native' => $chain === 'btc' ? '0.00045' : '29.00',
            'qr_uri' => $chain . ':address?amount=29',
            'expires_at' => 1_700_000_000,
            'status' => 'pending',
            'verify_url' => 'https://explorer.example/tx/abc',
            'metadata' => ['order_id' => 'xyz'],
        ];
    }

    public function testSupportedChainsEnumerates4(): void
    {
        self::assertSame(
            ['btc', 'base', 'polygon', 'ethereum'],
            Invoice::SUPPORTED_CHAINS,
        );
    }

    public function testIsSupportedChain(): void
    {
        self::assertTrue(Invoice::isSupportedChain('btc'));
        self::assertTrue(Invoice::isSupportedChain('base'));
        self::assertFalse(Invoice::isSupportedChain('solana'));
        self::assertFalse(Invoice::isSupportedChain('BTC'));
        self::assertFalse(Invoice::isSupportedChain(42));
    }

    public function testNormalizeWebhookChainFallsBackToUnknown(): void
    {
        self::assertSame('unknown', Invoice::normalizeWebhookChain(null));
        self::assertSame('unknown', Invoice::normalizeWebhookChain('solana'));
        self::assertSame('btc', Invoice::normalizeWebhookChain('btc'));
    }

    public function testCreatePostsChainAndAmount(): void
    {
        $this->http->enqueue(new Response(
            200,
            ['Content-Type' => 'application/json'],
            json_encode($this->invoiceBody('base'), JSON_THROW_ON_ERROR),
        ));

        $client = $this->buildClient();
        $invoice = $client->invoices->create(
            amountUsd: 29,
            chain: 'base',
            metadata: ['order_id' => 'xyz'],
        );

        self::assertSame('base', $invoice->chain);
        self::assertSame('0xExample', $invoice->receiveAddress);

        $req = $this->http->requests[0];
        self::assertSame('POST', $req->getMethod());
        self::assertSame('/api/invoices', $req->getUri()->getPath());
        $body = json_decode((string) $req->getBody(), true);
        self::assertSame([
            'amount_usd' => 29,
            'chain' => 'base',
            'metadata' => ['order_id' => 'xyz'],
        ], $body);
    }

    public function testCreateRejectsUnknownChainClientSide(): void
    {
        $client = $this->buildClient();
        $this->expectException(ZettaPayException::class);
        $this->expectExceptionMessageMatches('/chain must be one of/');
        $client->invoices->create(amountUsd: 10, chain: 'solana');
        self::assertCount(0, $this->http->requests);
    }

    public function testCreateRejectsNonPositiveAmount(): void
    {
        $client = $this->buildClient();
        $this->expectException(ZettaPayException::class);
        $client->invoices->create(amountUsd: 0, chain: 'base');
    }

    public function testInvoiceFromArrayLegacyMissingChain(): void
    {
        $invoice = Invoice::fromArray([
            'invoice_id' => 'inv_legacy',
            'receive_address' => '0xMerchant',
            'amount_usd' => 29,
            'amount_native' => '29.00',
            'qr_uri' => '',
            'expires_at' => 0,
            'status' => 'pending',
            'verify_url' => '',
        ]);
        self::assertSame('unknown', $invoice->chain);
    }
}
