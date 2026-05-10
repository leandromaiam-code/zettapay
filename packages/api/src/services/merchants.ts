import type { Database as Db } from "better-sqlite3";
import { randomBytes } from "node:crypto";
import {
  findMerchantByEmail,
  findMerchantByWallet,
  insertMerchant,
  type Merchant,
} from "../db/merchants.js";
import { appendAudit } from "../db/audit_journal.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";

export interface RegisterMerchantInput {
  name: string;
  walletAddress: string;
  email: string;
  webhookUrl: string | null;
}

export function registerMerchant(
  db: Db,
  input: RegisterMerchantInput,
): Merchant {
  if (findMerchantByEmail(db, input.email)) {
    throw HttpError.conflict(`Merchant with email "${input.email}" already exists`);
  }
  if (findMerchantByWallet(db, input.walletAddress)) {
    throw HttpError.conflict(
      `Merchant with wallet "${input.walletAddress}" already exists`,
    );
  }

  // Webhook signing secret is generated only when a webhook URL is configured;
  // merchants with no callback URL have no use for it.
  const webhookSecret = input.webhookUrl ? generateWebhookSecret() : null;

  const merchant = insertMerchant(db, {
    id: newId("merch"),
    name: input.name,
    walletAddress: input.walletAddress,
    email: input.email,
    apiKey: generateApiKey(),
    webhookUrl: input.webhookUrl,
    webhookSecret,
  });

  appendAudit(db, {
    actor: `merchant:${merchant.id}`,
    event: "merchant.registered",
    entityType: "merchant",
    entityId: merchant.id,
    reason: "self-service registration",
    payload: {
      email: merchant.email,
      walletAddress: merchant.walletAddress,
      hasWebhookUrl: webhookSecret !== null,
    },
  });

  return merchant;
}

function generateApiKey(): string {
  return `zp_live_${randomBytes(24).toString("hex")}`;
}

function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("hex")}`;
}
