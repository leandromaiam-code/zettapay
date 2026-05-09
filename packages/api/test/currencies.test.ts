import { describe, it, expect } from "vitest";
import {
  CURRENCY_REGISTRY,
  DEFAULT_CURRENCY,
  SUPPORTED_CURRENCIES,
  isSupportedCurrency,
  normalizeCurrency,
  resolveMint,
} from "../src/lib/currencies.js";

describe("currency registry", () => {
  it("declares USDC, USDT, EURC, PYUSD as the supported set", () => {
    expect([...SUPPORTED_CURRENCIES].sort()).toEqual(
      ["EURC", "PYUSD", "USDC", "USDT"].sort(),
    );
    for (const symbol of SUPPORTED_CURRENCIES) {
      const def = CURRENCY_REGISTRY[symbol];
      expect(def.symbol).toBe(symbol);
      expect(def.decimals).toBe(6);
      expect(def.mints["mainnet-beta"]).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    }
  });

  it("defaults to USDC", () => {
    expect(DEFAULT_CURRENCY).toBe("USDC");
  });

  it("normalizes input casing and rejects unsupported currencies", () => {
    expect(normalizeCurrency("usdc")).toBe("USDC");
    expect(normalizeCurrency("UsDt")).toBe("USDT");
    expect(normalizeCurrency(null)).toBe("USDC");
    expect(normalizeCurrency(undefined)).toBe("USDC");
    expect(() => normalizeCurrency("DOGE")).toThrow();
  });

  it("isSupportedCurrency only accepts the canonical symbols", () => {
    expect(isSupportedCurrency("USDC")).toBe(true);
    expect(isSupportedCurrency("usdt")).toBe(true);
    expect(isSupportedCurrency("DOGE")).toBe(false);
    expect(isSupportedCurrency(123)).toBe(false);
  });
});

describe("resolveMint", () => {
  it("returns the canonical mainnet mint for each currency", () => {
    const usdc = resolveMint("USDC", { cluster: "mainnet-beta", env: {} });
    expect(usdc.mintAddress).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
    expect(usdc.decimals).toBe(6);

    const usdt = resolveMint("USDT", { cluster: "mainnet-beta", env: {} });
    expect(usdt.mintAddress).toBe(
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    );
  });

  it("returns the canonical devnet USDC mint", () => {
    const usdc = resolveMint("USDC", { cluster: "devnet", env: {} });
    expect(usdc.mintAddress).toBe(
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    );
  });

  it("falls back to env override for currencies without canonical devnet mint", () => {
    const env = {
      ZETTAPAY_USDT_MINT_DEVNET: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    };
    const usdt = resolveMint("USDT", { cluster: "devnet", env });
    expect(usdt.mintAddress).toBe(env.ZETTAPAY_USDT_MINT_DEVNET);
  });

  it("explicit overrides trump env vars and the registry default", () => {
    const env = {
      ZETTAPAY_USDC_MINT_MAINNET: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    };
    const result = resolveMint("USDC", {
      cluster: "mainnet-beta",
      env,
      overrides: { USDC: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
    });
    expect(result.mintAddress).toBe(
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    );
  });

  it("throws config_error when no mint is configured for the cluster", () => {
    expect(() => resolveMint("EURC", { cluster: "devnet", env: {} })).toThrow(
      /No mint configured for EURC on devnet/,
    );
  });

  it("rejects malformed override mint addresses", () => {
    expect(() =>
      resolveMint("USDC", {
        cluster: "mainnet-beta",
        env: {},
        overrides: { USDC: "not-base58!" },
      }),
    ).toThrow(/not a valid base58 Solana public key/);
  });
});
