/**
 * scripts/z29-4-mainnet-program-live.ts — Z29.4
 *
 * Closes the Z29 mainnet deploy loop. Z29.1 builds the bytecode, Z29.2 funds
 * the deployer keypair, Z29.3 walks the human operator through signing the
 * BPF upgrade tx with Phantom. Once that tx lands and the operator hands back
 * the new program id, THIS script:
 *
 *   1. Validates the program is actually deployed on mainnet-beta by calling
 *      `connection.getAccountInfo(programId)` — must be executable, owned by
 *      the BPF Upgradeable Loader, and have non-zero bytecode length.
 *   2. UPSERTs `public.zettapay_protocol_config` (mainnet-beta row) via the
 *      Supabase PostgREST endpoint using the service-role key. RLS denies all
 *      non-service access (premise 21), so this write is server-side only.
 *   3. Writes a local audit artifact at
 *      `target/deploy/zettapay.protocol-config.mainnet.json` so the deploy is
 *      reproducible from the worktree without round-tripping to Postgres.
 *   4. Posts a single WhatsApp message via `WHATSAPP_WEBHOOK_URL` confirming
 *      the program is LIVE (same provider-agnostic JSON shape as
 *      scripts/notify-mainnet-ready.sh — Twilio/Evolution/Meta/Z-API). Single-
 *      shot, no retries — the operator gets one ping, not three.
 *
 * Invocation:
 *
 *   PROGRAM_ID=<base58> \
 *   DEPLOY_SIGNATURE=<base58> \
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<service-role-jwt> \
 *   WHATSAPP_WEBHOOK_URL=<url> \
 *   WHATSAPP_OPERATOR_NUMBER=+5511999999999 \
 *   npm run z29:4:program-live
 *
 * Optional env:
 *   MAINNET_RPC_URL              defaults to https://api.mainnet-beta.solana.com
 *   WHATSAPP_WEBHOOK_TOKEN       added as Authorization: Bearer if set
 *   WHATSAPP_FROM_NUMBER         provider sender id, if required
 *   Z29_4_DRY_RUN=true           skip the upsert + WhatsApp POST, run validation only
 *
 * Exit codes:
 *   0  success
 *   1  unexpected runtime failure
 *   2  missing / invalid args or env
 *   3  program id does not resolve to a deployed executable on mainnet
 *   4  Supabase upsert returned a non-2xx
 *   5  WhatsApp webhook returned a non-2xx
 *
 * WALLET-LESS: this script never opens a wallet, never imports
 * @solana/wallet-adapter, never calls `.connect()`. It only reads on-chain
 * state via a public RPC and writes a Postgres row. The operator's Phantom
 * usage happened upstream in Z29.3.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { argv, env, exit, stdout } from "node:process";
import { Connection, PublicKey } from "@solana/web3.js";

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HTTPS_RE = /^https:\/\//i;
const BPF_UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const NETWORK = "mainnet-beta";
const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

interface ValidatedProgram {
  programId: string;
  owner: string;
  executable: boolean;
  dataLen: number;
  lamports: number;
}

interface ConfigArtifact {
  sprint: "Z29.4";
  network: typeof NETWORK;
  program_id: string;
  deploy_signature: string | null;
  rpc_url: string;
  validated: ValidatedProgram;
  deployed_at: string;
  verified_at: string;
  dry_run: boolean;
}

function requireEnv(name: string): string {
  const value = env[name];
  if (!value || value.trim() === "") {
    console.error(`Missing required env var: ${name}`);
    exit(2);
  }
  return value.trim();
}

function optionalEnv(name: string): string | null {
  const value = env[name];
  if (!value || value.trim() === "") return null;
  return value.trim();
}

async function validateProgram(
  rpcUrl: string,
  programIdRaw: string,
): Promise<ValidatedProgram> {
  if (!SOLANA_PUBKEY_RE.test(programIdRaw)) {
    console.error(`PROGRAM_ID "${programIdRaw}" is not a valid base58 Solana pubkey`);
    exit(2);
  }
  let programId: PublicKey;
  try {
    programId = new PublicKey(programIdRaw);
  } catch (err) {
    console.error(
      `PROGRAM_ID could not be parsed as PublicKey: ${err instanceof Error ? err.message : String(err)}`,
    );
    exit(2);
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const info = await connection.getAccountInfo(programId, "confirmed");

  if (info === null) {
    console.error(
      `Program ${programIdRaw} has no account on mainnet-beta @ ${rpcUrl}. Did the deploy tx land?`,
    );
    exit(3);
  }
  if (!info.executable) {
    console.error(
      `Program ${programIdRaw} exists but is NOT executable — this looks like a data account, not a program.`,
    );
    exit(3);
  }
  if (info.owner.toBase58() !== BPF_UPGRADEABLE_LOADER) {
    console.error(
      `Program ${programIdRaw} owner is ${info.owner.toBase58()} (expected ${BPF_UPGRADEABLE_LOADER}).`,
    );
    exit(3);
  }
  if (info.data.length === 0) {
    console.error(`Program ${programIdRaw} has zero data length — refusing to mark live.`);
    exit(3);
  }

  return {
    programId: programIdRaw,
    owner: info.owner.toBase58(),
    executable: info.executable,
    dataLen: info.data.length,
    lamports: info.lamports,
  };
}

async function upsertProtocolConfig(
  supabaseUrl: string,
  serviceRoleKey: string,
  programId: string,
  deployedAt: string,
  verifierNote: string,
): Promise<void> {
  const endpoint = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/zettapay_protocol_config`;
  const payload = {
    network: NETWORK,
    program_id: programId,
    deployed_at: deployedAt,
    verified_at: new Date().toISOString(),
    verifier_note: verifierNote,
    updated_at: new Date().toISOString(),
  };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`Supabase upsert failed: HTTP ${res.status}`);
    if (body) console.error(body.slice(0, 500));
    exit(4);
  }
}

async function notifyWhatsApp(
  webhookUrl: string,
  webhookToken: string | null,
  to: string,
  from: string | null,
  message: string,
): Promise<void> {
  const payload: Record<string, unknown> = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { preview_url: false, body: message },
  };
  if (from) payload.from = from;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (webhookToken) headers.authorization = `Bearer ${webhookToken}`;

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    console.error(`WhatsApp webhook returned HTTP ${res.status}`);
    if (body) console.error(body.slice(0, 500));
    exit(5);
  }
  stdout.write(`==> WhatsApp notification sent to ${to}\n`);
}

function buildMessage(programId: string, deploySignature: string | null, dataLen: number): string {
  const lines = [
    "ZettaPay program LIVE em mainnet-beta.",
    "",
    `program: ${programId}`,
    `size:    ${(dataLen / 1024).toFixed(1)} KB`,
  ];
  if (deploySignature) {
    lines.push(`tx:      ${deploySignature}`);
    lines.push(`         https://solscan.io/tx/${deploySignature}`);
  }
  lines.push("", "Protocol config atualizado. SDK 2.0 ja aponta pra mainnet.");
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write(
      [
        "Usage: PROGRAM_ID=<base58> DEPLOY_SIGNATURE=<base58> \\",
        "       SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \\",
        "       WHATSAPP_WEBHOOK_URL=… WHATSAPP_OPERATOR_NUMBER=… \\",
        "       npm run z29:4:program-live",
        "",
        "Marks the ZettaPay program live on mainnet-beta after Z29.3 deploy.",
        "Validates getAccountInfo, upserts zettapay_protocol_config, pings WhatsApp.",
      ].join("\n") + "\n",
    );
    return;
  }

  const programIdRaw = requireEnv("PROGRAM_ID");
  const deploySignature = optionalEnv("DEPLOY_SIGNATURE");
  if (deploySignature && !SOLANA_PUBKEY_RE.test(deploySignature)) {
    console.error(`DEPLOY_SIGNATURE "${deploySignature}" is not a valid base58 signature`);
    exit(2);
  }
  const rpcUrl = optionalEnv("MAINNET_RPC_URL") ?? DEFAULT_RPC_URL;
  if (!HTTPS_RE.test(rpcUrl)) {
    console.error("MAINNET_RPC_URL must be an https:// URL");
    exit(2);
  }
  const dryRun = (env.Z29_4_DRY_RUN ?? "").toLowerCase() === "true";

  stdout.write(`==> Validating program ${programIdRaw} on ${rpcUrl}\n`);
  const validated = await validateProgram(rpcUrl, programIdRaw);
  stdout.write(
    `    executable=${validated.executable} owner=${validated.owner} data=${validated.dataLen}B\n`,
  );

  const deployedAt = new Date().toISOString();
  const verifierNote = deploySignature
    ? `Z29.4 verified via getAccountInfo; deploy tx ${deploySignature}`
    : "Z29.4 verified via getAccountInfo";

  const artifact: ConfigArtifact = {
    sprint: "Z29.4",
    network: NETWORK,
    program_id: programIdRaw,
    deploy_signature: deploySignature,
    rpc_url: rpcUrl,
    validated,
    deployed_at: deployedAt,
    verified_at: new Date().toISOString(),
    dry_run: dryRun,
  };
  const artifactPath = resolve("target/deploy/zettapay.protocol-config.mainnet.json");
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  stdout.write(`==> Audit artifact written: ${artifactPath}\n`);

  if (dryRun) {
    stdout.write("==> Z29_4_DRY_RUN=true — skipping Supabase upsert + WhatsApp notify\n");
    return;
  }

  const supabaseUrl = requireEnv("SUPABASE_URL");
  if (!HTTPS_RE.test(supabaseUrl)) {
    console.error("SUPABASE_URL must be an https:// URL");
    exit(2);
  }
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const whatsappUrl = requireEnv("WHATSAPP_WEBHOOK_URL");
  const whatsappTo = requireEnv("WHATSAPP_OPERATOR_NUMBER");
  const whatsappToken = optionalEnv("WHATSAPP_WEBHOOK_TOKEN");
  const whatsappFrom = optionalEnv("WHATSAPP_FROM_NUMBER");

  await upsertProtocolConfig(
    supabaseUrl,
    serviceRoleKey,
    programIdRaw,
    deployedAt,
    verifierNote,
  );
  stdout.write(`==> zettapay_protocol_config upserted (network=${NETWORK})\n`);

  const message = buildMessage(programIdRaw, deploySignature, validated.dataLen);
  await notifyWhatsApp(whatsappUrl, whatsappToken, whatsappTo, whatsappFrom, message);

  stdout.write("==> Z29.4 complete — program LIVE\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  exit(1);
});
