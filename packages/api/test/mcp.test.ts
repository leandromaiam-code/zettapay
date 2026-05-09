import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  generateKeyPairSync,
  sign as cryptoSign,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { buildApp, type AppHandle } from '../src/app.js';
import { openDb } from '../src/db.js';
import { MCP_TOOLS } from '../src/routes/mcp.js';

interface Keypair {
  publicKey: Buffer;
  privateKey: KeyObject;
}

function makeKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { publicKey: spki.subarray(spki.length - 32), privateKey };
}

function compactU16(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  while (true) {
    if (v < 0x80) {
      out.push(v);
      break;
    }
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return Buffer.from(out);
}

function buildLegacyMessage(args: {
  numRequiredSignatures: number;
  numReadonlyUnsigned?: number;
  accountKeys: Buffer[];
  recentBlockhash: Buffer;
  programIdIndex: number;
  instructionAccountIndices?: number[];
  instructionData?: Buffer;
}): Buffer {
  const header = Buffer.from([
    args.numRequiredSignatures,
    0,
    args.numReadonlyUnsigned ?? 0,
  ]);
  const keysCount = compactU16(args.accountKeys.length);
  const keys = Buffer.concat(args.accountKeys);
  const accIdx = args.instructionAccountIndices ?? [];
  const data = args.instructionData ?? Buffer.alloc(0);
  const instruction = Buffer.concat([
    Buffer.from([args.programIdIndex]),
    compactU16(accIdx.length),
    Buffer.from(accIdx),
    compactU16(data.length),
    data,
  ]);
  return Buffer.concat([header, keysCount, keys, args.recentBlockhash, compactU16(1), instruction]);
}

function buildSignedTx(): Buffer {
  const signer = makeKeypair();
  const programId = randomBytes(32);
  const blockhash = randomBytes(32);
  const message = buildLegacyMessage({
    numRequiredSignatures: 1,
    numReadonlyUnsigned: 1,
    accountKeys: [signer.publicKey, programId],
    recentBlockhash: blockhash,
    programIdIndex: 1,
    instructionData: Buffer.from('zettapay-mcp', 'utf8'),
  });
  const sig = cryptoSign(null, message, signer.privateKey);
  return Buffer.concat([compactU16(1), sig, message]);
}

const VALID_WALLET = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT';
const VALID_USDC_ATA = 'So11111111111111111111111111111111111111112';

let handle: AppHandle;

function bootApp(): AppHandle {
  const db = openDb({ filename: ':memory:' });
  return buildApp({ db });
}

describe('GET /mcp', () => {
  beforeEach(() => {
    handle = bootApp();
  });
  afterEach(() => {
    handle.db.close();
  });

  it('returns server info and tool catalog', async () => {
    const res = await request(handle.app).get('/mcp');
    expect(res.status).toBe(200);
    expect(res.body.protocolVersion).toBe('2024-11-05');
    expect(res.body.serverInfo).toEqual({ name: 'zettapay-mcp', version: '0.1.0' });
    expect(Array.isArray(res.body.tools)).toBe(true);
    const names = res.body.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(['pay', 'get_merchant', 'list_payments']);
    for (const tool of res.body.tools) {
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

describe('POST /mcp — JSON-RPC 2.0', () => {
  beforeEach(() => {
    handle = bootApp();
  });
  afterEach(() => {
    handle.db.close();
  });

  it('initialize returns protocol version and capabilities', async () => {
    const res = await request(handle.app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.id).toBe(1);
    expect(res.body.result.protocolVersion).toBe('2024-11-05');
    expect(res.body.result.capabilities.tools).toBeDefined();
    expect(res.body.result.serverInfo.name).toBe('zettapay-mcp');
  });

  it('tools/list returns the three tools with input_schema', async () => {
    const res = await request(handle.app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 'a', method: 'tools/list' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('a');
    const tools = res.body.result.tools as Array<{ name: string; inputSchema: { required?: string[] } }>;
    expect(tools.map((t) => t.name)).toEqual(['pay', 'get_merchant', 'list_payments']);
    const pay = tools.find((t) => t.name === 'pay');
    expect(pay?.inputSchema.required).toEqual(['payment']);
    const merch = tools.find((t) => t.name === 'get_merchant');
    expect(merch?.inputSchema.required).toEqual(['id']);
  });

  it('exposes the same tool catalog statically', () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual(['pay', 'get_merchant', 'list_payments']);
  });

  it('returns method_not_found for unknown methods', async () => {
    const res = await request(handle.app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 9, method: 'tools/wat' });
    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32601);
  });

  it('rejects non-2.0 jsonrpc version', async () => {
    const res = await request(handle.app)
      .post('/mcp')
      .send({ jsonrpc: '1.0', id: 1, method: 'initialize' });
    expect(res.body.error.code).toBe(-32600);
  });

  it('handles notifications (no id) with 204', async () => {
    const res = await request(handle.app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(204);
  });

  it('tools/call pay accepts a valid x402 transaction and records it', async () => {
    const tx = buildSignedTx();
    const res = await request(handle.app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'pay', arguments: { payment: tx.toString('base64') } },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeUndefined();
    const text = res.body.result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.accepted).toBe(true);
    expect(parsed.signatureCount).toBe(1);
    expect(parsed.transactionBytes).toBe(tx.length);
    expect(typeof parsed.paymentId).toBe('string');

    const list = await request(handle.app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_payments', arguments: {} },
      });
    const listed = JSON.parse(list.body.result.content[0].text);
    expect(listed.count).toBe(1);
    expect(listed.items[0].paymentId ?? listed.items[0].id).toBe(parsed.paymentId);
  });

  it('tools/call pay returns isError on invalid payment', async () => {
    const res = await request(handle.app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'pay', arguments: { payment: '@@not-base64@@' } },
      });
    expect(res.body.result.isError).toBe(true);
    const err = JSON.parse(res.body.result.content[0].text);
    expect(err.error.code).toBe('invalid_encoding');
  });

  it('tools/call pay rejects missing argument', async () => {
    const res = await request(handle.app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'pay', arguments: {} },
      });
    expect(res.body.result.isError).toBe(true);
    const err = JSON.parse(res.body.result.content[0].text);
    expect(err.error.code).toBe('invalid_arguments');
  });

  it('tools/call get_merchant returns merchant when present', async () => {
    const created = await request(handle.app).post('/merchants').send({
      name: 'Acme',
      wallet_pubkey: VALID_WALLET,
      usdc_ata: VALID_USDC_ATA,
    });
    const res = await request(handle.app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_merchant', arguments: { id: created.body.id } },
      });
    expect(res.body.result.isError).toBeUndefined();
    const merchant = JSON.parse(res.body.result.content[0].text);
    expect(merchant.id).toBe(created.body.id);
    expect(merchant.name).toBe('Acme');
    expect(merchant.walletPubkey).toBe(VALID_WALLET);
  });

  it('tools/call get_merchant returns isError when not found', async () => {
    const res = await request(handle.app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_merchant', arguments: { id: 9999 } },
      });
    expect(res.body.result.isError).toBe(true);
    const err = JSON.parse(res.body.result.content[0].text);
    expect(err.error.code).toBe('not_found');
  });

  it('tools/call get_merchant rejects non-integer id', async () => {
    const res = await request(handle.app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_merchant', arguments: { id: 'abc' } },
      });
    expect(res.body.result.isError).toBe(true);
    const err = JSON.parse(res.body.result.content[0].text);
    expect(err.error.code).toBe('invalid_arguments');
  });

  it('tools/call list_payments returns empty list initially', async () => {
    const res = await request(handle.app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_payments', arguments: {} },
      });
    const parsed = JSON.parse(res.body.result.content[0].text);
    expect(parsed).toEqual({ items: [], count: 0 });
  });

  it('tools/call list_payments validates limit range', async () => {
    const res = await request(handle.app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_payments', arguments: { limit: 999 } },
      });
    expect(res.body.result.isError).toBe(true);
  });

  it('tools/call returns method_not_found for unknown tool', async () => {
    const res = await request(handle.app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'evil_tool', arguments: {} },
      });
    expect(res.body.error.code).toBe(-32601);
  });

  it('handles batch requests', async () => {
    const res = await request(handle.app)
      .post('/mcp')
      .send([
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ]);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].id).toBe(1);
    expect(res.body[1].result.tools.length).toBe(3);
  });
});
