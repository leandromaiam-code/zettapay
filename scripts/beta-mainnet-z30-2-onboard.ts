/**
 * scripts/beta-mainnet-z30-2-onboard.ts — Z30.2
 *
 * Bulk-onboarding runner for the ZettaPay mainnet beta cohort (Leandro plus
 * five-to-ten friend merchants, 60-day window). Reads a cohort JSON file —
 * see docs/operations/beta-mainnet-z30-2-cohort.template.json — and for each
 * entry POSTs `/merchants/register` against the target API host with an
 * Idempotency-Key. Emits:
 *
 *   1. A JSON report at BETA_REPORT_PATH summarising each registration with
 *      merchant id, masked api key, timing, and any error. Canonical artifact
 *      for the runbook + audit trail.
 *
 *   2. A `BETA_ALLOWED_MERCHANTS=<csv>` line on stdout that the operator
 *      pastes into the production env (Vercel / Render / Fly). Until this
 *      list is updated and the API redeployed, the Z22.1 beta enforcer
 *      rejects the new merchants with `beta:allowlist`.
 *
 * WALLET-LESS: the cohort file MUST contain pubkeys captured offline — no
 * `wallet.connect()` ever happens here. The script never touches a wallet,
 * never opens a browser, never imports `@solana/wallet-adapter`. It just
 * relays the addresses the friend cohort already pasted into the intake
 * form. See CLAUDE.md "HARD RULE — WALLET-LESS ARCHITECTURE".
 *
 * Idempotency: re-running the script with the same cohort file is safe —
 * the API returns 409 conflict for duplicate (email, wallet) pairs, the
 * runner treats that as `already_registered`, and continues. The
 * Idempotency-Key is derived from `cohort.id + entry.email` so concurrent
 * runs collapse.
 *
 * Invocation:
 *
 *   BETA_API_URL=https://api.zettapay.dev \
 *   BETA_COHORT_PATH=./cohort.beta.json \
 *   BETA_REPORT_PATH=./reports/beta-mainnet-z30-2-onboard-$(date +%Y%m%d).json \
 *   npm run beta:mainnet:onboard
 *
 * Environment (all string, none defaulted to a production URL — fail fast
 * when the operator forgets one):
 *
 *   BETA_API_URL          base URL of the ZettaPay API (required, https)
 *   BETA_COHORT_PATH      path to cohort.json (required)
 *   BETA_REPORT_PATH      where to write the JSON report (required)
 *   BETA_DRY_RUN          when "true", skip the network call and emit a
 *                         planned-only report. Useful for sanity-checking
 *                         the cohort file before going live.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { argv, env, exit, stdout } from "node:process";

interface CohortEntry {
  /** Display name shown in dashboards + audit journal. */
  name: string;
  /** Real email — must validate against the API regex. */
  email: string;
  /** Solana pubkey (base58). Captured offline by the merchant, pasted in. */
  walletAddress: string;
  /** Optional https webhook for payment notifications. */
  webhookUrl?: string | null;
  /** Free-form contact channel for the operator (Telegram/WhatsApp/etc). */
  contact?: string | null;
}

interface CohortFile {
  /** Stable cohort identifier — feeds the idempotency key. */
  id: string;
  /** Sprint label, currently "Z30.2 — mainnet beta". */
  sprint: string;
  /** Free-form notes for the runbook. */
  notes?: string;
  merchants: CohortEntry[];
}

interface OnboardOutcome {
  email: string;
  name: string;
  walletAddress: string;
  status: "registered" | "already_registered" | "failed" | "dry_run";
  merchantId: string | null;
  apiKeyMasked: string | null;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
}

