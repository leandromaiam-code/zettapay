import type { Database as Db } from "better-sqlite3";
import { appendAudit } from "../db/audit_journal.js";
import { HttpError } from "../lib/errors.js";
import {
  OFAC_SANCTIONED_ADDRESSES,
  type SanctionedAddress,
} from "./blacklist-data.js";

/**
 * Z13.2 wallet blacklist. Hard-block any payment whose payer or merchant
 * wallet appears on the OFAC sanctions list (Tornado Cash designation +
 * follow-on cyber sanctions). Runs BEFORE velocity and beta gates so a
 * sanctioned attempt never consumes a velocity slot or a beta-cohort cap.
 *
 * Match is exact-string (no normalisation beyond `trim()`); base58 Solana
 * addresses are case-sensitive, so a case-insensitive match would create
 * false positives. Operators extend the seed list via the
 * `OFAC_BLACKLIST_EXTRA` env var: comma-separated addresses, optionally
 * "address|reason" pairs. Empty entries are ignored.
 */

export type BlacklistRole = "payer" | "merchant";

export interface BlacklistMatch {
  address: string;
  reason: string;
  sanctionedOn: string | null;
  list: string;
}

export interface EnforceBlacklistInput {
  payerWallet: string;
  merchantWallet: string;
  merchantId: string;
  paymentId?: string | null;
}

const ENV_EXTRA_KEY = "OFAC_BLACKLIST_EXTRA";

let cache: Map<string, BlacklistMatch> | null = null;

function buildEntry(entry: SanctionedAddress): [string, BlacklistMatch] {
  return [
    entry.address.trim(),
    {
      address: entry.address.trim(),
      reason: entry.reason,
      sanctionedOn: entry.sanctionedOn,
      list: entry.list,
    },
  ];
}

function parseEnvExtra(raw: string | undefined): Array<[string, BlacklistMatch]> {
  if (!raw) return [];
  return raw
    .split(",")
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .map((piece) => {
      const [addressRaw, reasonRaw] = piece.split("|");
      const address = (addressRaw ?? "").trim();
      const reason = (reasonRaw ?? "operator-extended sanctions list").trim();
      return [
        address,
        {
          address,
          reason,
          sanctionedOn: null,
          list: "internal",
        },
      ] as [string, BlacklistMatch];
    })
    .filter(([address]) => address.length > 0);
}

function loadCache(): Map<string, BlacklistMatch> {
  const map = new Map<string, BlacklistMatch>();
  for (const entry of OFAC_SANCTIONED_ADDRESSES) {
    const [key, value] = buildEntry(entry);
    map.set(key, value);
  }
  for (const [key, value] of parseEnvExtra(process.env[ENV_EXTRA_KEY])) {
    map.set(key, value);
  }
  return map;
}

function getCache(): Map<string, BlacklistMatch> {
  if (cache === null) cache = loadCache();
  return cache;
}

/** Reset the in-memory cache. Test seam — also handy if an operator hot-swaps
 *  `OFAC_BLACKLIST_EXTRA` and restarts the worker. */
export function resetBlacklistCache(): void {
  cache = null;
}

/** Returns the SanctionedAddress entry matching `wallet`, or null. */
export function lookupBlacklist(wallet: string | null | undefined): BlacklistMatch | null {
  if (!wallet) return null;
  const trimmed = wallet.trim();
  if (trimmed.length === 0) return null;
  return getCache().get(trimmed) ?? null;
}

export function isBlacklisted(wallet: string | null | undefined): boolean {
  return lookupBlacklist(wallet) !== null;
}

/** Snapshot of the current blacklist — read-only, ordering is insertion order
 *  (seed list first, then env-extras). */
export function listBlacklistEntries(): ReadonlyArray<BlacklistMatch> {
  return Array.from(getCache().values());
}

/**
 * Throws 403 `forbidden` if either the payer or merchant wallet is on the
 * sanctions list, after writing an `payment.blocked.blacklist` audit row.
 * Payer is checked first so a sanctioned customer attempting to pay an
 * otherwise-clean merchant still produces a payer-attributed audit trail.
 */
export function enforceBlacklist(db: Db, input: EnforceBlacklistInput): void {
  const checks: Array<{ role: BlacklistRole; wallet: string }> = [
    { role: "payer", wallet: input.payerWallet },
    { role: "merchant", wallet: input.merchantWallet },
  ];

  for (const { role, wallet } of checks) {
    const match = lookupBlacklist(wallet);
    if (!match) continue;

    appendAudit(db, {
      actor: `${role}:${wallet}`,
      event: "payment.blocked.blacklist",
      entityType: "merchant",
      entityId: input.merchantId,
      reason: `${role} wallet on sanctions list (${match.list}): ${match.reason}`,
      payload: {
        scope: "blacklist:ofac",
        role,
        walletAddress: wallet,
        list: match.list,
        sanctionedOn: match.sanctionedOn,
        ...(input.paymentId ? { paymentId: input.paymentId } : {}),
      },
    });

    throw HttpError.forbidden(
      `${role === "payer" ? "Payer" : "Merchant"} wallet is on the sanctions list and cannot transact.`,
      {
        scope: "blacklist:ofac",
        role,
        walletAddress: wallet,
        list: match.list,
        sanctionedOn: match.sanctionedOn,
      },
    );
  }
}
