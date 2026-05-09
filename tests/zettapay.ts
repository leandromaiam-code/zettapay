// Anchor integration test for the ZettaPay program.
//
// Runs via `anchor test` against a local solana-test-validator. CI does NOT
// run this — the Vercel pipeline has no Rust/Anchor toolchain. The TypeScript
// PDA derivation is exercised by `packages/api/test/merchantBinding.test.ts`
// and `packages/api/test/paymentRecord.test.ts` inside the npm test suite;
// this file documents the on-chain behaviour and gates anchor releases
// locally.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

import { Zettapay } from "../target/types/zettapay";

describe("zettapay :: register_merchant", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zettapay as Program<Zettapay>;

  const owner = Keypair.generate();
  const usdcAta = Keypair.generate().publicKey;
  const handle = "acme-store";

  function pda(h: string, o: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(h, "utf8"), o.toBuffer()],
      program.programId,
    );
  }

  before(async () => {
    const sig = await provider.connection.requestAirdrop(
      owner.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(sig);
  });

  it("registers a merchant binding at the [handle, owner] PDA", async () => {
    const [bindingPda, bump] = pda(handle, owner.publicKey);

    await program.methods
      .registerMerchant(handle, usdcAta)
      .accounts({
        binding: bindingPda,
        owner: owner.publicKey,
        payer: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const account = await program.account.merchantBinding.fetch(bindingPda);
    assert.equal(account.bump, bump);
    assert.ok(account.owner.equals(owner.publicKey));
    assert.ok(account.usdcTokenAccount.equals(usdcAta));
    assert.equal(account.merchantHandle, handle);
    assert.isAbove(account.registeredAt.toNumber(), 0);
  });

  it("is immutable — the same (handle, owner) cannot be re-registered", async () => {
    const [bindingPda] = pda(handle, owner.publicKey);
    try {
      await program.methods
        .registerMerchant(handle, Keypair.generate().publicKey)
        .accounts({
          binding: bindingPda,
          owner: owner.publicKey,
          payer: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
      assert.fail("expected re-registration to fail");
    } catch (err) {
      assert.match(String(err), /already in use|custom program error/i);
    }
  });

  it("rejects handles outside the documented alphabet", async () => {
    const badHandle = "ACME";
    const [bindingPda] = pda(badHandle, owner.publicKey);
    try {
      await program.methods
        .registerMerchant(badHandle, usdcAta)
        .accounts({
          binding: bindingPda,
          owner: owner.publicKey,
          payer: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
      assert.fail("expected handle validation to reject ACME");
    } catch (err) {
      assert.match(String(err), /HandleCharsInvalid|HandleLengthInvalid|custom program error/);
    }
  });
});

describe("zettapay :: record_payment", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zettapay as Program<Zettapay>;

  const owner = Keypair.generate();
  const facilitator = Keypair.generate();
  const usdcAta = Keypair.generate().publicKey;
  const handle = "rec-merchant";

  function bindingPda(h: string, o: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(h, "utf8"), o.toBuffer()],
      program.programId,
    );
  }

  function paymentPda(binding: PublicKey, paymentId: Buffer): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [binding.toBuffer(), paymentId],
      program.programId,
    );
  }

  function randomBytes(n: number): Buffer {
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
    return buf;
  }

  before(async () => {
    for (const kp of [owner, facilitator]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig);
    }
    const [binding] = bindingPda(handle, owner.publicKey);
    await program.methods
      .registerMerchant(handle, usdcAta)
      .accounts({
        binding,
        owner: owner.publicKey,
        payer: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
  });

  it("records a payment at the [merchant_binding, payment_id] PDA", async () => {
    const [binding] = bindingPda(handle, owner.publicKey);
    const paymentId = randomBytes(32);
    const txSignature = randomBytes(64);
    const amount = new anchor.BN(1_500_000); // 1.5 USDC (6 decimals)

    const [payment, bump] = paymentPda(binding, paymentId);

    await program.methods
      .recordPayment(Array.from(paymentId), amount, Array.from(txSignature))
      .accounts({
        merchantBinding: binding,
        payment,
        payer: facilitator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([facilitator])
      .rpc();

    const account = await program.account.payment.fetch(payment);
    assert.equal(account.bump, bump);
    assert.ok(account.merchantBinding.equals(binding));
    assert.deepEqual(Buffer.from(account.paymentId).equals(paymentId), true);
    assert.equal(account.amount.toString(), amount.toString());
    assert.deepEqual(Buffer.from(account.txSignature).equals(txSignature), true);
    assert.isAbove(account.recordedAt.toNumber(), 0);
  });

  it("is immutable — same (merchant_binding, payment_id) cannot be re-recorded", async () => {
    const [binding] = bindingPda(handle, owner.publicKey);
    const paymentId = randomBytes(32);
    const txSignature = randomBytes(64);
    const amount = new anchor.BN(2_000_000);
    const [payment] = paymentPda(binding, paymentId);

    await program.methods
      .recordPayment(Array.from(paymentId), amount, Array.from(txSignature))
      .accounts({
        merchantBinding: binding,
        payment,
        payer: facilitator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([facilitator])
      .rpc();

    try {
      await program.methods
        .recordPayment(Array.from(paymentId), amount, Array.from(randomBytes(64)))
        .accounts({
          merchantBinding: binding,
          payment,
          payer: facilitator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([facilitator])
        .rpc();
      assert.fail("expected duplicate payment_id to be rejected");
    } catch (err) {
      assert.match(String(err), /already in use|custom program error/i);
    }
  });

  it("rejects amount = 0", async () => {
    const [binding] = bindingPda(handle, owner.publicKey);
    const paymentId = randomBytes(32);
    const [payment] = paymentPda(binding, paymentId);

    try {
      await program.methods
        .recordPayment(Array.from(paymentId), new anchor.BN(0), Array.from(randomBytes(64)))
        .accounts({
          merchantBinding: binding,
          payment,
          payer: facilitator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([facilitator])
        .rpc();
      assert.fail("expected zero amount to be rejected");
    } catch (err) {
      assert.match(String(err), /AmountMustBePositive|custom program error/);
    }
  });

  it("rejects an account that isn't a real MerchantBinding", async () => {
    const fakeBinding = Keypair.generate().publicKey;
    const paymentId = randomBytes(32);
    const [payment] = paymentPda(fakeBinding, paymentId);

    try {
      await program.methods
        .recordPayment(Array.from(paymentId), new anchor.BN(1), Array.from(randomBytes(64)))
        .accounts({
          merchantBinding: fakeBinding,
          payment,
          payer: facilitator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([facilitator])
        .rpc();
      assert.fail("expected non-binding account to be rejected");
    } catch (err) {
      assert.match(
        String(err),
        /AccountNotInitialized|AccountOwnedByWrongProgram|AccountDiscriminatorMismatch|custom program error/,
      );
    }
  });
});