interface OnboardReport {
  sprint: string;
  cohortId: string;
  apiUrl: string;
  dryRun: boolean;
  generatedAt: string;
  totals: {
    requested: number;
    registered: number;
    alreadyRegistered: number;
    failed: number;
  };
  betaAllowedMerchants: string;
  outcomes: OnboardOutcome[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HTTPS_RE = /^https:\/\//i;

function requireEnv(name: string): string {
  const value = env[name];
  if (!value || value.trim() === "") {
    console.error(`Missing required env var: ${name}`);
    exit(2);
  }
  return value.trim();
}

function parseCohort(raw: string): CohortFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Cohort file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Cohort file must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.trim() === "") {
    throw new Error('Cohort field "id" must be a non-empty string');
  }
  if (typeof obj.sprint !== "string" || obj.sprint.trim() === "") {
    throw new Error('Cohort field "sprint" must be a non-empty string');
  }
  if (!Array.isArray(obj.merchants)) {
    throw new Error('Cohort field "merchants" must be an array');
  }
  if (obj.merchants.length === 0) {
    throw new Error("Cohort merchants[] is empty — nothing to onboard");
  }
  if (obj.merchants.length > 10) {
    throw new Error(
      `Cohort has ${obj.merchants.length} merchants — exceeds the Z22.1 beta cap of 10`,
    );
  }
  const merchants: CohortEntry[] = obj.merchants.map((entry, idx) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`merchants[${idx}] must be an object`);
    }
    const m = entry as Record<string, unknown>;
    const name = typeof m.name === "string" ? m.name.trim() : "";
    const email = typeof m.email === "string" ? m.email.trim().toLowerCase() : "";
    const walletAddress =
      typeof m.walletAddress === "string" ? m.walletAddress.trim() : "";
    const webhookUrlRaw = m.webhookUrl;
    const contactRaw = m.contact;
    if (name === "") {
      throw new Error(`merchants[${idx}].name is required`);
    }
    if (!EMAIL_RE.test(email)) {
      throw new Error(`merchants[${idx}].email "${email}" is not a valid email`);
    }
    if (!SOLANA_PUBKEY_RE.test(walletAddress)) {
      throw new Error(
        `merchants[${idx}].walletAddress "${walletAddress}" is not a valid Solana pubkey`,
      );
    }
    let webhookUrl: string | null = null;
    if (typeof webhookUrlRaw === "string" && webhookUrlRaw.trim() !== "") {
      const trimmed = webhookUrlRaw.trim();
      if (!HTTPS_RE.test(trimmed)) {
        throw new Error(
          `merchants[${idx}].webhookUrl must be an https:// URL (TLS required)`,
        );
      }
      webhookUrl = trimmed;
    }
    let contact: string | null = null;
    if (typeof contactRaw === "string" && contactRaw.trim() !== "") {
      contact = contactRaw.trim();
    }
    return { name, email, walletAddress, webhookUrl, contact };
  });
  const seenEmails = new Set<string>();
  const seenWallets = new Set<string>();
  for (const m of merchants) {
    if (seenEmails.has(m.email)) {
      throw new Error(`Duplicate email in cohort: ${m.email}`);
    }
    if (seenWallets.has(m.walletAddress)) {
      throw new Error(`Duplicate walletAddress in cohort: ${m.walletAddress}`);
    }
    seenEmails.add(m.email);
    seenWallets.add(m.walletAddress);
  }
  return {
    id: obj.id,
    sprint: obj.sprint,
    notes: typeof obj.notes === "string" ? obj.notes : undefined,
    merchants,
  };
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 12) return apiKey.replace(/.(?=.{4})/g, "*");
  return `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`;
}

interface RegisterResponse {
  merchant?: {
    id?: string;
    apiKey?: string;
  };
  error?: { message?: string; scope?: string };
}

