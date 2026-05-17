<?php

declare(strict_types=1);

namespace ZettaPay\Model;

/**
 * Multi-chain invoice (Z52). `$chain` is one of:
 * - btc | base | polygon | ethereum (the four chains ZettaPay watches)
 * - unknown — only used for legacy invoices that pre-date Z52
 */
final class Invoice
{
    public const CHAIN_BTC = 'btc';

    public const CHAIN_BASE = 'base';

    public const CHAIN_POLYGON = 'polygon';

    public const CHAIN_ETHEREUM = 'ethereum';

    public const CHAIN_UNKNOWN = 'unknown';

    public const SUPPORTED_CHAINS = [
        self::CHAIN_BTC,
        self::CHAIN_BASE,
        self::CHAIN_POLYGON,
        self::CHAIN_ETHEREUM,
    ];

    /**
     * @param array<string, mixed>|null $metadata
     */
    public function __construct(
        public readonly string $invoiceId,
        public readonly string $chain,
        public readonly string $receiveAddress,
        public readonly float $amountUsd,
        public readonly string $amountNative,
        public readonly string $qrUri,
        public readonly int $expiresAt,
        public readonly string $status,
        public readonly string $verifyUrl,
        public readonly ?string $merchantId = null,
        public readonly ?array $metadata = null,
    ) {
    }

    public static function isSupportedChain(mixed $value): bool
    {
        return is_string($value) && in_array($value, self::SUPPORTED_CHAINS, true);
    }

    public static function normalizeWebhookChain(mixed $value): string
    {
        return self::isSupportedChain($value) ? (string) $value : self::CHAIN_UNKNOWN;
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        $metadata = $data['metadata'] ?? null;

        return new self(
            invoiceId: (string) ($data['invoice_id'] ?? $data['invoiceId'] ?? ''),
            chain: self::normalizeWebhookChain($data['chain'] ?? null),
            receiveAddress: (string) ($data['receive_address'] ?? $data['receiveAddress'] ?? ''),
            amountUsd: (float) ($data['amount_usd'] ?? $data['amountUsd'] ?? 0),
            amountNative: (string) ($data['amount_native'] ?? $data['amountNative'] ?? ''),
            qrUri: (string) ($data['qr_uri'] ?? $data['qrUri'] ?? ''),
            expiresAt: (int) ($data['expires_at'] ?? $data['expiresAt'] ?? 0),
            status: (string) ($data['status'] ?? 'pending'),
            verifyUrl: (string) ($data['verify_url'] ?? $data['verifyUrl'] ?? ''),
            merchantId: isset($data['merchant_id']) ? (string) $data['merchant_id']
                : (isset($data['merchantId']) ? (string) $data['merchantId'] : null),
            metadata: is_array($metadata) ? $metadata : null,
        );
    }
}
