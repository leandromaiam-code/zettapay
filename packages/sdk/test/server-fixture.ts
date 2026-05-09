import { createServer, type Server } from 'node:http';
import {
  generateKeyPairSync,
  sign as cryptoSign,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { buildApp } from '../../api/src/app.js';
import { openDb, type DB } from '../../api/src/db.js';

export interface Fixture {
  baseURL: string;
  close(): Promise<void>;
  db: DB;
}

export async function startFixture(): Promise<Fixture> {
  const db = openDb({ filename: ':memory:' });
  const { app } = buildApp({ db });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind test server');
  }
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    db,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      db.close();
    },
  };
}

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

function buildLegacyMessage(signerKey: Buffer, programId: Buffer, blockhash: Buffer): Buffer {
  const header = Buffer.from([1, 0, 1]);
  const keys = Buffer.concat([compactU16(2), signerKey, programId]);
  const ix = Buffer.concat([
    Buffer.from([1]),
    compactU16(0),
    compactU16(13),
    Buffer.from('zettapay-x402', 'utf8'),
  ]);
  return Buffer.concat([header, keys, blockhash, compactU16(1), ix]);
}

export function makeSignedTransactionBase64(): string {
  const signer = makeKeypair();
  const programId = randomBytes(32);
  const blockhash = randomBytes(32);
  const message = buildLegacyMessage(signer.publicKey, programId, blockhash);
  const sig = cryptoSign(null, message, signer.privateKey);
  const tx = Buffer.concat([compactU16(1), sig, message]);
  return tx.toString('base64');
}
