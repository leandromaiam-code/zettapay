import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { base58Encode } from './base58.js';

export const X402_HEADER = 'x-402-payment';

const SIGNATURE_LENGTH = 64;
const PUBKEY_LENGTH = 32;
const BLOCKHASH_LENGTH = 32;
const MAX_BLOB_BYTES = 1232;
const VERSIONED_PREFIX_MASK = 0x80;
const ED25519_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type X402ErrorCode =
  | 'missing_header'
  | 'invalid_encoding'
  | 'malformed_transaction'
  | 'unsupported_version'
  | 'missing_signatures'
  | 'invalid_signature';

export class X402ValidationError extends Error {
  constructor(public readonly code: X402ErrorCode, message: string) {
    super(message);
    this.name = 'X402ValidationError';
  }
}

export interface X402PaymentInfo {
  feePayer: string;
  signers: string[];
  signatures: string[];
  recentBlockhash: string;
  isVersioned: boolean;
  version: number | null;
  rawTransaction: Buffer;
  messageBytes: Buffer;
}

declare module 'express-serve-static-core' {
  interface Request {
    x402Payment?: X402PaymentInfo;
  }
}

function readCompactU16(buf: Buffer, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 3; i++) {
    if (offset + i >= buf.length) {
      throw new X402ValidationError('malformed_transaction', 'compact-u16 truncated');
    }
    const byte = buf[offset + i] ?? 0;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, bytesRead: i + 1 };
    }
    shift += 7;
  }
  throw new X402ValidationError('malformed_transaction', 'compact-u16 exceeds 3 bytes');
}

function decodeBase64Strict(value: string): Buffer {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new X402ValidationError('invalid_encoding', 'header value is empty');
  }
  const buf = Buffer.from(trimmed, 'base64');
  if (buf.length === 0 || buf.toString('base64').replace(/=+$/, '') !== trimmed.replace(/=+$/, '')) {
    throw new X402ValidationError('invalid_encoding', 'header is not valid base64');
  }
  return buf;
}

function ed25519Verify(pubKey: Buffer, message: Buffer, signature: Buffer): boolean {
  try {
    const der = Buffer.concat([ED25519_DER_PREFIX, pubKey]);
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

export function parseX402Payment(headerValue: string): X402PaymentInfo {
  const raw = decodeBase64Strict(headerValue);
  if (raw.length > MAX_BLOB_BYTES) {
    throw new X402ValidationError(
      'malformed_transaction',
      `transaction exceeds ${MAX_BLOB_BYTES} bytes`,
    );
  }

  let cursor = 0;
  const sigCount = readCompactU16(raw, cursor);
  cursor += sigCount.bytesRead;
  if (sigCount.value === 0) {
    throw new X402ValidationError(
      'missing_signatures',
      'transaction must include at least one signature',
    );
  }
  if (raw.length < cursor + sigCount.value * SIGNATURE_LENGTH) {
    throw new X402ValidationError('malformed_transaction', 'signature section truncated');
  }
  const signatures: Buffer[] = [];
  for (let i = 0; i < sigCount.value; i++) {
    signatures.push(raw.subarray(cursor, cursor + SIGNATURE_LENGTH));
    cursor += SIGNATURE_LENGTH;
  }

  const messageStart = cursor;
  if (raw.length <= messageStart) {
    throw new X402ValidationError('malformed_transaction', 'missing message payload');
  }

  let isVersioned = false;
  let version: number | null = null;
  const firstByte = raw[messageStart] ?? 0;
  if ((firstByte & VERSIONED_PREFIX_MASK) !== 0) {
    isVersioned = true;
    version = firstByte & 0x7f;
    if (version !== 0) {
      throw new X402ValidationError(
        'unsupported_version',
        `versioned transaction v${version} not supported`,
      );
    }
    cursor += 1;
  }

  if (raw.length < cursor + 3) {
    throw new X402ValidationError('malformed_transaction', 'message header truncated');
  }
  const numRequiredSignatures = raw[cursor] ?? 0;
  cursor += 3;
  if (numRequiredSignatures !== sigCount.value) {
    throw new X402ValidationError(
      'malformed_transaction',
      'signature count mismatch with message header',
    );
  }

  const numKeys = readCompactU16(raw, cursor);
  cursor += numKeys.bytesRead;
  if (numKeys.value < numRequiredSignatures) {
    throw new X402ValidationError(
      'malformed_transaction',
      'account key count below required signature count',
    );
  }
  if (raw.length < cursor + numKeys.value * PUBKEY_LENGTH) {
    throw new X402ValidationError('malformed_transaction', 'account keys truncated');
  }
  const accountKeys: Buffer[] = [];
  for (let i = 0; i < numKeys.value; i++) {
    accountKeys.push(raw.subarray(cursor, cursor + PUBKEY_LENGTH));
    cursor += PUBKEY_LENGTH;
  }

  if (raw.length < cursor + BLOCKHASH_LENGTH) {
    throw new X402ValidationError('malformed_transaction', 'recent blockhash truncated');
  }
  const blockhash = raw.subarray(cursor, cursor + BLOCKHASH_LENGTH);

  const messageBytes = raw.subarray(messageStart);
  const zero = Buffer.alloc(SIGNATURE_LENGTH);
  for (let i = 0; i < numRequiredSignatures; i++) {
    const sig = signatures[i];
    const signerKey = accountKeys[i];
    if (!sig || !signerKey) {
      throw new X402ValidationError('malformed_transaction', `signer ${i} data missing`);
    }
    if (sig.equals(zero)) {
      throw new X402ValidationError(
        'missing_signatures',
        `signer ${i} signature is empty`,
      );
    }
    if (!ed25519Verify(signerKey, messageBytes, sig)) {
      throw new X402ValidationError(
        'invalid_signature',
        `signature ${i} failed ed25519 verification`,
      );
    }
  }

  const signersBs58 = accountKeys.slice(0, numRequiredSignatures).map(base58Encode);
  return {
    feePayer: signersBs58[0] ?? '',
    signers: signersBs58,
    signatures: signatures.map(base58Encode),
    recentBlockhash: base58Encode(blockhash),
    isVersioned,
    version,
    rawTransaction: raw,
    messageBytes,
  };
}

export interface X402MiddlewareOptions {
  required?: boolean;
}

export function x402PaymentMiddleware(options: X402MiddlewareOptions = {}): RequestHandler {
  const required = options.required ?? true;
  return (req: Request, res: Response, next: NextFunction) => {
    const headerValue = req.header(X402_HEADER);
    if (!headerValue) {
      if (!required) {
        next();
        return;
      }
      res
        .status(402)
        .set('WWW-Authenticate', `X-402 header="${X402_HEADER}", scheme="solana-tx"`)
        .json({
          error: {
            code: 'payment_required',
            message: `missing ${X402_HEADER} header — provide a base64-encoded signed Solana transaction`,
          },
        });
      return;
    }
    try {
      req.x402Payment = parseX402Payment(headerValue);
      next();
    } catch (err) {
      if (err instanceof X402ValidationError) {
        const status = err.code === 'invalid_signature' ? 402 : 400;
        res.status(status).json({
          error: { code: err.code, message: err.message },
        });
        return;
      }
      next(err);
    }
  };
}
