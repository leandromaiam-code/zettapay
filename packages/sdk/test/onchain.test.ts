import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { createHash, randomBytes } from 'node:crypto';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  INVOICE_INDEX_SEED_LEN,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  ZETTAPAY_IDL,
  ZETTAPAY_PROGRAM_ID,
  PAYMENT_ID_LEN,
  TX_SIGNATURE_LEN,
  buildRecordPaymentInstruction,
  buildRegisterMerchantInstruction,
  deriveAssociatedTokenAddress,
  deriveInvoicePda,
  deriveInvoiceUsdcAddress,
  deriveMerchantBindingPda,
  derivePaymentPda,
  isValidMerchantHandle,
} from '../src/index.js';

function discFromName(name: string): number[] {
  return Array.from(createHash('sha256').update(name).digest().subarray(0, 8));
}

describe('isValidMerchantHandle', () => {
  it('accepts the documented handle alphabet', () => {
    for (const handle of ['acme', 'acme-store', 'acme_store_42', '0xfoo']) {
      expect(isValidMerchantHandle(handle)).toBe(true);
    }
  });

  it('rejects handles outside the on-chain constraints', () => {
    for (const handle of ['', 'ab', 'ACME', '-acme', '_acme', 'acme.store', 'acme store']) {
      expect(isValidMerchantHandle(handle)).toBe(false);
    }
  });

  it('enforces the documented 32-byte upper bound', () => {
    expect(isValidMerchantHandle('a'.repeat(32))).toBe(true);
    expect(isValidMerchantHandle('a'.repeat(33))).toBe(false);
  });
});

describe('IDL discriminators', () => {
  it('register_merchant discriminator matches sha256("global:register_merchant")', () => {
    expect(Array.from(ZETTAPAY_IDL.instructions.registerMerchant.discriminator)).toEqual(
      discFromName('global:register_merchant'),
    );
  });

  it('record_payment discriminator matches sha256("global:record_payment")', () => {
    expect(Array.from(ZETTAPAY_IDL.instructions.recordPayment.discriminator)).toEqual(
      discFromName('global:record_payment'),
    );
  });

  it('account discriminators match sha256("account:<Name>")', () => {
    expect(Array.from(ZETTAPAY_IDL.accounts.MerchantBinding.discriminator)).toEqual(
      discFromName('account:MerchantBinding'),
    );
    expect(Array.from(ZETTAPAY_IDL.accounts.Payment.discriminator)).toEqual(
      discFromName('account:Payment'),
    );
  });
});

describe('PDA derivation', () => {
  const owner = Keypair.generate().publicKey;

  it('deriveMerchantBindingPda is deterministic and off-curve', () => {
    const a = deriveMerchantBindingPda('acme', owner);
    const b = deriveMerchantBindingPda('acme', owner);
    expect(a.pda.equals(b.pda)).toBe(true);
    expect(a.bump).toBe(b.bump);
    expect(PublicKey.isOnCurve(a.pda.toBytes())).toBe(false);
  });

  it('uses [handle, owner] seeds — matches manual findProgramAddressSync', () => {
    const handle = 'acme-store';
    const expected = PublicKey.findProgramAddressSync(
      [Buffer.from(handle, 'utf8'), owner.toBuffer()],
      ZETTAPAY_PROGRAM_ID,
    );
    const got = deriveMerchantBindingPda(handle, owner);
    expect(got.pda.equals(expected[0])).toBe(true);
    expect(got.bump).toBe(expected[1]);
  });

  it('rejects handles violating program-side constraints', () => {
    expect(() => deriveMerchantBindingPda('ACME', owner)).toThrow(/violates/);
  });

  it('derivePaymentPda enforces 32-byte payment_id', () => {
    const binding = Keypair.generate().publicKey;
    expect(() => derivePaymentPda(binding, new Uint8Array(31))).toThrow(/32 bytes/);
    const got = derivePaymentPda(binding, new Uint8Array(PAYMENT_ID_LEN));
    expect(PublicKey.isOnCurve(got.pda.toBytes())).toBe(false);
  });

  it('derivePaymentPda matches manual findProgramAddressSync', () => {
    const binding = Keypair.generate().publicKey;
    const paymentId = randomBytes(PAYMENT_ID_LEN);
    const expected = PublicKey.findProgramAddressSync(
      [binding.toBuffer(), paymentId],
      ZETTAPAY_PROGRAM_ID,
    );
    const got = derivePaymentPda(binding, paymentId);
    expect(got.pda.equals(expected[0])).toBe(true);
    expect(got.bump).toBe(expected[1]);
  });
});

