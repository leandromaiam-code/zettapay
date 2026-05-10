<?php

declare(strict_types=1);

namespace ZettaPay\Model;

final class Payment
{
    /**
     * @param list<string> $signers
     * @param list<string> $signatures
     */
    public function __construct(
        public readonly string $id,
        public readonly string $feePayer,
        public readonly array $signers,
        public readonly array $signatures,
        public readonly string $recentBlockhash,
        public readonly bool $isVersioned,
        public readonly ?int $version,
        public readonly int $transactionBytes,
        public readonly int $acceptedAt,
    ) {
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        $signers = $data['signers'] ?? [];
        $signatures = $data['signatures'] ?? [];

        return new self(
            id: (string) ($data['id'] ?? ''),
            feePayer: (string) ($data['feePayer'] ?? $data['fee_payer'] ?? ''),
            signers: is_array($signers) ? array_values(array_map('strval', $signers)) : [],
            signatures: is_array($signatures) ? array_values(array_map('strval', $signatures)) : [],
            recentBlockhash: (string) ($data['recentBlockhash'] ?? $data['recent_blockhash'] ?? ''),
            isVersioned: (bool) ($data['isVersioned'] ?? $data['is_versioned'] ?? false),
            version: isset($data['version']) ? (int) $data['version'] : null,
            transactionBytes: (int) ($data['transactionBytes'] ?? $data['transaction_bytes'] ?? 0),
            acceptedAt: (int) ($data['acceptedAt'] ?? $data['accepted_at'] ?? 0),
        );
    }
}
