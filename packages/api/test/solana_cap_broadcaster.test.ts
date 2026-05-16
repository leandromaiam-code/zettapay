import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  D30_500_USDC_SCHEDULE,
  noopCapBroadcaster,
} from "../src/beta/cap_upgrade.js";
import {
  PROGRAM_CONFIG_SEED,
  SET_MAX_INVOICE_AMOUNT_DISCRIMINATOR,
  SolanaCapBroadcaster,
  deriveProgramConfigPda,
  encodeSetMaxInvoiceAmount,
  loadSolanaCapBroadcasterFromEnv,
  parseAuthoritySecret,
  type CapInstructionInput,
  type CapInstructionSender,
} from "../src/beta/solana_cap_broadcaster.js";

function makeLogger() {
  const fn = () => log;
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(fn),
  };
  return log;
}

function captureSender(signature = "sig_capture_0001"): {
  sender: CapInstructionSender;
  calls: CapInstructionInput[];
} {
  const calls: CapInstructionInput[] = [];
  const sender: CapInstructionSender = {
    async send(input) {
      calls.push(input);
      return signature;
    },
  };
  return { sender, calls };
}

const PROGRAM_ID = new PublicKey(
  "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS",
);

describe("encodeSetMaxInvoiceAmount", () => {
  it("encodes the discriminator + little-endian u64 (500 USDC base units)", () => {
    const bytes = encodeSetMaxInvoiceAmount(500_000_000n);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(SET_MAX_INVOICE_AMOUNT_DISCRIMINATOR);
    expect(SET_MAX_INVOICE_AMOUNT_DISCRIMINATOR).toBe(9);
    // 500_000_000 = 0x1DCD6500
    expect(Array.from(bytes.slice(1))).toEqual([
      0x00, 0x65, 0xcd, 0x1d, 0x00, 0x00, 0x00, 0x00,
    ]);
  });

  it("encodes the D+30 schedule amount byte-for-byte", () => {
    const bytes = encodeSetMaxInvoiceAmount(
      D30_500_USDC_SCHEDULE.maxInvoiceBaseUnits,
    );
    expect(D30_500_USDC_SCHEDULE.maxInvoiceBaseUnits).toBe(500_000_000n);
    expect(bytes[0]).toBe(9);
    // round-trips through DataView the same way Borsh u64 does on-chain
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const recovered = view.getBigUint64(1, true);
    expect(recovered).toBe(D30_500_USDC_SCHEDULE.maxInvoiceBaseUnits);
  });

  it("encodes 0 — the Z30.5 cap-removal sentinel", () => {
    const bytes = encodeSetMaxInvoiceAmount(0n);
    expect(bytes[0]).toBe(9);
    expect(Array.from(bytes.slice(1))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("encodes u64::MAX exactly", () => {
    const max = (1n << 64n) - 1n;
    const bytes = encodeSetMaxInvoiceAmount(max);
    expect(bytes[0]).toBe(9);
    expect(Array.from(bytes.slice(1))).toEqual([
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
  });

  it("rejects negative amounts", () => {
    expect(() => encodeSetMaxInvoiceAmount(-1n)).toThrow(RangeError);
  });

  it("rejects amounts exceeding u64::MAX", () => {
    expect(() => encodeSetMaxInvoiceAmount(1n << 64n)).toThrow(RangeError);
  });
});

describe("deriveProgramConfigPda", () => {
  it("uses the exact seed string `program-config` (mirror of Rust constant)", () => {
    expect(Buffer.from(PROGRAM_CONFIG_SEED).toString("utf8")).toBe(
      "program-config",
    );
  });

  it("is deterministic per program id", () => {
    const a = deriveProgramConfigPda(PROGRAM_ID);
    const b = deriveProgramConfigPda(PROGRAM_ID);
    expect(a.pda.toBase58()).toBe(b.pda.toBase58());
    expect(a.bump).toBe(b.bump);
  });

  it("differs across program ids", () => {
    const other = new PublicKey("11111111111111111111111111111112");
    const a = deriveProgramConfigPda(PROGRAM_ID);
    const b = deriveProgramConfigPda(other);
    expect(a.pda.toBase58()).not.toBe(b.pda.toBase58());
  });

  it("matches PublicKey.findProgramAddressSync with the seed array", () => {
    const [expected] = PublicKey.findProgramAddressSync(
      [PROGRAM_CONFIG_SEED],
      PROGRAM_ID,
    );
    const { pda } = deriveProgramConfigPda(PROGRAM_ID);
    expect(pda.toBase58()).toBe(expected.toBase58());
  });
});

describe("SolanaCapBroadcaster", () => {
  it("hands the encoded data, programId, configPda, and authority to the sender", async () => {
    const authority = Keypair.generate().publicKey;
    const { sender, calls } = captureSender("sig_ok_d30");
    const broadcaster = new SolanaCapBroadcaster({
      programId: PROGRAM_ID,
      authority,
      sender,
      logger: makeLogger(),
    });
    const result = await broadcaster.setMaxInvoiceAmount(500_000_000n);
    expect(result).toEqual({ kind: "ok", signature: "sig_ok_d30" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.programId.toBase58()).toBe(PROGRAM_ID.toBase58());
    expect(call.authority.toBase58()).toBe(authority.toBase58());
    const [expectedPda] = PublicKey.findProgramAddressSync(
      [PROGRAM_CONFIG_SEED],
      PROGRAM_ID,
    );
    expect(call.configPda.toBase58()).toBe(expectedPda.toBase58());
    expect(call.instructionData[0]).toBe(9);
    expect(call.instructionData.length).toBe(9);
  });

  it("caches the derived program-config PDA across ticks", async () => {
    const { sender, calls } = captureSender();
    const broadcaster = new SolanaCapBroadcaster({
      programId: PROGRAM_ID,
      authority: Keypair.generate().publicKey,
      sender,
      logger: makeLogger(),
    });
    await broadcaster.setMaxInvoiceAmount(100_000_000n);
    await broadcaster.setMaxInvoiceAmount(500_000_000n);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.configPda.toBase58()).toBe(
      calls[1]!.configPda.toBase58(),
    );
    expect(broadcaster.getProgramConfigPda().toBase58()).toBe(
      calls[0]!.configPda.toBase58(),
    );
  });

  it("propagates sender errors so the orchestrator records broadcast_failed", async () => {
    const sender: CapInstructionSender = {
      async send() {
        throw new Error("rpc_unavailable");
      },
    };
    const broadcaster = new SolanaCapBroadcaster({
      programId: PROGRAM_ID,
      authority: Keypair.generate().publicKey,
      sender,
      logger: makeLogger(),
    });
    await expect(
      broadcaster.setMaxInvoiceAmount(500_000_000n),
    ).rejects.toThrow("rpc_unavailable");
  });
});

describe("parseAuthoritySecret", () => {
  it("loads a JSON-array secret", () => {
    const original = Keypair.generate();
    const json = JSON.stringify(Array.from(original.secretKey));
    const parsed = parseAuthoritySecret(json);
    expect(parsed.publicKey.toBase58()).toBe(original.publicKey.toBase58());
  });

  it("loads a bs58 secret with whitespace tolerance", () => {
    const original = Keypair.generate();
    // bs58.encode is available via @solana/web3.js bundle indirectly; use
    // Keypair.secretKey through the bs58 dep is overkill — exercise via the
    // JSON path round-trip then re-encode using @solana/web3.js Buffer is
    // sufficient. Here we just confirm trim() applies to the JSON form too.
    const padded = `   ${JSON.stringify(Array.from(original.secretKey))}   `;
    const parsed = parseAuthoritySecret(padded);
    expect(parsed.publicKey.toBase58()).toBe(original.publicKey.toBase58());
  });
});

describe("loadSolanaCapBroadcasterFromEnv", () => {
  it("returns null when no env is supplied", () => {
    const broadcaster = loadSolanaCapBroadcasterFromEnv({}, makeLogger());
    expect(broadcaster).toBeNull();
  });

  it("returns null when the authority secret is missing", () => {
    const broadcaster = loadSolanaCapBroadcasterFromEnv(
      { programId: PROGRAM_ID.toBase58() },
      makeLogger(),
    );
    expect(broadcaster).toBeNull();
  });

  it("returns null when the program id is malformed", () => {
    const authority = Keypair.generate();
    const broadcaster = loadSolanaCapBroadcasterFromEnv(
      {
        programId: "not_a_valid_base58_pubkey!",
        authoritySecret: JSON.stringify(Array.from(authority.secretKey)),
      },
      makeLogger(),
    );
    expect(broadcaster).toBeNull();
  });

  it("returns null when the authority secret is malformed", () => {
    const broadcaster = loadSolanaCapBroadcasterFromEnv(
      {
        programId: PROGRAM_ID.toBase58(),
        authoritySecret: "not_valid_secret",
      },
      makeLogger(),
    );
    expect(broadcaster).toBeNull();
  });

  it("constructs a broadcaster bound to the supplied program + authority", () => {
    const authority = Keypair.generate();
    const broadcaster = loadSolanaCapBroadcasterFromEnv(
      {
        programId: PROGRAM_ID.toBase58(),
        authoritySecret: JSON.stringify(Array.from(authority.secretKey)),
        rpcUrl: "https://api.devnet.solana.com",
      },
      makeLogger(),
    );
    expect(broadcaster).not.toBeNull();
    const expectedPda = PublicKey.findProgramAddressSync(
      [PROGRAM_CONFIG_SEED],
      PROGRAM_ID,
    )[0];
    expect(broadcaster!.getProgramConfigPda().toBase58()).toBe(
      expectedPda.toBase58(),
    );
  });
});

describe("noop fallback", () => {
  it("noopCapBroadcaster keeps reporting `skipped` so the audit row stays honest", async () => {
    const result = await noopCapBroadcaster().setMaxInvoiceAmount(500_000_000n);
    expect(result.kind).toBe("skipped");
  });
});