describe('buildRegisterMerchantInstruction', () => {
  const owner = Keypair.generate().publicKey;
  const payer = Keypair.generate().publicKey;
  const usdc = Keypair.generate().publicKey;
  const handle = 'acme-store';

  it('targets the program id and uses the [binding, owner, payer, system] account order', () => {
    const ix = buildRegisterMerchantInstruction({
      owner,
      payer,
      merchantHandle: handle,
      usdcTokenAccount: usdc,
    });
    const { pda } = deriveMerchantBindingPda(handle, owner);
    expect(ix.programId.equals(ZETTAPAY_PROGRAM_ID)).toBe(true);
    expect(ix.keys).toHaveLength(4);
    expect(ix.keys[0]?.pubkey.equals(pda)).toBe(true);
    expect(ix.keys[0]?.isWritable).toBe(true);
    expect(ix.keys[0]?.isSigner).toBe(false);
    expect(ix.keys[1]?.pubkey.equals(owner)).toBe(true);
    expect(ix.keys[1]?.isSigner).toBe(true);
    expect(ix.keys[1]?.isWritable).toBe(false);
    expect(ix.keys[2]?.pubkey.equals(payer)).toBe(true);
    expect(ix.keys[2]?.isSigner).toBe(true);
    expect(ix.keys[2]?.isWritable).toBe(true);
    expect(ix.keys[3]?.pubkey.equals(SystemProgram.programId)).toBe(true);
  });

  it('encodes data as discriminator || borsh(string handle) || pubkey(usdc)', () => {
    const ix = buildRegisterMerchantInstruction({
      owner,
      payer,
      merchantHandle: handle,
      usdcTokenAccount: usdc,
    });
    const expectedDisc = Buffer.from(ZETTAPAY_IDL.instructions.registerMerchant.discriminator);
    const handleBytes = Buffer.from(handle, 'utf8');
    const lenBytes = Buffer.alloc(4);
    lenBytes.writeUInt32LE(handleBytes.length, 0);
    const expected = Buffer.concat([expectedDisc, lenBytes, handleBytes, usdc.toBuffer()]);
    expect(ix.data.equals(expected)).toBe(true);
  });

  it('rejects an invalid handle at the SDK boundary (no on-chain round-trip)', () => {
    expect(() =>
      buildRegisterMerchantInstruction({
        owner,
        payer,
        merchantHandle: 'NOPE',
        usdcTokenAccount: usdc,
      }),
    ).toThrow(/violates/);
  });
});

describe('buildRecordPaymentInstruction', () => {
  const binding = Keypair.generate().publicKey;
  const payer = Keypair.generate().publicKey;

  it('uses [binding, payment, payer, system] account order, payment writable', () => {
    const paymentId = randomBytes(PAYMENT_ID_LEN);
    const txSignature = randomBytes(TX_SIGNATURE_LEN);
    const ix = buildRecordPaymentInstruction({
      merchantBinding: binding,
      payer,
      paymentId,
      amount: 1_500_000n,
      txSignature,
    });
    const { pda } = derivePaymentPda(binding, paymentId);
    expect(ix.keys).toHaveLength(4);
    expect(ix.keys[0]?.pubkey.equals(binding)).toBe(true);
    expect(ix.keys[0]?.isSigner).toBe(false);
    expect(ix.keys[0]?.isWritable).toBe(false);
    expect(ix.keys[1]?.pubkey.equals(pda)).toBe(true);
    expect(ix.keys[1]?.isWritable).toBe(true);
    expect(ix.keys[2]?.pubkey.equals(payer)).toBe(true);
    expect(ix.keys[2]?.isSigner).toBe(true);
    expect(ix.keys[2]?.isWritable).toBe(true);
    expect(ix.keys[3]?.pubkey.equals(SystemProgram.programId)).toBe(true);
  });

  it('encodes data as discriminator || payment_id || u64-le(amount) || tx_signature', () => {
    const paymentId = randomBytes(PAYMENT_ID_LEN);
    const txSignature = randomBytes(TX_SIGNATURE_LEN);
    const amount = 12_345_678n;
    const ix = buildRecordPaymentInstruction({
      merchantBinding: binding,
      payer,
      paymentId,
      amount,
      txSignature,
    });
    const expectedDisc = Buffer.from(ZETTAPAY_IDL.instructions.recordPayment.discriminator);
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(amount, 0);
    const expected = Buffer.concat([
      expectedDisc,
      Buffer.from(paymentId),
      amountBuf,
      Buffer.from(txSignature),
    ]);
    expect(ix.data.equals(expected)).toBe(true);
  });

  it('rejects malformed payment_id and tx_signature lengths', () => {
    expect(() =>
      buildRecordPaymentInstruction({
        merchantBinding: binding,
        payer,
        paymentId: new Uint8Array(31),
        amount: 1n,
        txSignature: new Uint8Array(TX_SIGNATURE_LEN),
      }),
    ).toThrow(/payment_id/);
    expect(() =>
      buildRecordPaymentInstruction({
        merchantBinding: binding,
        payer,
        paymentId: new Uint8Array(PAYMENT_ID_LEN),
        amount: 1n,
        txSignature: new Uint8Array(63),
      }),
    ).toThrow(/tx_signature/);
  });

  it('rejects amount = 0 at the SDK boundary (mirrors AmountMustBePositive)', () => {
    expect(() =>
      buildRecordPaymentInstruction({
        merchantBinding: binding,
        payer,
        paymentId: new Uint8Array(PAYMENT_ID_LEN),
        amount: 0n,
        txSignature: new Uint8Array(TX_SIGNATURE_LEN),
      }),
    ).toThrow(/strictly greater than zero/);
  });
});

