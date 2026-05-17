// DEPRECATED (Z53): quarantined custodial code. Loads EVM_PAYER_PRIVATE_KEY
// and signs ERC-20 transfers on behalf of merchants — violates HR-CUSTODY.
// Replacement: xpub-based per-invoice address derivation (see /api/invoices).
// Do not import. Preserved for git archaeology only.
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  type Account,
  type Address,
  type Hash,
  type PublicClient,
  type Transport,
  type WalletClient,
  type Chain as ViemChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  base,
  baseSepolia,
  polygon,
  polygonAmoy,
} from "viem/chains";
import { HttpError } from "../lib/errors.js";
import {
  DEFAULT_EVM_CURRENCY,
  EVM_CHAIN_REGISTRY,
  resolveEvmToken,
  resolveRpcUrl,
  type EvmChain,
  type EvmCurrency,
  type ResolvedEvmToken,
} from "../lib/chains.js";

/** Minimal ERC-20 ABI — `transfer` is all we need to push USDC to the merchant. */
const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const VIEM_CHAINS: Record<EvmChain, ViemChain> = {
  base,
  "base-sepolia": baseSepolia,
  polygon,
  "polygon-amoy": polygonAmoy,
};

export interface EvmServiceConfig {
  /** Hex-encoded EVM private key used to sign ERC-20 transfers (0x-prefixed). */
  payerPrivateKey?: string | null;
  /** Per-chain RPC URL overrides. Falls back to env, then to `defaultRpcUrl`. */
  rpcOverrides?: Partial<Record<EvmChain, string>>;
  /** Per-chain ERC-20 contract overrides — same precedence as currencies. */
  tokenOverrides?: Partial<Record<EvmChain, Partial<Record<EvmCurrency, string>>>>;
  /** Reads the env at construction time so tests can stub it. */
  env?: Record<string, string | undefined>;
  /**
   * Optional clients-per-chain factory. Tests inject deterministic stubs;
   * production leaves this undefined and we lazily build viem clients.
   */
  clientFactory?: ChainClientFactory;
  /** Block confirmations to wait for before treating a transfer as final. */
  confirmations?: number;
}

export interface EvmTransferParams {
  chain: EvmChain;
  recipient: Address;
  amount: number;
  currency?: EvmCurrency;
}

export interface EvmTransferResult {
  txHash: Hash;
  chain: EvmChain;
  chainId: number;
  payerWallet: Address;
  recipientWallet: Address;
  amountAtomic: bigint;
  decimals: number;
  currency: EvmCurrency;
  contractAddress: Address;
}

export interface EvmChainClients {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, ViemChain, Account>;
}

export type ChainClientFactory = (
  chain: EvmChain,
  account: Account,
  rpcUrl: string,
) => EvmChainClients;

/**
 * Wraps viem `publicClient` + `walletClient` per supported EVM chain. The
 * facilitator account is loaded once from `payerPrivateKey`; each chain's
 * wallet client is bound on first use via `getClients()`. ERC-20 transfers
 * use `writeContract` with the canonical USDC address from the chain
 * registry, mirroring the Solana SPL transfer flow.
 */
export class EvmService {
  private readonly account: Account | null;
  private readonly env: Record<string, string | undefined>;
  private readonly rpcOverrides: Partial<Record<EvmChain, string>>;
  private readonly tokenOverrides: Partial<
    Record<EvmChain, Partial<Record<EvmCurrency, string>>>
  >;
  private readonly clientFactory: ChainClientFactory;
  private readonly confirmations: number;
  private readonly clients = new Map<EvmChain, EvmChainClients>();

  constructor(config: EvmServiceConfig = {}) {
    this.env = config.env ?? process.env;
    this.account = config.payerPrivateKey
      ? loadAccount(config.payerPrivateKey)
      : null;
    this.rpcOverrides = config.rpcOverrides ?? {};
    this.tokenOverrides = config.tokenOverrides ?? {};
    this.clientFactory = config.clientFactory ?? defaultClientFactory;
    this.confirmations = config.confirmations ?? 1;
  }

  /** True when a payer key is configured — endpoints surface 500s otherwise. */
  hasPayer(): boolean {
    return this.account !== null;
  }

  getPayerAddress(): Address {
    if (!this.account) {
      throw HttpError.config(
        "EVM_PAYER_PRIVATE_KEY is not configured — cannot sign EVM transfers",
      );
    }
    return this.account.address;
  }

