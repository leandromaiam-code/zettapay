import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  SOURCE_CHAIN_REGISTRY,
  SUPPORTED_SOURCE_CHAINS,
  SUPPORTED_BRIDGE_CURRENCIES,
  getDestinationConfig,
  getSourceChainConfig,
  isSupportedSourceChain,
  networkForCluster,
  normalizeSourceChain,
} from "../src/bridge/chains.js";

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;

describe("bridge chain registry", () => {
  it("declares Base + Polygon as the supported source set", () => {
    expect([...SUPPORTED_SOURCE_CHAINS].sort()).toEqual(
      ["base", "polygon"].sort(),
    );
  });

  it("only bridges USDC in V1 (premissa I.2)", () => {
    expect([...SUPPORTED_BRIDGE_CURRENCIES]).toEqual(["USDC"]);
  });

  it("registry entries have valid EVM addresses + CCTP domains", () => {
    for (const chain of SUPPORTED_SOURCE_CHAINS) {
      for (const network of ["mainnet", "testnet"] as const) {
        const cfg = SOURCE_CHAIN_REGISTRY[chain][network];
        expect(cfg.usdcTokenAddress).toMatch(EVM_ADDR);
        expect(cfg.tokenMessengerAddress).toMatch(EVM_ADDR);
        expect(cfg.messageTransmitterAddress).toMatch(EVM_ADDR);
        expect(cfg.cctpDomain).toBeGreaterThanOrEqual(0);
        expect(cfg.evmChainId).toBeGreaterThan(0);
        expect(cfg.wormholeChainId).toBeGreaterThan(0);
      }
    }
  });

  it("Solana destination uses CCTP domain 5 on both networks", () => {
    expect(getDestinationConfig("mainnet").cctpDomain).toBe(5);
    expect(getDestinationConfig("testnet").cctpDomain).toBe(5);
    expect(getDestinationConfig("mainnet").wormholeChainId).toBe(1);
  });

  it("destination program ids decode as valid Solana pubkeys", () => {
    const mainnet = getDestinationConfig("mainnet");
    expect(() => new PublicKey(mainnet.messageTransmitterProgramId)).not.toThrow();
    expect(() => new PublicKey(mainnet.tokenMessengerProgramId)).not.toThrow();
  });

  it("normalizes chain casing and rejects unknown chains", () => {
    expect(normalizeSourceChain("BASE")).toBe("base");
    expect(normalizeSourceChain("Polygon")).toBe("polygon");
    expect(() => normalizeSourceChain("ethereum")).toThrow(/Unsupported source chain/);
  });

  it("isSupportedSourceChain narrows the type", () => {
    expect(isSupportedSourceChain("base")).toBe(true);
    expect(isSupportedSourceChain("BASE")).toBe(true);
    expect(isSupportedSourceChain(42)).toBe(false);
    expect(isSupportedSourceChain("solana")).toBe(false);
  });

  it("locks bridge network class to the Solana cluster", () => {
    expect(networkForCluster("mainnet-beta")).toBe("mainnet");
    expect(networkForCluster("devnet")).toBe("testnet");
    expect(networkForCluster("testnet")).toBe("testnet");
    expect(networkForCluster("localnet")).toBe("testnet");
  });

  it("getSourceChainConfig returns the right network bucket", () => {
    const baseMainnet = getSourceChainConfig("base", "mainnet");
    const baseTestnet = getSourceChainConfig("base", "testnet");
    expect(baseMainnet.evmChainId).toBe(8453);
    expect(baseTestnet.evmChainId).toBe(84532);
    expect(baseMainnet.cctpDomain).toBe(baseTestnet.cctpDomain);
  });
});
