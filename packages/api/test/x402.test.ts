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
import {
  X402_HEADER,
  X402ValidationError,
  parseX402Payment,
} from '../src/x402.js';

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

interface BuildMessageArgs {
  numRequiredSignatures: number;
  numReadonlySigned?: number;
  numReadonlyUnsigned?: number;
  accountKeys: Buffer[];
  recentBlockhash: Buffer;
  programIdIndex: number;
  instructionAccountIndices?: number[];
  instructionData?: Buffer;
}

function buildLegacyMessage(args: BuildMessageArgs): Buffer {
  const header = Buffer.from([
    args.numRequiredSignatures,
    args.numReadonlySigned ?? 0,
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
  const ixCount = compactU16(1);
  return Buffer.concat([header, keysCount, keys, args.recentBlockhash, ixCount, instruction]);
}

function buildVersionedMessage(args: BuildMessageArgs): Buffer {
  const legacy = buildLegacyMessage(args);
  const versionedHeader = Buffer.from([0x80]);
  const luts = compactU16(0);
  return Buffer.concat([versionedHeader, legacy, luts]);
}

function buildSignedTransaction(message: Buffer, signers: Keypair[]): Buffer {
  const sigs = signers.map((kp) => cryptoSign(null, message, kp.privateKey));
  return Buffer.concat([compactU16(sigs.length), ...sigs, message]);
}

function makeValidLegacyPayment(): { tx: Buffer; signer: Keypair; programId: Buffer } {
  const signer = makeKeypair();
  const programId = randomBytes(32);
  const blockhash = randomBytes(32);
  const message = buildLegacyMessage({
    numRequiredSignatures: 1,
    numReadonlyUnsigned: 1,
    accountKeys: [signer.publicKey, programId],
    recentBlockhash: blockhash,
    programIdIndex: 1,
    instructionData: Buffer.from('zettapay-x402', 'utf8'),
  });
  return { tx: buildSignedTransaction(message, [signer]), signer, programId };
}

let handle: AppHandle;

function bootApp(): AppHandle {
  const db = openDb({ filename: ':memory:' });
  return buildApp({ db });
}

describe('parseX402Payment', () => {
  it('parses a valid signed legacy transaction', () => {
    const { tx, signer } = makeValidLegacyPayment();
    const info = parseX402Payment(tx.toString('base64'));
    expect(info.feePayer).toBe(info.signers[0]);
    expect(info.signatures).toHaveLength(1);
    expect(info.isVersioned).toBe(false);
    expect(info.version).toBeNull();
    expect(info.rawTransaction.equals(tx)).toBe(true);
    expect(info.signers[0]).toBe(info.feePayer);
    expect(Buffer.from(info.feePayer)).not.toEqual(signer.publicKey); // base58 != raw
  });

  it('parses a valid signed versioned (v0) transaction', () => {
    const signer = makeKeypair();
    const programId = randomBytes(32);
    const blockhash = randomBytes(32);
    const message = buildVersionedMessage({
      numRequiredSignatures: 1,
      numReadonlyUnsigned: 1,
      accountKeys: [signer.publicKey, programId],
      recentBlockhash: blockhash,
      programIdIndex: 1,
    });
    const tx = buildSignedTransaction(message, [signer]);
    const info = parseX402Payment(tx.toString('base64'));
    expect(info.isVersioned).toBe(true);
    expect(info.version).toBe(0);
  });

  it('rejects empty header', () => {
    expect(() => parseX402Payment('')).toThrow(X402ValidationError);
  });

  it('rejects invalid base64', () => {
    let captured: X402ValidationError | null = null;
    try {
      parseX402Payment('@@not-base64@@');
    } catch (err) {
      captured = err as X402ValidationError;
    }
    expect(captured).toBeInstanceOf(X402ValidationError);
    expect(captured?.code).toBe('invalid_encoding');
  });

  it('rejects oversized blob', () => {
    const big = Buffer.alloc(2000, 1).toString('base64');
    let code: string | undefined;
    try {
      parseX402Payment(big);
    } catch (err) {
      code = (err as X402ValidationError).code;
    }
    expect(code).toBe('malformed_transaction');
  });

  it('rejects tampered signature', () => {
    const { tx } = makeValidLegacyPayment();
    const tampered = Buffer.from(tx);
    // mutate first signature byte
    tampered[1] = (tampered[1] ?? 0) ^ 0xff;
    let code: string | undefined;
    try {
      parseX402Payment(tampered.toString('base64'));
    } catch (err) {
      code = (err as X402ValidationError).code;
    }
    expect(code).toBe('invalid_signature');
  });

  it('rejects missing signature placeholder', () => {
    const signer = makeKeypair();
    const programId = randomBytes(32);
    const blockhash = randomBytes(32);
    const message = buildLegacyMessage({
      numRequiredSignatures: 1,
      numReadonlyUnsigned: 1,
      accountKeys: [signer.publicKey, programId],
      recentBlockhash: blockhash,
      programIdIndex: 1,
    });
    const zeroSig = Buffer.alloc(64);
    const tx = Buffer.concat([compactU16(1), zeroSig, message]);
    let code: string | undefined;
    try {
      parseX402Payment(tx.toString('base64'));
    } catch (err) {
      code = (err as X402ValidationError).code;
    }
    expect(code).toBe('missing_signatures');
  });

  it('rejects unsupported versioned tx', () => {
    const signer = makeKeypair();
    const programId = randomBytes(32);
    const blockhash = randomBytes(32);
    const legacy = buildLegacyMessage({
      numRequiredSignatures: 1,
      numReadonlyUnsigned: 1,
      accountKeys: [signer.publicKey, programId],
      recentBlockhash: blockhash,
      programIdIndex: 1,
    });
    const message = Buffer.concat([Buffer.from([0x81]), legacy, compactU16(0)]);
    const tx = buildSignedTransaction(message, [signer]);
    let code: string | undefined;
    try {
      parseX402Payment(tx.toString('base64'));
    } catch (err) {
      code = (err as X402ValidationError).code;
    }
    expect(code).toBe('unsupported_version');
  });

  it('rejects truncated signature section', () => {
    const tx = Buffer.concat([compactU16(1), Buffer.alloc(10)]);
    let code: string | undefined;
    try {
      parseX402Payment(tx.toString('base64'));
    } catch (err) {
      code = (err as X402ValidationError).code;
    }
    expect(code).toBe('malformed_transaction');
  });
});

describe('POST /pay (x402 middleware)', () => {
  beforeEach(() => {
    handle = bootApp();
  });
  afterEach(() => {
    handle.db.close();
  });

  it('returns 402 when header is missing', async () => {
    const res = await request(handle.app).post('/pay').send({});
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('payment_required');
    expect(res.headers['www-authenticate']).toContain(X402_HEADER);
  });

  it('returns 400 when header is not valid base64', async () => {
    const res = await request(handle.app)
      .post('/pay')
      .set(X402_HEADER, '!!!not-base64!!!')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_encoding');
  });

  it('returns 402 when signature is invalid', async () => {
    const { tx } = makeValidLegacyPayment();
    const tampered = Buffer.from(tx);
    tampered[5] = (tampered[5] ?? 0) ^ 0xaa;
    const res = await request(handle.app)
      .post('/pay')
      .set(X402_HEADER, tampered.toString('base64'))
      .send({});
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('invalid_signature');
  });

  it('accepts a valid signed transaction and returns parsed payment metadata', async () => {
    const { tx } = makeValidLegacyPayment();
    const res = await request(handle.app)
      .post('/pay')
      .set(X402_HEADER, tx.toString('base64'))
      .send({});
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    expect(res.body.signers).toHaveLength(1);
    expect(res.body.feePayer).toBe(res.body.signers[0]);
    expect(res.body.signatureCount).toBe(1);
    expect(res.body.transactionBytes).toBe(tx.length);
    expect(res.body.isVersioned).toBe(false);
    expect(typeof res.body.recentBlockhash).toBe('string');
  });
});
