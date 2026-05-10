import type { Database as Db } from "better-sqlite3";

export interface AgentSpendingLimitRow {
  id: string;
  merchant_id: string;
  agent_identity_id: string;
  max_per_request: number | null;
  daily_cap: number | null;
  frozen: number;
  created_at: string;
  updated_at: string;
}

export interface AgentSpendingLimit {
  id: string;
  merchantId: string;
  agentIdentityId: string;
  /** USDC ceiling on a single payment from this agent. `null` disables. */
  maxPerRequest: number | null;
  /** USDC ceiling on the rolling 24h spend from this agent. `null` disables. */
  dailyCap: number | null;
  /** When true, every payment from this agent is rejected with 403. */
  frozen: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertAgentSpendingLimitInput {
  id?: string;
  merchantId: string;
  agentIdentityId: string;
  maxPerRequest: number | null;
  dailyCap: number | null;
}

function toAgentSpendingLimit(row: AgentSpendingLimitRow): AgentSpendingLimit {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    agentIdentityId: row.agent_identity_id,
    maxPerRequest: row.max_per_request,
    dailyCap: row.daily_cap,
    frozen: row.frozen === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findAgentSpendingLimit(
  db: Db,
  merchantId: string,
  agentIdentityId: string,
): AgentSpendingLimit | null {
  const row = db
    .prepare<[string, string]>(
      `SELECT * FROM agent_spending_limits
        WHERE merchant_id = ? AND agent_identity_id = ?`,
    )
    .get(merchantId, agentIdentityId) as AgentSpendingLimitRow | undefined;
  return row ? toAgentSpendingLimit(row) : null;
}

export function listAgentSpendingLimits(
  db: Db,
  merchantId: string,
): AgentSpendingLimit[] {
  const rows = db
    .prepare<[string]>(
      `SELECT * FROM agent_spending_limits
        WHERE merchant_id = ?
        ORDER BY created_at ASC`,
    )
    .all(merchantId) as AgentSpendingLimitRow[];
  return rows.map(toAgentSpendingLimit);
}

export function upsertAgentSpendingLimit(
  db: Db,
  input: UpsertAgentSpendingLimitInput,
): AgentSpendingLimit {
  const existing = findAgentSpendingLimit(
    db,
    input.merchantId,
    input.agentIdentityId,
  );
  if (existing) {
    db.prepare<[number | null, number | null, string]>(
      `UPDATE agent_spending_limits
          SET max_per_request = ?,
              daily_cap = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    ).run(input.maxPerRequest, input.dailyCap, existing.id);
    const refreshed = findAgentSpendingLimit(
      db,
      input.merchantId,
      input.agentIdentityId,
    );
    if (!refreshed) throw new Error("agent_spending_limits update failed");
    return refreshed;
  }
  const id = input.id ?? `asl_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  db.prepare<[string, string, string, number | null, number | null]>(
    `INSERT INTO agent_spending_limits
       (id, merchant_id, agent_identity_id, max_per_request, daily_cap)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.merchantId, input.agentIdentityId, input.maxPerRequest, input.dailyCap);
  const inserted = findAgentSpendingLimit(
    db,
    input.merchantId,
    input.agentIdentityId,
  );
  if (!inserted) throw new Error("agent_spending_limits insert failed");
  return inserted;
}

export function setAgentSpendingLimitFrozen(
  db: Db,
  merchantId: string,
  agentIdentityId: string,
  frozen: boolean,
): AgentSpendingLimit | null {
  // Freeze creates an implicit row when none exists so a merchant can hit the
  // panic button on a brand-new agent before manually configuring caps.
  const existing = findAgentSpendingLimit(db, merchantId, agentIdentityId);
  if (!existing) {
    if (!frozen) return null;
    return upsertAgentSpendingLimitWithFrozen(db, {
      merchantId,
      agentIdentityId,
      maxPerRequest: null,
      dailyCap: null,
      frozen: true,
    });
  }
  db.prepare<[number, string]>(
    `UPDATE agent_spending_limits
        SET frozen = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  ).run(frozen ? 1 : 0, existing.id);
  return findAgentSpendingLimit(db, merchantId, agentIdentityId);
}

interface UpsertWithFrozenInput {
  merchantId: string;
  agentIdentityId: string;
  maxPerRequest: number | null;
  dailyCap: number | null;
  frozen: boolean;
}

function upsertAgentSpendingLimitWithFrozen(
  db: Db,
  input: UpsertWithFrozenInput,
): AgentSpendingLimit {
  const id = `asl_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  db.prepare<[string, string, string, number | null, number | null, number]>(
    `INSERT INTO agent_spending_limits
       (id, merchant_id, agent_identity_id, max_per_request, daily_cap, frozen)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.merchantId,
    input.agentIdentityId,
    input.maxPerRequest,
    input.dailyCap,
    input.frozen ? 1 : 0,
  );
  const inserted = findAgentSpendingLimit(
    db,
    input.merchantId,
    input.agentIdentityId,
  );
  if (!inserted) throw new Error("agent_spending_limits frozen-upsert failed");
  return inserted;
}