describe('deriveInvoicePda', () => {
  const master = Keypair.generate().publicKey;

  it('is deterministic, off-curve, and uses [master, u64-le(index)] seeds', () => {
    const index = 42n;
    const indexSeed = Buffer.alloc(INVOICE_INDEX_SEED_LEN);
    indexSeed.writeBigUInt64LE(index, 0);
    const expected = PublicKey.findProgramAddressSync(
      [master.toBuffer(), indexSeed],
      ZETTAPAY_PROGRAM_ID,
    );
    const got = deriveInvoicePda(master, index);
    expect(got.pda.equals(expected[0])).toBe(true);
    expect(got.bump).toBe(expected[1]);
    expect(PublicKey.isOnCurve(got.pda.toBytes())).toBe(false);
    expect(deriveInvoicePda(master, index).pda.equals(got.pda)).toBe(true);
  });

  it('accepts number and bigint inputs interchangeably', () => {
    const a = deriveInvoicePda(master, 7);
    const b = deriveInvoicePda(master, 7n);
    expect(a.pda.equals(b.pda)).toBe(true);
  });

  it('different indices and masters produce distinct addresses', () => {
    const a = deriveInvoicePda(master, 0n);
    const b = deriveInvoicePda(master, 1n);
    expect(a.pda.equals(b.pda)).toBe(false);
    const otherMaster = Keypair.generate().publicKey;
    const c = deriveInvoicePda(otherMaster, 0n);
    expect(a.pda.equals(c.pda)).toBe(false);
  });

  it('rejects negative and out-of-range indices', () => {
    expect(() => deriveInvoicePda(master, -1n)).toThrow(/non-negative/);
    expect(() => deriveInvoicePda(master, 0x1_0000_0000_0000_0000n)).toThrow(/2\^64/);
  });

  it('honours a custom programId', () => {
    const altProgram = Keypair.generate().publicKey;
    const defaultPda = deriveInvoicePda(master, 1n);
    const altPda = deriveInvoicePda(master, 1n, altProgram);
    expect(defaultPda.pda.equals(altPda.pda)).toBe(false);
  });
});

describe('deriveAssociatedTokenAddress', () => {
  it('matches the canonical [owner, TOKEN_PROGRAM_ID, mint] ATA seeds', () => {
    const owner = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const expected = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const ata = deriveAssociatedTokenAddress(owner, mint);
    expect(ata.equals(expected[0])).toBe(true);
  });

  it('works for off-curve owners (PDAs)', () => {
    const master = Keypair.generate().publicKey;
    const { pda } = deriveInvoicePda(master, 1n);
    expect(PublicKey.isOnCurve(pda.toBytes())).toBe(false);
    const ata = deriveAssociatedTokenAddress(pda, USDC_MINT.devnet);
    expect(PublicKey.isOnCurve(ata.toBytes())).toBe(false);
  });
});

describe('deriveInvoiceUsdcAddress', () => {
  const master = Keypair.generate().publicKey;

  it('defaults to mainnet USDC and ties the ATA to the invoice PDA', () => {
    const got = deriveInvoiceUsdcAddress({ masterPubkey: master, invoiceIndex: 1n });
    const { pda, bump } = deriveInvoicePda(master, 1n);
    expect(got.invoicePda.equals(pda)).toBe(true);
    expect(got.invoiceBump).toBe(bump);
    expect(got.usdcMint.equals(USDC_MINT['mainnet-beta'])).toBe(true);
    expect(got.usdcAta.equals(deriveAssociatedTokenAddress(pda, USDC_MINT['mainnet-beta']))).toBe(
      true,
    );
  });

  it('resolves devnet USDC when requested', () => {
    const got = deriveInvoiceUsdcAddress({
      masterPubkey: master,
      invoiceIndex: 0n,
      cluster: 'devnet',
    });
    expect(got.usdcMint.equals(USDC_MINT.devnet)).toBe(true);
  });

  it('lets an explicit mint override the cluster default', () => {
    const altMint = Keypair.generate().publicKey;
    const got = deriveInvoiceUsdcAddress({
      masterPubkey: master,
      invoiceIndex: 0n,
      cluster: 'devnet',
      mint: altMint,
    });
    expect(got.usdcMint.equals(altMint)).toBe(true);
  });
});
