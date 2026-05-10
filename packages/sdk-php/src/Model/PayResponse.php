<?php

declare(strict_types=1);

namespace ZettaPay\Model;

final class PayResponse
{
    /**
     * @param list<string> $signers
     */
    public function __construct(
        public readonly bool $accepted,
        public readonly string $paymentId,
        public readonly string $feePayer,
        public readonly array $signers,
        public readonly int $signatureCount,
        public readonly string $recentBlockhash,
        public readonly bool $isVersioned,
        public readonly ?int $version,
        public readonly int $transactionBytes,
    ) {
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        $signers = $data['signers'] ?? [];

        return new self(
            accepted: (bool) ($data['accepted'] ?? false),
            paymentId: (string) ($data['paymentId'] ?? $data['payment_id'] ?? ''),
            feePayer: (string) ($data['feePayer'] ?? $data['fee_payer'] ?? ''),
            signers: is_array($signers) ? array_values(array_map('strval', $signers)) : [],
            signatureCount: (int) ($data['signatureCount'] ?? $data['signature_count'] ?? 0),
            recentBlockhash: (string) ($data['recentBlockhash'] ?? $data['recent_blockhash'] ?? ''),
            isVersioned: (bool) ($data['isVersioned'] ?? $data['is_versioned'] ?? false),
            version: isset($data['version']) ? (int) $data['version'] : null,
            transactionBytes: (int) ($data['transactionBytes'] ?? $data['transaction_bytes'] ?? 0),
        );
    }
}
