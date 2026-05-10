import type { Database as Db } from "better-sqlite3";

export type AgentIdentityStatus = "active" | "revoked";

export interface AgentIdentityRow {
  id: string;
  provider: string;
  agent_id: string;
  public_key: string;
  display_name: string | null;
  owner_email: string | null;
  payout_wallet: string | null;
  status: AgentIdentityStatus;
  registered_at: string;
  updated_at: string;
}

export interface AgentIdentity {
  id: string;
  provider: string;
  agentId: string;
  publicKey: string;
  displayName: string | null;
  ownerEmail: string | null;
  /** Z20.4: Solana wallet where this agent receives A2A payments. */
  payoutWallet: string | null;
  status: AgentIdentityStatus;
  registeredAt: string;
  updatedAt: string;
}

export interface InsertAgentIdentityInput {
  id: string;
  provider: string;
  agentId: string;
  publicKey: string;
  displayName: string | null;
  ownerEmail: string | null;
  payoutWallet?: string | null;
  status?: AgentIdentityStatus;
}

function toAgentIdentity(row: AgentIdentityRow): AgentIdentity {
  return {
    id: row.id,
    provider: row.provider,
    agentId: row.agent_id,
    publicKey: row.public_key,
    displayName: row.display_name,
    ownerEmail: row.owner_email,
    payoutWallet: row.payout_wallet,
    status: row.status,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
  };
}

export function insertAgentIdentity(
  db: Db,
  input: InsertAgentIdentityInput,
): AgentIdentity {
  db.prepare(
    `INSERT INTO agent_identities (
       id, provider, agent_id, public_key, display_name, owner_email, payout_wallet, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.provider,
    input.agentId,
    input.publicKey,
    input.displayName,
    input.ownerEmail,
    input.payoutWallet ?? null,
    input.status ?? "active",
  );
  const row = db
    .prepare<[string]>("SELECT * FROM agent_identities WHERE id = ?")
    .get(input.id) as AgentIdentityRow | undefined;
  if (!row) throw new Error("agent_identities insert failed");
  return toAgentIdentity(row);
}

export function setAgentIdentityPayoutWallet(
  db: Db,
  id: string,
  payoutWallet: string | null,
): AgentIdentity | null {
  db.prepare<[string | null, string]>(
    `UPDATE agent_identities
       SET payout_wallet = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`,
  ).run(payoutWallet, id);
  return findAgentIdentityById(db, id);
}

export function findAgentIdentityById(
  db: Db,
  id: string,
): AgentIdentity | null {
  const row = db
    .prepare<[string]>("SELECT * FROM agent_identities WHERE id = ?")
    .get(id) as AgentIdentityRow | undefined;
  return row ? toAgentIdentity(row) : null;
}

export function findAgentIdentityByProviderAgent(
  db: Db,
  provider: string,
  agentId: string,
): AgentIdentity | null {
  const row = db
    .prepare<[string, string]>(
      "SELECT * FROM agent_identities WHERE provider = ? AND agent_id = ?",
    )
    .get(provider, agentId) as AgentIdentityRow | undefined;
  return row ? toAgentIdentity(row) : null;
}

export function findAgentIdentityByPublicKey(
  db: Db,
  publicKey: string,
): AgentIdentity | null {
  const row = db
    .prepare<[string]>("SELECT * FROM agent_identities WHERE public_key = ?")
    .get(publicKey) as AgentIdentityRow | undefined;
  return row ? toAgentIdentity(row) : null;
}

export function setAgentIdentityStatus(
  db: Db,
  id: string,
  status: AgentIdentityStatus,
): AgentIdentity | null {
  db.prepare<[AgentIdentityStatus, string]>(
    `UPDATE agent_identities
       SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`,
  ).run(status, id);
  return findAgentIdentityById(db, id);
}

/**
 * Atomically record a fresh nonce for the given identity. Returns false when
 * the (identity_id, nonce) pair has been seen before — the caller must reject
 * the proof in that case to defeat replay attacks.
 */
export function recordAgentNonce(
  db: Db,
  identityId: string,
  nonce: string,
): boolean {
  try {
    db.prepare<[string, string]>(
      `INSERT INTO agent_identity_nonces (identity_id, nonce) VALUES (?, ?)`,
    ).run(identityId, nonce);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE")) return false;
    throw err;
  }
}

/**
 * Drop nonces older than the freshness window. Optional housekeeping —
 * verifyProofSignature already rejects stale timestamps, so unbounded growth
 * is the only concern.
 */
export function pruneAgentNoncesOlderThan(db: Db, isoCutoff: string): number {
  const result = db
    .prepare<[string]>(
      `DELETE FROM agent_identity_nonces WHERE used_at < ?`,
    )
    .run(isoCutoff);
  return result.changes;
}
