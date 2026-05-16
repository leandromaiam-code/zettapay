import { describe, expect, it, vi } from 'vitest';
import {
  Keypair,
  PublicKey,
  type Connection,
} from '@solana/web3.js';
import { randomBytes } from 'node:crypto';
import {
  PAYMENT_ID_LEN,
  TX_SIGNATURE_LEN,
  ZETTAPAY_IDL,
  ZETTAPAY_PROGRAM_ID,
  createInvoice,
  deriveInvoiceUsdcAddress,
  deriveMerchantBindingPda,
  derivePaymentPda,
  ensureInvoiceUsdcAta,
  getInvoiceStatus,
  isInvoiceExpired,
  listenPaymentEvents,
  USDC_DECIMALS,
  USDC_DEVNET_MINT,
  USDC_MAINNET_MINT,
} from '../src/index.js';

function buildEncodedReceipt(
  binding: PublicKey,
  paymentId: Uint8Array,
  amount: bigint,
  txSignature: Uint8Array,
): Buffer {
  const disc = Buffer.from(ZETTAPAY_IDL.accounts.Payment.discriminator);
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amount, 0);
  const createdAt = Buffer.alloc(8);
  createdAt.writeBigInt64LE(1_700_000_000n, 0);
  const bumpBuf = Buffer.from([254]);
  return Buffer.concat([
    disc,
    binding.toBuffer(),
    Buffer.from(paymentId),
    amountBuf,
    Buffer.from(txSignature),
    createdAt,
    bumpBuf,
  ]);
}

