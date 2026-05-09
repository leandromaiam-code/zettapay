import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { env } from '../utils/env.js';

let connection: Connection | null = null;

export function getConnection(): Connection {
  if (connection !== null) return connection;
  const endpoint = env.solanaRpcUrl || clusterApiUrl(env.solanaCluster);
  connection = new Connection(endpoint, 'confirmed');
  return connection;
}

export function getUsdcMint(): PublicKey {
  return new PublicKey(env.usdcMint);
}

export async function getClusterHealth(): Promise<{
  cluster: string;
  endpoint: string;
  blockHeight: number;
  version: string;
}> {
  const conn = getConnection();
  const [blockHeight, versionInfo] = await Promise.all([
    conn.getBlockHeight(),
    conn.getVersion(),
  ]);
  return {
    cluster: env.solanaCluster,
    endpoint: conn.rpcEndpoint,
    blockHeight,
    version: versionInfo['solana-core'],
  };
}
