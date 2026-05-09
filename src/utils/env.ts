import 'dotenv/config';
import { clusterApiUrl, type Commitment } from '@solana/web3.js';

export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta' | 'localnet';

const ALLOWED_COMMITMENTS: ReadonlyArray<Commitment> = ['processed', 'confirmed', 'finalized'];

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseCluster(raw: string | undefined, fallback: SolanaCluster = 'devnet'): SolanaCluster {
  const value = (raw ?? fallback).toLowerCase();
  switch (value) {
    case 'mainnet':
    case 'mainnet-beta':
      return 'mainnet-beta';
    case 'testnet':
      return 'testnet';
    case 'localnet':
    case 'localhost':
      return 'localnet';
    case 'devnet':
      return 'devnet';
    default:
      throw new Error(
        `Invalid SOLANA_NETWORK="${raw}". Expected one of: mainnet-beta, mainnet, devnet, testnet, localnet.`,
      );
  }
}

function parseCommitment(raw: string | undefined): Commitment {
  if (raw === undefined || raw === '') return 'confirmed';
  if (ALLOWED_COMMITMENTS.includes(raw as Commitment)) return raw as Commitment;
  throw new Error(
    `Invalid SOLANA_COMMITMENT="${raw}". Expected one of: ${ALLOWED_COMMITMENTS.join(', ')}.`,
  );
}

function defaultRpcUrl(cluster: SolanaCluster): string {
  if (cluster === 'localnet') return 'http://127.0.0.1:8899';
  return clusterApiUrl(cluster);
}

// SOLANA_NETWORK is the canonical key; SOLANA_CLUSTER kept as fallback for
// deployments still on the old name.
const cluster = parseCluster(process.env.SOLANA_NETWORK ?? process.env.SOLANA_CLUSTER);

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number.parseInt(process.env.PORT ?? '3000', 10),
  solanaCluster: cluster,
  solanaRpcUrl: required('SOLANA_RPC_URL', defaultRpcUrl(cluster)),
  solanaCommitment: parseCommitment(process.env.SOLANA_COMMITMENT),
  usdcMint: required('USDC_MINT', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
} as const;

export type Env = typeof env;

export function getCluster(): SolanaCluster {
  return env.solanaCluster;
}

export function isMainnet(): boolean {
  return env.solanaCluster === 'mainnet-beta';
}