async function registerOne(
  apiUrl: string,
  cohortId: string,
  entry: CohortEntry,
): Promise<OnboardOutcome> {
  const started = Date.now();
  const idempotencyKey = `beta-mainnet-z30-2:${cohortId}:${entry.email}`;
  const payload: Record<string, unknown> = {
    name: entry.name,
    email: entry.email,
    walletAddress: entry.walletAddress,
  };
  if (entry.webhookUrl) payload.webhookUrl = entry.webhookUrl;

  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}/merchants/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    const durationMs = Date.now() - started;
    const httpStatus = res.status;
    const body = (await res.json().catch(() => ({}))) as RegisterResponse;

    if (httpStatus === 201 && body.merchant?.id && body.merchant?.apiKey) {
      return {
        email: entry.email,
        name: entry.name,
        walletAddress: entry.walletAddress,
        status: "registered",
        merchantId: body.merchant.id,
        apiKeyMasked: maskApiKey(body.merchant.apiKey),
        httpStatus,
        error: null,
        durationMs,
      };
    }

    if (httpStatus === 409) {
      return {
        email: entry.email,
        name: entry.name,
        walletAddress: entry.walletAddress,
        status: "already_registered",
        merchantId: null,
        apiKeyMasked: null,
        httpStatus,
        error: body.error?.message ?? "conflict",
        durationMs,
      };
    }

    return {
      email: entry.email,
      name: entry.name,
      walletAddress: entry.walletAddress,
      status: "failed",
      merchantId: null,
      apiKeyMasked: null,
      httpStatus,
      error: body.error?.message ?? `http_${httpStatus}`,
      durationMs,
    };
  } catch (err) {
    return {
      email: entry.email,
      name: entry.name,
      walletAddress: entry.walletAddress,
      status: "failed",
      merchantId: null,
      apiKeyMasked: null,
      httpStatus: null,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}

async function main(): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write(
      [
        "Usage: BETA_API_URL=… BETA_COHORT_PATH=… BETA_REPORT_PATH=… npm run beta:mainnet:onboard",
        "",
        "Bulk-registers the Z30.2 mainnet beta cohort against /merchants/register.",
        "Cohort schema: docs/operations/beta-mainnet-z30-2-cohort.template.json",
      ].join("\n") + "\n",
    );
    return;
  }

  const apiUrl = requireEnv("BETA_API_URL");
  if (!HTTPS_RE.test(apiUrl)) {
    console.error("BETA_API_URL must be an https:// URL");
    exit(2);
  }
  const cohortPath = resolve(requireEnv("BETA_COHORT_PATH"));
  const reportPath = resolve(requireEnv("BETA_REPORT_PATH"));
  const dryRun = (env.BETA_DRY_RUN ?? "").toLowerCase() === "true";

  const raw = await readFile(cohortPath, "utf8");
  const cohort = parseCohort(raw);

  const outcomes: OnboardOutcome[] = [];
  for (const entry of cohort.merchants) {
    if (dryRun) {
      outcomes.push({
        email: entry.email,
        name: entry.name,
        walletAddress: entry.walletAddress,
        status: "dry_run",
        merchantId: null,
        apiKeyMasked: null,
        httpStatus: null,
        error: null,
        durationMs: 0,
      });
      continue;
    }
    const outcome = await registerOne(apiUrl, cohort.id, entry);
    outcomes.push(outcome);
    if (outcome.status === "registered") {
      stdout.write(
        `registered ${entry.email} → ${outcome.merchantId} (api_key=${outcome.apiKeyMasked})\n`,
      );
    } else if (outcome.status === "already_registered") {
      stdout.write(`skipped   ${entry.email} (already registered)\n`);
    } else {
      stdout.write(
        `failed    ${entry.email} http=${outcome.httpStatus ?? "n/a"} err=${outcome.error}\n`,
      );
    }
  }

  const registered = outcomes.filter((o) => o.status === "registered").length;
  const alreadyRegistered = outcomes.filter(
    (o) => o.status === "already_registered",
  ).length;
  const failed = outcomes.filter((o) => o.status === "failed").length;

  const merchantIds = outcomes
    .filter((o) => o.merchantId)
    .map((o) => o.merchantId)
    .join(",");

  const report: OnboardReport = {
    sprint: cohort.sprint,
    cohortId: cohort.id,
    apiUrl,
    dryRun,
    generatedAt: new Date().toISOString(),
    totals: {
      requested: outcomes.length,
      registered,
      alreadyRegistered,
      failed,
    },
    betaAllowedMerchants: merchantIds,
    outcomes,
  };

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  stdout.write(
    [
      "",
      `report written → ${reportPath}`,
      `registered=${registered} already=${alreadyRegistered} failed=${failed}`,
      "",
      "Paste this into BETA_ALLOWED_MERCHANTS env (production):",
      `BETA_ALLOWED_MERCHANTS=${merchantIds}`,
      "",
    ].join("\n"),
  );

  if (failed > 0) exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  exit(1);
});
