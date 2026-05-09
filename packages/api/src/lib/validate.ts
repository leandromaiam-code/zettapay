import { PublicKey } from "@solana/web3.js";
import { HttpError } from "./errors.js";

export function requireString(
  body: Record<string, unknown>,
  field: string,
  opts: { maxLength?: number } = {},
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw HttpError.badRequest(`Field "${field}" is required and must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (opts.maxLength !== undefined && trimmed.length > opts.maxLength) {
    throw HttpError.badRequest(
      `Field "${field}" exceeds max length of ${opts.maxLength}`,
    );
  }
  return trimmed;
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
  opts: { maxLength?: number } = {},
): string | null {
  const value = body[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw HttpError.badRequest(`Field "${field}" must be a string when provided`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (opts.maxLength !== undefined && trimmed.length > opts.maxLength) {
    throw HttpError.badRequest(
      `Field "${field}" exceeds max length of ${opts.maxLength}`,
    );
  }
  return trimmed;
}

export function requirePositiveNumber(
  body: Record<string, unknown>,
  field: string,
): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw HttpError.badRequest(
      `Field "${field}" is required and must be a positive number`,
    );
  }
  return value;
}

export function requireSolanaAddress(
  body: Record<string, unknown>,
  field: string,
): string {
  const raw = requireString(body, field, { maxLength: 64 });
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    throw HttpError.badRequest(
      `Field "${field}" must be a valid base58-encoded Solana public key`,
    );
  }
}

export function optionalRecord(
  body: Record<string, unknown>,
  field: string,
): Record<string, unknown> | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw HttpError.badRequest(
      `Field "${field}" must be a JSON object when provided`,
    );
  }
  return value as Record<string, unknown>;
}
