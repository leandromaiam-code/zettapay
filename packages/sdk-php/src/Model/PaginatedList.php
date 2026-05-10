<?php

declare(strict_types=1);

namespace ZettaPay\Model;

/**
 * @template T of object
 */
final class PaginatedList
{
    /**
     * @param list<T> $items
     */
    public function __construct(
        public readonly array $items,
        public readonly int $count,
        public readonly ?int $total = null,
    ) {
    }
}
