<?php

declare(strict_types=1);

namespace ZettaPay\Resource;

use ZettaPay\Client;
use ZettaPay\Exception\ZettaPayException;
use ZettaPay\Model\PaginatedList;
use ZettaPay\Model\Payment;

/**
 * /payments resource.
 */
final class Payments
{
    public function __construct(private readonly Client $client)
    {
    }

    public function get(string $id): Payment
    {
        $id = trim($id);
        if ($id === '') {
            throw new ZettaPayException('zettapay: get: id is required');
        }
        $payload = $this->client->request(
            method: 'GET',
            path: '/payments/' . rawurlencode($id),
            retryable: true,
        );
        return Payment::fromArray($payload);
    }

    /**
     * @return PaginatedList<Payment>
     */
    public function list(int $limit = 0, int $offset = 0): PaginatedList
    {
        $query = [];
        if ($limit > 0) {
            $query['limit'] = $limit;
        }
        if ($offset > 0) {
            $query['offset'] = $offset;
        }
        $payload = $this->client->request(
            method: 'GET',
            path: '/payments',
            query: $query,
            retryable: true,
        );
        /** @var PaginatedList<Payment> $list */
        $list = $this->client->decodeList(
            $payload,
            static fn (array $item): Payment => Payment::fromArray($item),
        );
        return $list;
    }
}
