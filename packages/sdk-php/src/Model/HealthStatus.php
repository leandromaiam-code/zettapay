<?php

declare(strict_types=1);

namespace ZettaPay\Model;

final class HealthStatus
{
    public function __construct(
        public readonly string $status,
        public readonly int $merchants,
        public readonly int $payments,
    ) {
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        return new self(
            status: (string) ($data['status'] ?? ''),
            merchants: (int) ($data['merchants'] ?? 0),
            payments: (int) ($data['payments'] ?? 0),
        );
    }
}