describe('USDC mint constants', () => {
  it('mainnet/devnet mints + 6 decimals are pinned', () => {
    expect(USDC_MAINNET_MINT.toBase58()).toBe(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
    expect(USDC_DEVNET_MINT.toBase58()).toBe(
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    );
    expect(USDC_DECIMALS).toBe(6);
  });
});

describe('createInvoice', () => {
  const owner = Keypair.generate().publicKey;

  it('derives the same paymentPda as derivePaymentPda', () => {
    const invoice = createInvoice({
      merchantHandle: 'acme',
      merchantOwner: owner,
      amount: 1_500_000n,
    });
    const { pda: binding } = deriveMerchantBindingPda('acme', owner);
    const { pda: expected } = derivePaymentPda(binding, invoice.invoiceId);
    expect(invoice.paymentPda).toBe(expected.toBase58());
    expect(invoice.merchantBinding).toBe(binding.toBase58());
  });

  it('generates a 32-byte invoice id when not provided', () => {
    const invoice = createInvoice({
      merchantHandle: 'acme',
      merchantOwner: owner,
      amount: 1n,
    });
    expect(invoice.invoiceId).toHaveLength(PAYMENT_ID_LEN);
    expect(invoice.invoiceIdHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('respects a caller-supplied deterministic invoice id', () => {
    const id = new Uint8Array(PAYMENT_ID_LEN).fill(7);
    const invoice = createInvoice({
      merchantHandle: 'acme',
      merchantOwner: owner,
      amount: 100n,
      invoiceId: id,
    });
    expect(Buffer.from(invoice.invoiceId).equals(Buffer.from(id))).toBe(true);
    expect(invoice.invoiceIdHex).toBe('07'.repeat(32));
  });

  it('rejects invoice ids of the wrong size', () => {
    expect(() =>
      createInvoice({
        merchantHandle: 'acme',
        merchantOwner: owner,
        amount: 1n,
        invoiceId: new Uint8Array(31),
      }),
    ).toThrow(/exactly 32 bytes/);
  });

  it('rejects non-positive amounts', () => {
    expect(() =>
      createInvoice({
        merchantHandle: 'acme',
        merchantOwner: owner,
        amount: 0n,
      }),
    ).toThrow(/strictly greater than zero/);
  });

  it('rejects handles that violate program-side constraints', () => {
    expect(() =>
      createInvoice({
        merchantHandle: 'INVALID',
        merchantOwner: owner,
        amount: 1n,
      }),
    ).toThrow(/violates/);
  });
});

describe('getInvoiceStatus', () => {
  const owner = Keypair.generate().publicKey;

  it('returns pending when the payment PDA does not exist', async () => {
    const invoice = createInvoice({
      merchantHandle: 'acme',
      merchantOwner: owner,
      amount: 1n,
    });
    const fakeConnection = {
      getAccountInfoAndContext: vi.fn().mockResolvedValue({
        context: { slot: 12 },
        value: null,
      }),
    } as unknown as Connection;
    const status = await getInvoiceStatus({
      connection: fakeConnection,
      invoice,
    });
    expect(status.status).toBe('pending');
    expect(status.receipt).toBeNull();
    expect(status.paymentPda).toBe(invoice.paymentPda);
  });

  it('returns expired when expiresAt has elapsed and no receipt is on-chain', async () => {
    const invoice = createInvoice({
      merchantHandle: 'acme',
      merchantOwner: owner,
      amount: 1n,
      expiresAt: 1_000,
    });
    const fakeConnection = {
      getAccountInfoAndContext: vi.fn().mockResolvedValue({
        context: { slot: 50 },
        value: null,
      }),
    } as unknown as Connection;
    const status = await getInvoiceStatus({
      connection: fakeConnection,
      invoice,
      now: 5_000,
    });
    expect(status.status).toBe('expired');
  });

  it('returns paid + parsed receipt when the PDA is populated', async () => {
    const invoice = createInvoice({
      merchantHandle: 'acme',
      merchantOwner: owner,
      amount: 1_500_000n,
    });
    const binding = new PublicKey(invoice.merchantBinding);
    const txSignature = randomBytes(TX_SIGNATURE_LEN);
    const encoded = buildEncodedReceipt(
      binding,
      invoice.invoiceId,
      1_500_000n,
      txSignature,
    );
    const fakeConnection = {
      getAccountInfoAndContext: vi.fn().mockResolvedValue({
        context: { slot: 42 },
        value: {
          owner: ZETTAPAY_PROGRAM_ID,
          lamports: 1_000_000,
          executable: false,
          rentEpoch: 0,
          data: encoded,
        },
      }),
    } as unknown as Connection;
    const status = await getInvoiceStatus({
      connection: fakeConnection,
      invoice,
    });
    expect(status.status).toBe('paid');
    expect(status.receipt).not.toBeNull();
    expect(status.receipt?.amount).toBe(1_500_000n);
    expect(status.receipt?.paymentIdHex).toBe(invoice.invoiceIdHex);
    expect(status.receipt?.slot).toBe(42);
    expect(status.receipt?.txSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it('rejects malformed receipts with the wrong discriminator', async () => {
    const invoice = createInvoice({
      merchantHandle: 'acme',
      merchantOwner: owner,
      amount: 1n,
    });
    const bogus = Buffer.alloc(8 + 32 + PAYMENT_ID_LEN + 8 + TX_SIGNATURE_LEN + 9);
    const fakeConnection = {
      getAccountInfoAndContext: vi.fn().mockResolvedValue({
        context: { slot: 1 },
        value: {
          owner: ZETTAPAY_PROGRAM_ID,
          lamports: 1,
          executable: false,
          rentEpoch: 0,
          data: bogus,
        },
      }),
    } as unknown as Connection;
    await expect(
      getInvoiceStatus({ connection: fakeConnection, invoice }),
    ).rejects.toThrow(/discriminator/);
  });
});

describe('listenPaymentEvents', () => {
  it('subscribes via onProgramAccountChange and decodes pushed receipts', async () => {
    const owner = Keypair.generate().publicKey;
    const { pda: binding } = deriveMerchantBindingPda('acme', owner);
    const paymentId = randomBytes(PAYMENT_ID_LEN);
    const txSignature = randomBytes(TX_SIGNATURE_LEN);
    const receipt = buildEncodedReceipt(binding, paymentId, 999n, txSignature);

    let captured:
      | { cb: Parameters<Connection['onProgramAccountChange']>[1] }
      | null = null;
    const fakeConnection = {
      onProgramAccountChange: vi.fn((_pid, cb, _opts) => {
        captured = { cb };
        return 77;
      }),
      removeProgramAccountChangeListener: vi.fn(async () => undefined),
    } as unknown as Connection;

    const events: unknown[] = [];
    const subscription = await listenPaymentEvents({
      connection: fakeConnection,
      merchantBinding: binding,
      onEvent: (e) => events.push(e),
    });
    expect(subscription.id).toBe(77);
    expect(captured).not.toBeNull();

    const paymentPda = Keypair.generate().publicKey;
    // simulate RPC push
    captured!.cb(
      {
        accountId: paymentPda,
        accountInfo: {
          owner: ZETTAPAY_PROGRAM_ID,
          lamports: 1_000_000,
          executable: false,
          rentEpoch: 0,
          data: receipt,
        },
      },
      { slot: 123 },
    );

    expect(events).toHaveLength(1);
    const evt = events[0] as {
      paymentPda: string;
      amount: bigint;
      slot: number;
      merchantBinding: string;
    };
    expect(evt.paymentPda).toBe(paymentPda.toBase58());
    expect(evt.amount).toBe(999n);
    expect(evt.slot).toBe(123);
    expect(evt.merchantBinding).toBe(binding.toBase58());

    await subscription.close();
    await subscription.close(); // idempotent
    expect(
      (fakeConnection.removeProgramAccountChangeListener as ReturnType<typeof vi.fn>)
        .mock.calls,
    ).toHaveLength(1);
  });

  it('routes decoder errors to onError instead of throwing', async () => {
    const owner = Keypair.generate().publicKey;
    const { pda: binding } = deriveMerchantBindingPda('acme', owner);

    let captured:
      | { cb: Parameters<Connection['onProgramAccountChange']>[1] }
      | null = null;
    const fakeConnection = {
      onProgramAccountChange: vi.fn((_pid, cb) => {
        captured = { cb };
        return 1;
      }),
      removeProgramAccountChangeListener: vi.fn(async () => undefined),
    } as unknown as Connection;

    const onError = vi.fn();
    await listenPaymentEvents({
      connection: fakeConnection,
      merchantBinding: binding,
      onEvent: () => {
        throw new Error('should not be called');
      },
      onError,
    });

    captured!.cb(
      {
        accountId: Keypair.generate().publicKey,
        accountInfo: {
          owner: ZETTAPAY_PROGRAM_ID,
          lamports: 1,
          executable: false,
          rentEpoch: 0,
          data: Buffer.alloc(8),
        },
      },
      { slot: 0 },
    );

    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('isInvoiceExpired — Z28.5 edge: invoice expired', () => {
  it('returns false when expiresAt is null or undefined', () => {
    expect(isInvoiceExpired({ expiresAt: null }, 10_000)).toBe(false);
    expect(isInvoiceExpired({ expiresAt: undefined as unknown as null }, 10_000))
      .toBe(false);
  });

  it('returns false strictly before expiresAt', () => {
    expect(isInvoiceExpired({ expiresAt: 1_600 }, 1_500)).toBe(false);
  });

  it('returns true at expiresAt boundary (inclusive) and after', () => {
    // Matches the `getInvoiceStatus` predicate: `now >= expiresAt` flips
    // to expired. Pin both surfaces here so they stay in lockstep.
    expect(isInvoiceExpired({ expiresAt: 1_600 }, 1_600)).toBe(true);
    expect(isInvoiceExpired({ expiresAt: 1_600 }, 1_601)).toBe(true);
  });

  it('defaults `now` to the wall clock when not supplied', () => {
    const ahead = Math.floor(Date.now() / 1000) + 60;
    const behind = Math.floor(Date.now() / 1000) - 60;
    expect(isInvoiceExpired({ expiresAt: ahead })).toBe(false);
    expect(isInvoiceExpired({ expiresAt: behind })).toBe(true);
  });
});

describe('ensureInvoiceUsdcAta — Z28.5 edge: ATA missing creation', () => {
  const masterPubkey = Keypair.generate().publicKey;
  const payer = Keypair.generate().publicKey;

  it('returns exists=true when the ATA is already on-chain', async () => {
    const fakeConnection = {
      getAccountInfo: vi.fn().mockResolvedValue({
        owner: ZETTAPAY_PROGRAM_ID,
        lamports: 1_000_000,
        executable: false,
        rentEpoch: 0,
        data: Buffer.alloc(165),
      }),
    } as unknown as Connection;

    const result = await ensureInvoiceUsdcAta({
      connection: fakeConnection,
      payer,
      masterPubkey,
      invoiceIndex: 0,
      cluster: 'devnet',
    });

    expect(result.exists).toBe(true);
    expect(result.createInstruction).toBeNull();
    // Derivation must match the deterministic helper exactly — drift
    // here would silently route payments to an address the merchant
    // does not watch.
    const expected = deriveInvoiceUsdcAddress({
      masterPubkey,
      invoiceIndex: 0,
      cluster: 'devnet',
    });
    expect(result.invoicePda.toBase58()).toBe(expected.invoicePda.toBase58());
    expect(result.usdcAta.toBase58()).toBe(expected.usdcAta.toBase58());
  });

  it('returns a build-ready idempotent create instruction when the ATA is missing', async () => {
    const fakeConnection = {
      getAccountInfo: vi.fn().mockResolvedValue(null),
    } as unknown as Connection;

    const result = await ensureInvoiceUsdcAta({
      connection: fakeConnection,
      payer,
      masterPubkey,
      invoiceIndex: 7,
      cluster: 'devnet',
    });

    expect(result.exists).toBe(false);
    expect(result.createInstruction).not.toBeNull();

    // Sanity-check the produced instruction wires the canonical
    // associated-token-program id + the three required signer keys (in
    // the order the SPL idempotent-create helper emits them).
    const ix = result.createInstruction!;
    expect(ix.programId.toBase58()).toBe(
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    );
    const keys = ix.keys.map((k) => k.pubkey.toBase58());
    expect(keys).toContain(payer.toBase58());
    expect(keys).toContain(result.usdcAta.toBase58());
    expect(keys).toContain(result.invoicePda.toBase58());
    expect(keys).toContain(result.usdcMint.toBase58());
  });

  it('passes the explicit mint override through to derivation', async () => {
    const fakeConnection = {
      getAccountInfo: vi.fn().mockResolvedValue(null),
    } as unknown as Connection;
    const customMint = Keypair.generate().publicKey;

    const result = await ensureInvoiceUsdcAta({
      connection: fakeConnection,
      payer,
      masterPubkey,
      invoiceIndex: 0,
      mint: customMint,
    });

    expect(result.usdcMint.toBase58()).toBe(customMint.toBase58());
    expect(result.createInstruction).not.toBeNull();
  });
});
