// Z62 — install acceptance: simulate the full self-hosted listener lifecycle
// end-to-end, offline. No mempool.space, no merchant.example.test HTTP calls,
// no `zettapay-listener` subprocess. Every external surface (BTC WS, merchant
// webhook receiver) is replaced by an in-process mock so this suite can run
// hermetically on every CI worker.
//
// Steps covered:
//   1. CLI-equivalent init: seed merchant.json + .env via runInit() into a
//      tmp dataDir with the BIP-84 test vector zpub. Assert next_child_index=0.
//   2. Storage: create an invoice with a known BIP-84 child address (re-derived
//      below from the same zpub via @scure/bip32) and assert the derivation
//      matches what we would have gotten offline.
//   3. Watcher: hand-tick BtcListener.processTx() with a synthetic confirmed
//      tx for the invoice address; assert the invoice flips to "confirmed"
//      AND a webhook_event row is written to storage.
//   4. Dispatch: run WebhookDispatcher.tick() against a local node:http server
//      that captures the request; assert X-ZettaPay-Signature is the correct
//      HMAC-SHA256 over the raw body using the secret produced by init.
//   5. Health: HealthServer responds 200 on /health with the snapshot shape.

import { createHash, createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { base58check, bech32 } from '@scure/base';
import { ripemd160 } from '@noble/hashes/ripemd160.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { runInit } from '../src/cli/init.js';
import { parseEnv, type Prompter } from '../src/cli/util.js';
import { JsonFileStorage } from '../src/storage/json.js';
import { BtcListener } from '../src/listener.js';
import { WebhookDispatcher } from '../src/webhook-dispatcher.js';
import { HealthServer } from '../src/health-server.js';

// BIP-84 well-known mainnet test vector. zpub at account m/84'/0'/0' derived
// from the "abandon × 11 + about" mnemonic. Identical to the vector used by
// /api/test/acceptance/btc-payment so the offline / online surfaces stay in
// lockstep. Never holds funds — used purely for deterministic derivation.
const TEST_ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

const tmpdirs: string[] = [];
async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpdirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tmpdirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

class NoopPrompter implements Prompter {
  async ask(): Promise<string> {
    throw new Error('unexpected prompt — non-interactive expected');
  }
  async confirm(): Promise<boolean> {
    throw new Error('unexpected confirm — non-interactive expected');
  }
  close(): void {}
}

// ----- BIP-84 derivation helper (mirrors packages/sdk/src/derive-bip84) -----
// The listener package intentionally does NOT depend on the SDK, so we redo
// the minimal slice needed for the test (re-encode zpub → xpub for HDKey,
// then derive m/0/{index} as P2WPKH bech32). The point of this test is to
// catch any regression where the listener and the SDK derivation drift.

const VERSION_ZPUB = 0x04b24746;
const VERSION_XPUB = 0x0488b21e;
const sha256x2 = base58check(sha256);

function deriveBip84(zpub: string, index: number): string {
  const decoded = sha256x2.decode(zpub);
  if (decoded.length !== 78) throw new Error('bad extended key length');
  const version =
    ((decoded[0] as number) << 24) |
    ((decoded[1] as number) << 16) |
    ((decoded[2] as number) << 8) |
    (decoded[3] as number);
  // Re-encode to xpub so @scure/bip32 (BIP-32 only) accepts it.
  const canonical = new Uint8Array(decoded);
  const target = version === VERSION_ZPUB ? VERSION_XPUB : version;
  canonical[0] = (target >>> 24) & 0xff;
  canonical[1] = (target >>> 16) & 0xff;
  canonical[2] = (target >>> 8) & 0xff;
  canonical[3] = target & 0xff;
  const hdkey = HDKey.fromExtendedKey(sha256x2.encode(canonical));
  const child = hdkey.derive(`m/0/${index}`);
  if (!child.publicKey) throw new Error('missing publicKey');
  const program = ripemd160(sha256(child.publicKey));
  return bech32.encode('bc', [0, ...bech32.toWords(program)]);
}

// Wait for a condition to become true. Polls cheaply — used to give the
// dispatcher's setTimeout-driven scheduler a chance to fire without sleeping
// a fixed amount.
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

describe('Z62: install acceptance — full self-hosted lifecycle offline', () => {
  it('runs init → invoice → detect → webhook → health end-to-end', async () => {
    // ----- (1) init: seed merchant.json + .env in a temp cwd -------------------
    const cwd = await makeTmpDir('zp-z62-cwd-');
    const dataDir = await makeTmpDir('zp-z62-data-');

    const initCode = await runInit(
      [
        '--xpub', TEST_ZPUB,
        '--shop-name', 'Z62 Acceptance Shop',
        '--email', 'z62@acceptance.test',
        '--webhook-url', 'https://merchant.example.test/zp/hook',
        '--storage', 'json',
        '--data-dir', dataDir,
      ],
      { cwd, prompter: new NoopPrompter() },
    );
    expect(initCode).toBe(0);

    const env = parseEnv(await fs.readFile(path.join(cwd, '.env'), 'utf8'));
    expect(env.STORAGE).toBe('json');
    expect(env.MERCHANT_XPUB).toBe(TEST_ZPUB);
    expect(env.MERCHANT_WEBHOOK_SECRET?.startsWith('whsec_')).toBe(true);

    const merchant = JSON.parse(await fs.readFile(path.join(dataDir, 'merchant.json'), 'utf8'));
    expect(merchant.next_child_index).toBe(0);
    expect(merchant.xpub).toBe(TEST_ZPUB);
    // raw secret MUST NOT be on disk — only its sha256
    const secret = env.MERCHANT_WEBHOOK_SECRET!;
    expect(merchant.webhook_secret_hash).toBe(createHash('sha256').update(secret).digest('hex'));

    // ----- (2) derive a receive address offline and create an invoice ---------
    const childIndex = 0;
    const offlineAddress = deriveBip84(TEST_ZPUB, childIndex);
    // Sanity: the well-known vector's m/0/0 is a stable address — this
    // literal locks the BIP-32 path the listener/SDK pair derives so a
    // future refactor that quietly changes derivation can't slip through.
    expect(offlineAddress).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');

    const storage = new JsonFileStorage({ dataDir });
    const invoice = await storage.createInvoice({
      id: 'inv_z62_001',
      merchant_id: merchant.id,
      chain: 'btc',
      asset: 'BTC',
      amount: '0.00010000',
      address: offlineAddress,
      child_index: childIndex,
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    expect(invoice.address).toBe(offlineAddress);
    // Re-derive a SECOND time to assert determinism (Z45 invariant).
    expect(deriveBip84(TEST_ZPUB, childIndex)).toBe(invoice.address);

    // ----- (3) inject a synthetic confirmed tx into BtcListener -------------
    // No mempool.space WS, no fetch. We poke processTx() directly so the watcher
    // walks its real state machine.
    const listener = new BtcListener({
      storage,
      merchantId: merchant.id,
      requiredConfirmations: () => 1,
    });
    // Hydrate the in-memory address → invoice map (normally populated by
    // reconcileSubscriptions when the WS connects).
    (listener as unknown as { addressToInvoiceId: Map<string, string> }).addressToInvoiceId.set(
      invoice.address,
      invoice.id,
    );
    (listener as unknown as { lastBlockHeight: number }).lastBlockHeight = 850_000;

    await (listener as unknown as {
      processTx: (addr: string, tx: unknown) => Promise<void>;
    }).processTx(invoice.address, {
      txid: 'd'.repeat(64),
      status: { confirmed: true, block_height: 850_000 },
    });

    const confirmed = await storage.getInvoice(invoice.id);
    expect(confirmed?.status).toBe('confirmed');
    expect(confirmed?.tx_hash).toBe('d'.repeat(64));
    expect(confirmed?.paid_at).not.toBeNull();

    // A webhook_event row should be queued and due immediately (initial delay 1s).
    const dueSoon = await storage.getWebhookEventsDue(new Date(Date.now() + 5_000), 10);
    expect(dueSoon.length).toBe(1);
    expect(dueSoon[0]!.invoice_id).toBe(invoice.id);
    const queued = dueSoon[0]!;
    const payload = JSON.parse(queued.payload_json) as { event: string; invoice_id: string };
    expect(payload.event).toBe('invoice.confirmed');
    expect(payload.invoice_id).toBe(invoice.id);

    // ----- (4) dispatch the webhook to a local mock server + verify HMAC ----
    type Capture = { headers: Record<string, string>; body: string };
    const captured: Capture[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : (v ?? '');
        }
        captured.push({ headers, body });
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    // The dispatcher refuses non-https URLs at construction. We satisfy that
    // by passing https://… for the constructor, then routing the actual POST
    // through a fetchImpl that rewrites to http://127.0.0.1:<port>.
    const webhookUrl = `https://merchant.example.test:${port}/zp/hook`;
    const fakeFetch: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const httpUrl = `http://127.0.0.1:${port}/zp/hook`;
      return await fetch(httpUrl, init);
    }) as unknown as typeof fetch;

    const dispatcher = new WebhookDispatcher({
      storage,
      webhookUrl,
      webhookSecret: secret,
      fetchImpl: fakeFetch,
      pollIntervalMs: 50,
    });
    try {
      // emitConfirmedWebhook parks next_retry_at = now + 1s, so we let the
      // scheduler poll until the event is due (≤ 3s window covers the 1s
      // delay + jitter).
      dispatcher.start();
      await waitFor(() => captured.length === 1, 3000);
    } finally {
      await dispatcher.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(captured).toHaveLength(1);
    const got = captured[0]!;
    expect(got.body).toBe(queued.payload_json);
    const expectedSig = createHmac('sha256', secret).update(got.body).digest('hex');
    // Headers come in lowercased by node:http — dispatcher writes X-ZettaPay-* casing
    expect(got.headers['x-zettapay-signature']).toBe(expectedSig);
    expect(got.headers['x-zettapay-event-id']).toBe(queued.id);
    expect(got.headers['x-zettapay-attempt']).toBe('1');
    expect(got.headers['x-zettapay-timestamp']).toMatch(/^\d+$/);

    // After successful delivery, the event must no longer be due.
    const stillDue = await storage.getWebhookEventsDue(new Date(Date.now() + 60_000), 10);
    expect(stillDue.find((e) => e.id === queued.id)).toBeUndefined();

    // ----- (5) /health responds 200 with snapshot shape ---------------------
    const healthPort = 18900 + Math.floor(Math.random() * 1000);
    const health = new HealthServer({
      port: healthPort,
      host: '127.0.0.1',
      statusProvider: () => listener.status(),
    });
    try {
      await health.start();
      const res = await fetch(`http://127.0.0.1:${healthPort}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        ok: false, // ws was never connected — that's expected and correct
        ws_connected: false,
        subscribed_count: 0,
      });
      expect(typeof body.uptime_s).toBe('number');
    } finally {
      await health.stop();
    }
  });
});
