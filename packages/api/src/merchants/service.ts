import { randomBytes, randomUUID } from "node:crypto";
import { getConfig } from "../config.js";
import { ConflictError, ValidationError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { parsePublicKey } from "../solana/connection.js";
import { registerOnchainBinding } from "../solana/ata.js";
import { getMerchantStore, type MerchantStore } from "./store.js";
import type { Merchant, RegisterMerchantInput, PublicMerchant } from "./types.js";
import { toPublicMerchant } from "./types.js";

export interface RegisterMerchantResult {
  merchant: PublicMerchant;
  binding: {
    ataAddress: string;
    ataCreated: boolean;
    txSignature: string;
    memoPayload: string;
    feePayer: string;
    cluster: string;
  };
  apiKey: string;
}

function generateApiKey(): string {
  return `zp_live_${randomBytes(24).toString("hex")}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validateWebhookUrl(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ValidationError("webhookUrl must be a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ValidationError("webhookUrl must use http(s)");
  }
  return parsed.toString();
}

export async function registerMerchant(
  input: RegisterMerchantInput,
  deps: { store?: MerchantStore } = {},
): Promise<RegisterMerchantResult> {
  const store = deps.store ?? getMerchantStore();
  const cfg = getConfig();

  const ownerKey = parsePublicKey(input.walletAddress, "walletAddress");
  const wallet = ownerKey.toBase58();
  const email = normalizeEmail(input.email);
  const webhookUrl = validateWebhookUrl(input.webhookUrl ?? null);

  const [byWallet, byEmail] = await Promise.all([
    store.findByWallet(wallet),
    store.findByEmail(email),
  ]);
  if (byWallet !== null) {
    throw new ConflictError("Wallet already registered as a merchant", {
      merchantId: byWallet.id,
    });
  }
  if (byEmail !== null) {
    throw new ConflictError("Email already registered", { merchantId: byEmail.id });
  }

  const id = randomUUID();
  const apiKey = generateApiKey();
  const now = new Date().toISOString();

  const draft: Merchant = {
    id,
    name: input.name.trim(),
    email,
    walletAddress: wallet,
    apiKey,
    webhookUrl,
    status: "pending",
    binding: null,
    createdAt: now,
    updatedAt: now,
  };

  await store.insert(draft);

  let bindingResult;
  try {
    bindingResult = await registerOnchainBinding({
      ownerWallet: ownerKey,
      merchantId: id,
    });
  } catch (err) {
    logger.error("merchant_binding_failed", {
      merchantId: id,
      wallet,
      error: (err as Error).message,
    });
    throw err;
  }

  const updated: Merchant = {
    ...draft,
    status: "active",
    binding: {
      ataAddress: bindingResult.ataAddress,
      ataCreated: bindingResult.ataCreated,
      txSignature: bindingResult.txSignature,
      memoPayload: bindingResult.memoPayload,
      feePayer: bindingResult.feePayer,
      cluster: cfg.solana.cluster,
      boundAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
  await store.update(updated);

  return {
    merchant: toPublicMerchant(updated),
    binding: {
      ataAddress: bindingResult.ataAddress,
      ataCreated: bindingResult.ataCreated,
      txSignature: bindingResult.txSignature,
      memoPayload: bindingResult.memoPayload,
      feePayer: bindingResult.feePayer,
      cluster: cfg.solana.cluster,
    },
    apiKey,
  };
}
