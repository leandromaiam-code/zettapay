/**
 * scripts/persist-program-id.ts — Z25.4
 *
 * CLI helper that writes a freshly-deployed Solana program id into the
 * `zettapay_protocol_config` table. Invoked by `deploy-devnet-core.sh`
 * after `solana program deploy` returns the program id; can also be run
 * by hand from a mainnet deploy runbook (premise 16: mainnet is human-
 * signed, so the persistence step is a separate CLI invocation rather
 * than an autonomous loop step).
 *
 * Args (all required unless noted):
 *
 *   --program-name <str>         e.g. "zettapay-core"
 *   --cluster <str>              devnet | testnet | mainnet-beta | localnet
 *   --program-id <base58>        the deployed program id
 *   --deployer <base58>          (optional) deployer pubkey
 *   --tx <base58>                (optional) deploy tx signature
 *   --sha256 <hex>               (optional) artifact sha256
 *   --size <int>                 (optional) artifact size in bytes
 *
 * Env:
 *   ZETTAPAY_DB_PATH             SQLite path (default ./data/zettapay.sqlite)
 *
 * Exit codes: 0 on success, 1 on bad args, 2 on DB write failure.
 *
 * Premise alignment:
 *   • Premise 13 (SQLite dev / Postgres prod): writes to whichever SQLite
 *     the harness is pointed at. For Supabase prod, the mainnet deploy
 *     runbook executes the same upsert against the Postgres mirror via
 *     `supabase db query`.
 *   • Premise 22 (free tier / DevX): a CLI keeps the deploy automation
 *     hermetic — no extra service round-trip required.
 */

import { openDatabase, closeDatabase } from "../packages/api/src/db/index.js";
import {
  isProtocolCluster,
  upsertProtocolConfig,
  type ProtocolCluster,
} from "../packages/api/src/db/protocol_config.js";

interface Args {
  programName: string;
  cluster: ProtocolCluster;
  programId: string;
  deployer: string | null;
  tx: string | null;
  sha256: string | null;
  size: number | null;
}

function fail(msg: string): never {
  process.stderr.write(`persist-program-id: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): Args {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (typeof flag !== "string" || !flag.startsWith("--")) continue;
    const value = argv[i + 1];
    if (typeof value !== "string") fail(`flag ${flag} missing value`);
    map.set(flag.slice(2), value);
    i += 1;
  }
  const programName = map.get("program-name");
  const cluster = map.get("cluster");
  const programId = map.get("program-id");
  if (!programName) fail("--program-name required");
  if (!cluster) fail("--cluster required");
  if (!programId) fail("--program-id required");
  if (!isProtocolCluster(cluster)) {
    fail(`--cluster must be one of mainnet-beta|devnet|testnet|localnet (got ${cluster})`);
  }
  const sizeRaw = map.get("size");
  let size: number | null = null;
  if (sizeRaw !== undefined) {
    const parsed = Number.parseInt(sizeRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      fail(`--size must be a non-negative integer (got ${sizeRaw})`);
    }
    size = parsed;
  }
  return {
    programName,
    cluster,
    programId,
    deployer: map.get("deployer") ?? null,
    tx: map.get("tx") ?? null,
    sha256: map.get("sha256") ?? null,
    size,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = process.env.ZETTAPAY_DB_PATH ?? "./data/zettapay.sqlite";
  const db = openDatabase(dbPath);
  try {
    const config = upsertProtocolConfig(db, {
      programName: args.programName,
      cluster: args.cluster,
      programId: args.programId,
      deployerPubkey: args.deployer,
      deployTxSignature: args.tx,
      artifactSha256: args.sha256,
      artifactSize: args.size,
    });
    process.stdout.write(
      `persisted ${config.programName}@${config.cluster} = ${config.programId} ` +
        `(deployed_at=${config.deployedAt}, updated_at=${config.updatedAt})\n`,
    );
  } catch (err) {
    process.stderr.write(`persist failed: ${(err as Error).message}\n`);
    process.exit(2);
  } finally {
    closeDatabase();
  }
}

main();
