import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type Commitment,
} from "@solana/web3.js";
import bs58 from "bs58";
import type {
  CapBroadcastResult,
  CapBroadcaster,
} from "./cap_upgrade.js";
import { logger as defaultLogger, type Logger } from "../lib/logger.js";

/**
 * Z30.4 — Real Solana implementation of `CapBroadcaster`.
 *
 * Mirrors the on-chain `process_set_max_invoice_amount` handler defined in
 * `programs/zettapay-core/src/lib.rs` (instruction tag `9`, Z30.1):
 *
 *   data    = [9, ...u64_le(max_invoice_amount)]      (9 bytes)
 *   account 0 = ProgramConfig PDA               (writable, NOT signer)
 *   account 1 = authority recorded at init_program_config (signer, NOT writable)
 *
 * The PDA derivation seed (`program-config`) must match the on-chain
 * constant `PROGRAM_CONFIG_SEED` in `programs/zettapay-core/src/pda.rs`.
 * Any drift here silently routes the cap update at a different account that
 * the program does not own, so the seed is asserted in the unit tests.
 *
 * Wallet-less canon: the authority signer is loaded server-side from an
 * env-supplied secret (bs58 or JSON array). No browser wallet handshake, no
 * window-level access, no extension prompt — this code only runs in the cron
 * worker, never in the merchant or customer UI.
 */

/** Mirror of `PROGRAM_CONFIG_SEED` in `programs/zettapay-core/src/pda.rs`. */
export const PROGRAM_CONFIG_SEED = Buffer.from("program-config", "utf8");

/** Mirror of `InstructionTag::SetMaxInvoiceAmount = 9` in the Rust program. */
export const SET_MAX_INVOICE_AMOUNT_DISCRIMINATOR = 9;

/** Borsh-encoded `u64` upper bound — 2^64 - 1. */
const U64_MAX = (1n << 64n) - 1n;

export interface CapInstructionInput {
  instructionData: Uint8Array;
  programId: PublicKey;
  configPda: PublicKey;
  authority: PublicKey;
}

/**
 * Sends the prebuilt `set_max_invoice_amount` instruction. Extracted from the
 * broadcaster so the orchestrator can be unit-tested without a real Solana
 * RPC — production wires this to `sendAndConfirmTransaction`, tests inject a
 * fake that captures the call.
 */
export interface CapInstructionSender {
  send(input: CapInstructionInput): Promise<string>;
}

export interface SolanaCapBroadcasterDeps {
  programId: PublicKey;
  authority: PublicKey;
  sender: CapInstructionSender;
  logger?: Logger;
}

/**
 * Derives the singleton `ProgramConfig` PDA for the given core program id.
 * Cached at construction time on the broadcaster instance to avoid re-running
 * the find loop per tick.
 */
export function deriveProgramConfigPda(programId: PublicKey): {
  pda: PublicKey;
  bump: number;
} {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [PROGRAM_CONFIG_SEED],
    programId,
  );
  return { pda, bump };
}

/**
 * Encode the instruction data for `set_max_invoice_amount`:
 * one discriminator byte followed by an 8-byte little-endian u64.
 */
