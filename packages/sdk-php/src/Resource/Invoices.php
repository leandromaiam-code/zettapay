<?php

declare(strict_types=1);

namespace ZettaPay\Resource;

use ZettaPay\Client;
use ZettaPay\Exception\ZettaPayException;
use ZettaPay\Model\Invoice;

/**
 * /api/invoices resource — multi-chain invoice CRUD (Z52).
 */
final class Invoices
{
    public function __construct(private readonly Client $client)
    {
    }

    /**
     * Create an invoice. `chain` is required and must be one of
     * btc | base | polygon | ethereum. The server rejects 'solana' with 400.
     *
     * @param array<string, mixed>|null $metadata
     */
    public function create(
        float $amountUsd,
        string $chain,
        ?string $merchantId = null,
        ?int $ttlSeconds = null,
        ?array $metadata = null,
    ): Invoice {
        if ($amountUsd <= 0.0) {
            throw new ZettaPayException('zettapay: invoices.create: amount_usd must be positive');
        }
        if (!Invoice::isSupportedChain($chain)) {
            throw new ZettaPayException(sprintf(
                "zettapay: invoices.create: chain must be one of %s (got '%s')",
                implode(', ', Invoice::SUPPORTED_CHAINS),
                $chain,
            ));
        }
        $body = [
            'amount_usd' => $amountUsd,
            'chain' => $chain,
        ];
        if ($merchantId !== null) {
            $body['merchant_id'] = $merchantId;
        }
        if ($ttlSeconds !== null) {
            $body['ttl_seconds'] = $ttlSeconds;
        }
        if ($metadata !== null) {
            $body['metadata'] = $metadata;
        }

        $payload = $this->client->request(
            method: 'POST',
            path: '/api/invoices',
            body: $body,
            retryable: false,
        );

        return Invoice::fromArray($payload);
    }

    public function get(string $invoiceId): Invoice
    {
        $invoiceId = trim($invoiceId);
        if ($invoiceId === '') {
            throw new ZettaPayException('zettapay: invoices.get: invoiceId is required');
        }
        $payload = $this->client->request(
            method: 'GET',
            path: '/api/invoices/' . rawurlencode($invoiceId),
            retryable: true,
        );
        return Invoice::fromArray($payload);
    }
}
