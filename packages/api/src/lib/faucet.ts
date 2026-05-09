import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import type { SolanaConnectionService } from "./solana.js";

export class FaucetUnavailableError extends Error {
  constructor(network: string) {
    super(`Faucet airdrops are only available on devnet/testnet (got "${network}").`);
    this.name = "FaucetUnavailableError";
  }
}

export class FaucetLimitError extends Error {
  constructor(requested: number, max: number) {
    super(
      `Requested airdrop ${requested} lamports exceeds limit of ${max}. Reduce the amount or split across calls.`,
    );
    this.name = "FaucetLimitError";
  }
}

export interface AirdropOptions {
  /** Lamports to request. Defaults to 1 SOL. */
  lamports?: number;
  /** Hard cap to prevent runaway requests. */
  maxLamports: number;
}

export interface AirdropResult {
  signature: string;
  lamports: number;
  recipient: string;
  network: string;
  rpcUrl: string;
}

export async function requestAirdrop(
  service: SolanaConnectionService,
  recipient: string | PublicKey,
  opts: AirdropOptions,
): Promise<AirdropResult> {
  if (service.network === "mainnet-beta") {
    throw new FaucetUnavailableError(service.network);
  }
  const lamports = opts.lamports ?? LAMPORTS_PER_SOL;
  if (!Number.isInteger(lamports) || lamports <= 0) {
    throw new Error(`Invalid airdrop amount: ${lamports}. Expected a positive integer.`);
  }
  if (lamports > opts.maxLamports) {
    throw new FaucetLimitError(lamports, opts.maxLamports);
  }

  const pubkey = recipient instanceof PublicKey ? recipient : new PublicKey(recipient);

  const signature = await service.withRetry((conn) =>
    conn.requestAirdrop(pubkey, lamports),
  );

  await service.withRetry(async (conn) => {
    const latest = await conn.getLatestBlockhash();
    const result = await conn.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      "confirmed",
    );
    if (result.value.err) {
      throw new Error(
        `Airdrop confirmation failed: ${JSON.stringify(result.value.err)}`,
      );
    }
    return result;
  });

  return {
    signature,
    lamports,
    recipient: pubkey.toBase58(),
    network: service.network,
    rpcUrl: service.rpcUrl,
  };
}
