import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  MEMO_PROGRAM_ID,
  buildMemoInstruction,
  encodeMemoPayload,
} from "../src/solana/memo.js";

describe("memo program helpers", () => {
  it("targets canonical memo program v2", () => {
    expect(MEMO_PROGRAM_ID.toBase58()).toBe("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
  });

  it("encodes binding payload as compact JSON", () => {
    const encoded = encodeMemoPayload({
      namespace: "zettapay:merchant_register:v1",
      merchantId: "mid",
      wallet: "WALLET",
      ata: "ATA",
      ts: 100,
    });
    const parsed = JSON.parse(encoded) as Record<string, unknown>;
    expect(parsed).toEqual({
      ns: "zettapay:merchant_register:v1",
      mid: "mid",
      w: "WALLET",
      ata: "ATA",
      ts: 100,
    });
  });

  it("builds an instruction with signer keys", () => {
    const signer = Keypair.generate().publicKey;
    const ix = buildMemoInstruction("hello", [signer]);
    expect(ix.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(ix.keys).toHaveLength(1);
    expect(ix.keys[0]?.isSigner).toBe(true);
    expect(ix.keys[0]?.pubkey.equals(signer)).toBe(true);
    expect(ix.data.toString("utf8")).toBe("hello");
  });
});
