<?php

declare(strict_types=1);

namespace ZettaPay\Model;

final class Merchant
{
    public function __construct(
        public readonly int $id,
        public readonly string $name,
        public readonly string $walletPubkey,
        public readonly string $usdcAta,
        public readonly int $createdAt,
    ) {
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        return new self(
            id: (int) ($data['id'] ?? 0),
            name: (string) ($data['name'] ?? ''),
            walletPubkey: (string) ($data['walletPubkey'] ?? $data['wallet_pubkey'] ?? ''),
            usdcAta: (string) ($data['usdcAta'] ?? $data['usdc_ata'] ?? ''),
            createdAt: (int) ($data['createdAt'] ?? $data['created_at'] ?? 0),
        );
    }
}
