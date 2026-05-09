import { Commitment } from "@solana/web3.js";

export interface AppEnv {
  port: number;
  nodeEnv: "development" | "test" | "production";
  solanaRpcUrl: string;
  solanaCommitment: Commitment;
  usdcMintAddress: string;
  payerSecretKey: string | null;
  databasePath: string;
  webhookDispatchUrl: string | null;
}

const ALLOWED_COMMITMENTS: Commitment[] = [
  "processed",
  "confirmed",
  "finalized",
];

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric env var ${name}=${raw}`);
  }
  return parsed;
}

function readEnum<T extends string>(
  name: string,
  fallback: T,
  allowed: readonly T[],
): T {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!allowed.includes(raw as T)) {
    throw new Error(
      `Invalid env var ${name}=${raw}. Expected one of: ${allowed.join(", ")}`,
    );
  }
  return raw as T;
}

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw;
}

function readOptional(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  return raw;
}

export function loadEnv(): AppEnv {
  return {
    port: readNumber("PORT", 4000),
    nodeEnv: readEnum<"development" | "test" | "production">(
      "NODE_ENV",
      "development",
      ["development", "test", "production"] as const,
    ),
    solanaRpcUrl: readString("SOLANA_RPC_URL", "https://api.devnet.solana.com"),
    solanaCommitment: readEnum<Commitment>(
      "SOLANA_COMMITMENT",
      "confirmed",
      ALLOWED_COMMITMENTS,
    ),
    usdcMintAddress: readString(
      "USDC_MINT_ADDRESS",
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    ),
    payerSecretKey: readOptional("PAYER_SECRET_KEY"),
    databasePath: readString("DATABASE_PATH", "./data/zettapay.db"),
    webhookDispatchUrl: readOptional("WEBHOOK_DISPATCH_URL"),
  };
}
