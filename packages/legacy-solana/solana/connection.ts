import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { getConfig } from "../config.js";
import { ConfigurationError, ValidationError } from "../lib/errors.js";

let cachedConnection: Connection | null = null;
let cachedFeePayer: Keypair | null = null;

export function getConnection(): Connection {
  if (cachedConnection !== null) return cachedConnection;
  const cfg = getConfig();
  cachedConnection = new Connection(cfg.solana.rpcUrl, cfg.solana.commitment);
  return cachedConnection;
}

export function resetSolanaCache(): void {
  cachedConnection = null;
  cachedFeePayer = null;
}

/**
 * Fee payer used to fund ATA rent (~0.002 SOL) and broadcast the binding tx.
 * Accepts base58 (Phantom export format) or JSON array (Solana CLI format).
 */
export function getFeePayer(): Keypair {
  if (cachedFeePayer !== null) return cachedFeePayer;
  const cfg = getConfig();
  const secret = cfg.solana.feePayerSecret;
  if (secret === null || secret.length === 0) {
    throw new ConfigurationError(
      "SOLANA_FEE_PAYER_SECRET is not configured. Set a base58 or JSON array secret key.",
    );
  }
  cachedFeePayer = decodeKeypair(secret);
  return cachedFeePayer;
}

function decodeKeypair(secret: string): Keypair {
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    try {
      const bytes = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(bytes) || !bytes.every((n) => typeof n === "number")) {
        throw new Error("expected number[]");
      }
      return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
    } catch (err) {
      throw new ConfigurationError("Invalid JSON keypair in SOLANA_FEE_PAYER_SECRET", {
        cause: (err as Error).message,
      });
    }
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(trimmed));
  } catch (err) {
    throw new ConfigurationError("Invalid base58 keypair in SOLANA_FEE_PAYER_SECRET", {
      cause: (err as Error).message,
    });
  }
}

export function parsePublicKey(raw: string, field = "publicKey"): PublicKey {
  try {
    const pk = new PublicKey(raw);
    if (!PublicKey.isOnCurve(pk.toBytes())) {
      throw new ValidationError(`${field} is not a valid Ed25519 wallet address`);
    }
    return pk;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(`${field} is not a valid Solana public key`, {
      cause: (err as Error).message,
    });
  }
}
