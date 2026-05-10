import { describe, it, expect } from "vitest";
import {
  EVM_CHAIN_REGISTRY,
  SUPPORTED_EVM_CHAINS,
  DEFAULT_EVM_CURRENCY,
  isHexAddress,
  isSupportedEvmChain,
  normalizeEvmChain,
  resolveEvmToken,
  resolveRpcUrl,
} from "../src/lib/chains.js";

describe("EVM chain registry", () => {
  it("declares the canonical Base + Polygon chains (mainnet + testnet)", () => {
    expect([...SUPPORTED_EVM_CHAINS].sort()).toEqual(
      ["base", "base-sepolia", "polygon", "polygon-amoy"].sort(),
    );
    for (const chain of SUPPORTED_EVM_CHAINS) {
      const def = EVM_CHAIN_REGISTRY[chain];
      expect(def.id).toBe(chain);
      expect(def.tokens.USDC.symbol).toBe("USDC");
      expect(def.tokens.USDC.decimals).toBe(6);
      expect(isHexAddress(def.tokens.USDC.address)).toBe(true);
    }
  });

  it("uses the canonical EIP-155 chain IDs", () => {
    expect(EVM_CHAIN_REGISTRY.base.chainId).toBe(8453);
    expect(EVM_CHAIN_REGISTRY["base-sepolia"].chainId).toBe(84532);
    expect(EVM_CHAIN_REGISTRY.polygon.chainId).toBe(137);
    expect(EVM_CHAIN_REGISTRY["polygon-amoy"].chainId).toBe(80002);
  });

  it("flags testnets so mainnet gating can fail-closed", () => {
    expect(EVM_CHAIN_REGISTRY.base.testnet).toBe(false);
    expect(EVM_CHAIN_REGISTRY.polygon.testnet).toBe(false);
    expect(EVM_CHAIN_REGISTRY["base-sepolia"].testnet).toBe(true);
    expect(EVM_CHAIN_REGISTRY["polygon-amoy"].testnet).toBe(true);
  });

  it("defaults to USDC", () => {
    expect(DEFAULT_EVM_CURRENCY).toBe("USDC");
  });

  it("normalizes chain casing and rejects unsupported chains", () => {
    expect(normalizeEvmChain("Base")).toBe("base");
    expect(normalizeEvmChain("POLYGON")).toBe("polygon");
    expect(() => normalizeEvmChain(null)).toThrow();
    expect(() => normalizeEvmChain("ethereum")).toThrow();
  });

  it("isSupportedEvmChain only accepts the canonical slugs", () => {
    expect(isSupportedEvmChain("base")).toBe(true);
    expect(isSupportedEvmChain("polygon")).toBe(true);
    expect(isSupportedEvmChain("ethereum")).toBe(false);
    expect(isSupportedEvmChain(123)).toBe(false);
  });

  it("isHexAddress only accepts 0x-prefixed 20-byte hex strings", () => {
    expect(isHexAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).toBe(
      true,
    );
    expect(isHexAddress("0x00")).toBe(false);
    expect(isHexAddress("833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).toBe(false);
    expect(isHexAddress(null)).toBe(false);
  });
});

describe("resolveEvmToken", () => {
  it("returns the canonical address by default", () => {
    const token = resolveEvmToken({ chain: "base" });
    expect(token.address).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(token.decimals).toBe(6);
    expect(token.currency).toBe("USDC");
    expect(token.chain).toBe("base");
  });

  it("env override beats the registry but loses to explicit overrides", () => {
    const fromEnv = resolveEvmToken({
      chain: "polygon",
      env: { ZETTAPAY_POLYGON_USDC: "0x1111111111111111111111111111111111111111" },
    });
    expect(fromEnv.address).toBe(
      "0x1111111111111111111111111111111111111111",
    );

    const explicit = resolveEvmToken({
      chain: "polygon",
      env: { ZETTAPAY_POLYGON_USDC: "0x1111111111111111111111111111111111111111" },
      overrides: {
        polygon: { USDC: "0x2222222222222222222222222222222222222222" },
      },
    });
    expect(explicit.address).toBe(
      "0x2222222222222222222222222222222222222222",
    );
  });

  it("rejects malformed override addresses with a config error", () => {
    expect(() =>
      resolveEvmToken({
        chain: "base",
        overrides: { base: { USDC: "not-an-address" } },
      }),
    ).toThrow(/not a valid 0x-prefixed/);
  });
});

describe("resolveRpcUrl", () => {
  it("returns the default RPC when no env override is set", () => {
    expect(resolveRpcUrl("base", {})).toBe("https://mainnet.base.org");
    expect(resolveRpcUrl("polygon", {})).toBe("https://polygon-rpc.com");
  });

  it("env override takes precedence", () => {
    const url = resolveRpcUrl("base", {
      ZETTAPAY_BASE_RPC_URL: "https://custom.example",
    });
    expect(url).toBe("https://custom.example");
  });
});