export function encodeSetMaxInvoiceAmount(amountBaseUnits: bigint): Uint8Array {
  if (amountBaseUnits < 0n) {
    throw new RangeError(
      `cap amount must be non-negative, got ${amountBaseUnits}`,
    );
  }
  if (amountBaseUnits > U64_MAX) {
    throw new RangeError(
      `cap amount ${amountBaseUnits} exceeds u64::MAX (${U64_MAX})`,
    );
  }
  const buf = new Uint8Array(9);
  buf[0] = SET_MAX_INVOICE_AMOUNT_DISCRIMINATOR;
  let v = amountBaseUnits;
  for (let i = 1; i < 9; i += 1) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * Real Solana broadcaster — builds the `set_max_invoice_amount` instruction
 * and hands it to `sender`. Designed so the orchestrator never sees a `null`
 * `CapBroadcaster`: when env credentials are missing the worker keeps the
 * `noopCapBroadcaster` (see `loadSolanaCapBroadcasterFromEnv`).
 */
export class SolanaCapBroadcaster implements CapBroadcaster {
  private readonly programId: PublicKey;
  private readonly authority: PublicKey;
  private readonly configPda: PublicKey;
  private readonly sender: CapInstructionSender;
  private readonly log: Logger;

  constructor(deps: SolanaCapBroadcasterDeps) {
    this.programId = deps.programId;
    this.authority = deps.authority;
    this.configPda = deriveProgramConfigPda(deps.programId).pda;
    this.sender = deps.sender;
    this.log = deps.logger ?? defaultLogger;
  }

  getProgramConfigPda(): PublicKey {
    return this.configPda;
  }

  async setMaxInvoiceAmount(
    amountBaseUnits: bigint,
  ): Promise<CapBroadcastResult> {
    const data = encodeSetMaxInvoiceAmount(amountBaseUnits);
    this.log.info("cap_upgrade.solana.broadcast", {
      amountBaseUnits: amountBaseUnits.toString(),
      programId: this.programId.toBase58(),
      authority: this.authority.toBase58(),
      configPda: this.configPda.toBase58(),
    });
    const signature = await this.sender.send({
      instructionData: data,
      programId: this.programId,
      configPda: this.configPda,
      authority: this.authority,
    });
    return { kind: "ok", signature };
  }
}

/**
 * Production sender — wraps a `Connection` + authority `Keypair` and submits
 * via `sendAndConfirmTransaction`. The two account metas are fixed by the
 * on-chain handler (config PDA writable, authority signer) so we encode that
 * shape directly here rather than letting callers reorder it.
 */
export function rpcCapInstructionSender(opts: {
  connection: Connection;
  authority: Keypair;
  commitment?: Commitment;
}): CapInstructionSender {
  return {
    async send(input) {
      const ix = new TransactionInstruction({
        programId: input.programId,
        keys: [
          { pubkey: input.configPda, isSigner: false, isWritable: true },
          { pubkey: input.authority, isSigner: true, isWritable: false },
        ],
        data: Buffer.from(input.instructionData),
      });
      const tx = new Transaction().add(ix);
      return sendAndConfirmTransaction(opts.connection, tx, [opts.authority], {
        commitment: opts.commitment ?? "confirmed",
      });
    },
  };
}

/**
 * Parse a Solana secret in either bs58 or JSON-array format. Matches the
 * convention used by `SolanaService.loadKeypair` so operators can reuse the
 * same secret material for both fee-payer and cap-upgrade authority.
 */
export function parseAuthoritySecret(secret: string): Keypair {
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

export interface SolanaCapBroadcasterEnv {
  programId?: string | undefined;
  rpcUrl?: string | undefined;
  commitment?: Commitment | undefined;
  authoritySecret?: string | undefined;
}

/**
 * Construct a `SolanaCapBroadcaster` from env vars, or return `null` if any
 * required value is missing. Required:
 *
 *   ZETTAPAY_CORE_PROGRAM_ID         — base58 deployed program id
 *   CAP_UPGRADE_AUTHORITY_SECRET     — bs58 or JSON array secret of the
 *                                       authority recorded at
 *                                       `init_program_config` time
 *
 * Optional (with sensible fallbacks):
 *
 *   SOLANA_RPC_URL                   — defaults to devnet
 *   SOLANA_COMMITMENT                — defaults to "confirmed"
 */
export function loadSolanaCapBroadcasterFromEnv(
  env: SolanaCapBroadcasterEnv = readBroadcasterEnv(),
  logger?: Logger,
): SolanaCapBroadcaster | null {
  const log = logger ?? defaultLogger;
  if (!env.programId || !env.authoritySecret) {
    log.info("cap_upgrade.solana.env_incomplete", {
      hasProgramId: Boolean(env.programId),
      hasAuthoritySecret: Boolean(env.authoritySecret),
    });
    return null;
  }
  let programId: PublicKey;
  try {
    programId = new PublicKey(env.programId);
  } catch (err) {
    log.error("cap_upgrade.solana.bad_program_id", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  let authority: Keypair;
  try {
    authority = parseAuthoritySecret(env.authoritySecret);
  } catch (err) {
    log.error("cap_upgrade.solana.bad_authority_secret", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const connection = new Connection(
    env.rpcUrl ?? "https://api.devnet.solana.com",
    env.commitment ?? "confirmed",
  );
  const sender = rpcCapInstructionSender({
    connection,
    authority,
    commitment: env.commitment ?? "confirmed",
  });
  return new SolanaCapBroadcaster({
    programId,
    authority: authority.publicKey,
    sender,
    logger: log,
  });
}

function readBroadcasterEnv(): SolanaCapBroadcasterEnv {
  const rawCommitment = process.env.SOLANA_COMMITMENT;
  const commitment =
    rawCommitment === "processed" ||
    rawCommitment === "confirmed" ||
    rawCommitment === "finalized"
      ? rawCommitment
      : undefined;
  return {
    programId: process.env.ZETTAPAY_CORE_PROGRAM_ID,
    rpcUrl: process.env.SOLANA_RPC_URL,
    commitment,
    authoritySecret: process.env.CAP_UPGRADE_AUTHORITY_SECRET,
  };
}