  resolveToken(chain: EvmChain, currency: EvmCurrency = DEFAULT_EVM_CURRENCY): ResolvedEvmToken {
    return resolveEvmToken({
      chain,
      currency,
      overrides: this.tokenOverrides,
      env: this.env,
    });
  }

  /**
   * Lazily builds (and caches) a viem public + wallet client pair for the
   * given chain. The wallet client is bound to the configured account, so
   * every signed call uses the ZettaPay facilitator key.
   */
  getClients(chain: EvmChain): EvmChainClients {
    if (!this.account) {
      throw HttpError.config(
        "EVM_PAYER_PRIVATE_KEY is not configured — cannot sign EVM transfers",
      );
    }
    const cached = this.clients.get(chain);
    if (cached) return cached;
    const rpcUrl = this.rpcOverrides[chain] ?? resolveRpcUrl(chain, this.env);
    const built = this.clientFactory(chain, this.account, rpcUrl);
    this.clients.set(chain, built);
    return built;
  }

  /**
   * Push the chosen ERC-20 stablecoin to `recipient` on `chain`. Returns the
   * tx hash after the transaction has been confirmed (`confirmations` deep).
   */
  async transferToken(params: EvmTransferParams): Promise<EvmTransferResult> {
    if (!this.account) {
      throw HttpError.config(
        "EVM_PAYER_PRIVATE_KEY is not configured — cannot sign EVM transfers",
      );
    }
    const currency = params.currency ?? DEFAULT_EVM_CURRENCY;
    const token = this.resolveToken(params.chain, currency);
    const amountAtomic = toAtomicEvmAmount(params.amount, token.decimals);

    const { publicClient, walletClient } = this.getClients(params.chain);

    const balance = (await publicClient.readContract({
      address: token.address,
      abi: ERC20_TRANSFER_ABI,
      functionName: "balanceOf",
      args: [this.account.address],
    })) as bigint;
    if (balance < amountAtomic) {
      throw HttpError.paymentFailed(
        `Insufficient ${currency} balance on ${params.chain}`,
        {
          required: amountAtomic.toString(),
          available: balance.toString(),
          currency,
          chain: params.chain,
        },
      );
    }

    const txHash = await walletClient.writeContract({
      address: token.address,
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [params.recipient, amountAtomic],
      account: this.account,
      chain: VIEM_CHAINS[params.chain],
    });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: this.confirmations,
    });
    if (receipt.status !== "success") {
      throw HttpError.paymentFailed(
        `${currency} transfer reverted on ${params.chain}`,
        { txHash, status: receipt.status },
      );
    }

    return {
      txHash,
      chain: params.chain,
      chainId: EVM_CHAIN_REGISTRY[params.chain].chainId,
      payerWallet: this.account.address,
      recipientWallet: params.recipient,
      amountAtomic,
      decimals: token.decimals,
      currency,
      contractAddress: token.address,
    };
  }
}

function loadAccount(secret: string): Account {
  const trimmed = secret.trim();
  const prefixed = trimmed.startsWith("0x")
    ? (trimmed as `0x${string}`)
    : (`0x${trimmed}` as `0x${string}`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(prefixed)) {
    throw HttpError.config(
      "EVM_PAYER_PRIVATE_KEY must be a 32-byte hex string (with or without 0x prefix)",
    );
  }
  try {
    return privateKeyToAccount(prefixed);
  } catch (err) {
    throw HttpError.config(
      `Failed to load EVM payer key: ${(err as Error).message}`,
    );
  }
}

const defaultClientFactory: ChainClientFactory = (chain, account, rpcUrl) => {
  const viemChain = VIEM_CHAINS[chain];
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({
    chain: viemChain,
    transport,
  });
  const walletClient = createWalletClient({
    chain: viemChain,
    transport,
    account,
  });
  return { publicClient, walletClient };
};

/**
 * Decimal token amount → atomic units for ERC-20. Routes through viem's
 * `parseUnits` (string-based) to avoid float drift for small fractions.
 */
export function toAtomicEvmAmount(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw HttpError.badRequest("amount must be a positive finite number");
  }
  const fixed = amount.toFixed(decimals);
  const value = parseUnits(fixed, decimals);
  if (value <= 0n) {
    throw HttpError.badRequest(
      "amount resolves to zero atomic units — increase the amount",
    );
  }
  return value;
}
