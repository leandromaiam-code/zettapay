<?php

declare(strict_types=1);

namespace ZettaPay\Resource;

use ZettaPay\Client;
use ZettaPay\Exception\ZettaPayException;
use ZettaPay\Model\Merchant;
use ZettaPay\Model\PaginatedList;

/**
 * /merchants resource.
 */
final class Merchants
{
    public function __construct(private readonly Client $client)
    {
    }

    public function register(string $name, string $walletPubkey, string $usdcAta): Merchant
    {
        $name = trim($name);
        $walletPubkey = trim($walletPubkey);
        $usdcAta = trim($usdcAta);
        if ($name === '') {
            throw new ZettaPayException('zettapay: register: name is required');
        }
        if ($walletPubkey === '') {
            throw new ZettaPayException('zettapay: register: walletPubkey is required');
        }
        if ($usdcAta === '') {
            throw new ZettaPayException('zettapay: register: usdcAta is required');
        }

        $payload = $this->client->request(
            method: 'POST',
            path: '/merchants',
            body: [
                'name' => $name,
                'wallet_pubkey' => $walletPubkey,
                'usdc_ata' => $usdcAta,
            ],
            retryable: false,
        );
        return Merchant::fromArray($payload);
    }

    public function get(int $id): Merchant
    {
        $payload = $this->client->request(
            method: 'GET',
            path: '/merchants/' . $id,
            retryable: true,
        );
        return Merchant::fromArray($payload);
    }

    /**
     * @return PaginatedList<Merchant>
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
            path: '/merchants',
            query: $query,
            retryable: true,
        );
        /** @var PaginatedList<Merchant> $list */
        $list = $this->client->decodeList(
            $payload,
            static fn (array $item): Merchant => Merchant::fromArray($item),
        );
        return $list;
    }

    public function update(int $id, ?string $name = null, ?string $walletPubkey = null, ?string $usdcAta = null): Merchant
    {
        $body = [];
        if ($name !== null && $name !== '') {
            $body['name'] = $name;
        }
        if ($walletPubkey !== null && $walletPubkey !== '') {
            $body['wallet_pubkey'] = $walletPubkey;
        }
        if ($usdcAta !== null && $usdcAta !== '') {
            $body['usdc_ata'] = $usdcAta;
        }
        if ($body === []) {
            throw new ZettaPayException('zettapay: update: at least one field is required');
        }

        $payload = $this->client->request(
            method: 'PATCH',
            path: '/merchants/' . $id,
            body: $body,
            retryable: false,
        );
        return Merchant::fromArray($payload);
    }

    public function delete(int $id): void
    {
        $this->client->request(
            method: 'DELETE',
            path: '/merchants/' . $id,
            retryable: true,
        );
    }
}
