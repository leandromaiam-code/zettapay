<?php

declare(strict_types=1);

namespace ZettaPay\Tests\Fake;

use Psr\Http\Client\ClientExceptionInterface;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

/**
 * Minimal PSR-18 stub. Records every request and replays a queue of canned
 * responses or exceptions in order. When the queue is empty the last entry is
 * reused so retry tests can assert "always the same failure".
 */
final class FakeHttpClient implements ClientInterface
{
    /** @var list<RequestInterface> */
    public array $requests = [];

    /** @var list<ResponseInterface|ClientExceptionInterface> */
    private array $queue = [];

    public function enqueue(ResponseInterface|ClientExceptionInterface $next): void
    {
        $this->queue[] = $next;
    }

    public function sendRequest(RequestInterface $request): ResponseInterface
    {
        $this->requests[] = $request;
        if ($this->queue === []) {
            throw new \LogicException('FakeHttpClient: no canned response queued');
        }
        $next = count($this->queue) > 1 ? array_shift($this->queue) : $this->queue[0];
        if ($next instanceof ClientExceptionInterface) {
            throw $next;
        }
        return $next;
    }
}
