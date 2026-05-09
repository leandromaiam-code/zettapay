import { Connection, PublicKey } from '@solana/web3.js';
import { env, getCluster } from '../utils/env.js';

export { getCluster, isMainnet } from '../utils/env.js';

let connection: Connection | null = null;

export function getConnection(): Connection {
  if (connection !== null) return connection;
  connection = new Connection(env.solanaRpcUrl, env.solanaCommitment);
  return connection;
}

export function resetConnectionForTests(): void {
  connection = null;
}

export function getUsdcMint(): PublicKey {
  return new PublicKey(env.usdcMint);
}

export async function getClusterHealth(): Promise<{
  cluster: string;
  endpoint: string;
  commitment: string;
  blockHeight: number;
  version: string;
}> {
  const conn = getConnection();
  const [blockHeight, versionInfo] = await Promise.all([
    conn.getBlockHeight(),
    conn.getVersion(),
  ]);
  return {
    cluster: getCluster(),
    endpoint: conn.rpcEndpoint,
    commitment: env.solanaCommitment,
    blockHeight,
    version: versionInfo['solana-core'],
  };
}
