import type { Database as Db } from "better-sqlite3";

/**
 * Z25.4 — `zettapay_protocol_config` registry of deployed on-chain programs.
 *
 * One row per (program_name, cluster) pair. The devnet deploy automation
 * (`scripts/deploy-devnet-core.sh`) upserts here so off-chain services
 * (SDK, API, smoke test) can resolve the live program id without baking it
 * into config files. The table is global (not merchant-scoped) — RLS on
 * the Supabase mirror grants `select` to everyone, mutation to service
 * role only.
 */

export type ProtocolCluster =
  | "mainnet-beta"
  | "devnet"
  | "testnet"
  | "localnet";

const CLUSTERS: ReadonlySet<ProtocolCluster> = new Set<ProtocolCluster>([
  "mainnet-beta",
  "devnet",
  "testnet",
  "localnet",
]);

export function isProtocolCluster(value: string): value is ProtocolCluster {
  return CLUSTERS.has(value as ProtocolCluster);
}

export interface ProtocolConfigRow {
  id: string;
  program_name: string;
  cluster: ProtocolCluster;
  program_id: string;
  artifact_sha256: string | null;
  artifact_size: number | null;
  deployer_pubkey: string | null;
  deploy_tx_signature: string | null;
  deployed_at: string;
  updated_at: string;
}

export interface ProtocolConfig {
  id: string;
  programName: string;
  cluster: ProtocolCluster;
  programId: string;
  artifactSha256: string | null;
  artifactSize: number | null;
  deployerPubkey: string | null;
  deployTxSignature: string | null;
  deployedAt: string;
  updatedAt: string;
}

export interface UpsertProtocolConfigInput {
  programName: string;
  cluster: ProtocolCluster;
  programId: string;
  artifactSha256?: string | null;
  artifactSize?: number | null;
  deployerPubkey?: string | null;
  deployTxSignature?: string | null;
}

function toProtocolConfig(row: ProtocolConfigRow): ProtocolConfig {
  return {
    id: row.id,
    programName: row.program_name,
    cluster: row.cluster,
    programId: row.program_id,
    artifactSha256: row.artifact_sha256,
    artifactSize: row.artifact_size,
    deployerPubkey: row.deployer_pubkey,
    deployTxSignature: row.deploy_tx_signature,
    deployedAt: row.deployed_at,
    updatedAt: row.updated_at,
  };
}

export function buildProtocolConfigId(
  programName: string,
  cluster: ProtocolCluster,
): string {
  return `${programName}:${cluster}`;
}

export function upsertProtocolConfig(
  db: Db,
  input: UpsertProtocolConfigInput,
): ProtocolConfig {
  if (!isProtocolCluster(input.cluster)) {
    throw new Error(`invalid cluster: ${input.cluster}`);
  }
  if (!input.programName) {
    throw new Error("programName required");
  }
  if (!input.programId) {
    throw new Error("programId required");
  }
  const id = buildProtocolConfigId(input.programName, input.cluster);
  db.prepare<
    [string, string, string, string, string | null, number | null, string | null, string | null]
  >(
    `INSERT INTO zettapay_protocol_config (
       id, program_name, cluster, program_id,
       artifact_sha256, artifact_size, deployer_pubkey, deploy_tx_signature
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(program_name, cluster) DO UPDATE SET
       program_id          = excluded.program_id,
       artifact_sha256     = excluded.artifact_sha256,
       artifact_size       = excluded.artifact_size,
       deployer_pubkey     = excluded.deployer_pubkey,
       deploy_tx_signature = excluded.deploy_tx_signature,
       updated_at          = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(
    id,
    input.programName,
    input.cluster,
    input.programId,
    input.artifactSha256 ?? null,
    input.artifactSize ?? null,
    input.deployerPubkey ?? null,
    input.deployTxSignature ?? null,
  );
  const row = db
    .prepare<[string]>("SELECT * FROM zettapay_protocol_config WHERE id = ?")
    .get(id) as ProtocolConfigRow | undefined;
  if (!row) {
    throw new Error("protocol config upserted but not retrievable");
  }
  return toProtocolConfig(row);
}

export function getProtocolConfig(
  db: Db,
  programName: string,
  cluster: ProtocolCluster,
): ProtocolConfig | null {
  const row = db
    .prepare<[string, string]>(
      `SELECT * FROM zettapay_protocol_config
       WHERE program_name = ? AND cluster = ?`,
    )
    .get(programName, cluster) as ProtocolConfigRow | undefined;
  return row ? toProtocolConfig(row) : null;
}

export function listProtocolConfigs(db: Db): ProtocolConfig[] {
  const rows = db
    .prepare(
      `SELECT * FROM zettapay_protocol_config
       ORDER BY program_name, cluster`,
    )
    .all() as ProtocolConfigRow[];
  return rows.map(toProtocolConfig);
}
