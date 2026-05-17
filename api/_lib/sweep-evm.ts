// Z51 — EVM USDC consolidation. Sweeps the USDC balance from the per-invoice
// derived address into EVM_TREASURY_ADDRESS via viem. Gas is paid from the
// invoice address's own native balance (the deriveNext hook in Z45 pre-funds
// ~$0.30 of native gas), so we transfer the full ERC-20 balance and let any
// residual native value sit until the next eviction sweep.

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Chain,
  type Hex,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, mainnet, polygon } from 'viem/chains';
import { deriveChildPrivateKey } from './sweep-derive.js';
import type { SweeperOutcome } from './sweep-types.js';

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

interface ChainSpec {
  viem: Chain;
  usdc: Address;
  rpcUrl: string;
}

function chainSpec(chain: 'base' | 'polygon' | 'ethereum'): ChainSpec | null {
  switch (chain) {
    case 'base':
      return {
        viem: base,
        usdc: (process.env.USDC_BASE_ADDRESS as Address | undefined) ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        rpcUrl: process.env.BASE_RPC_URL?.trim() ?? 'https://mainnet.base.org',
      };
    case 'polygon':
      return {
        viem: polygon,
        usdc: (process.env.USDC_POLYGON_ADDRESS as Address | undefined) ?? '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        rpcUrl: process.env.POLYGON_RPC_URL?.trim() ?? 'https://polygon-rpc.com',
      };
    case 'ethereum':
      return {
        viem: mainnet,
        usdc: (process.env.USDC_ETHEREUM_ADDRESS as Address | undefined) ?? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        rpcUrl: process.env.ETHEREUM_RPC_URL?.trim() ?? 'https://eth.llamarpc.com',
      };
  }
}

export async function sweepEvmUsdc(args: {
  chain: 'base' | 'polygon' | 'ethereum';
  derivationPath: string;
  fromAddress: string;
  treasuryAddress: string;
}): Promise<SweeperOutcome> {
  const spec = chainSpec(args.chain);
  if (!spec) return { kind: 'failed', reason: `unsupported chain ${args.chain}` };

  let privateKey: Uint8Array;
  try {
    privateKey = deriveChildPrivateKey(args.derivationPath);
  } catch (err) {
    return { kind: 'failed', reason: errorMessage(err) };
  }
  const pkHex = `0x${Buffer.from(privateKey).toString('hex')}` as Hex;
  const account = privateKeyToAccount(pkHex);
  if (account.address.toLowerCase() !== args.fromAddress.toLowerCase()) {
    return {
      kind: 'failed',
      reason: `derived address mismatch (expected ${args.fromAddress}, got ${account.address})`,
    };
  }

  const transport = http(spec.rpcUrl);
  const publicClient = createPublicClient({ chain: spec.viem, transport });
  const walletClient: WalletClient = createWalletClient({
    account,
    chain: spec.viem,
    transport,
  });

  const balance = (await publicClient.readContract({
    address: spec.usdc,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint;
  if (balance === 0n) {
    return { kind: 'skipped', reason: 'USDC balance is zero' };
  }

  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [args.treasuryAddress as Address, balance],
  });

  try {
    const txHash = await walletClient.sendTransaction({
      account,
      chain: spec.viem,
      to: spec.usdc,
      data,
      value: 0n,
    });
    return { kind: 'swept', txHash };
  } catch (err) {
    return { kind: 'failed', reason: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
