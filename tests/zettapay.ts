// Anchor integration test for the ZettaPay merchant binding program.
//
// Runs via `anchor test` against a local solana-test-validator. CI does NOT
// run this — the Vercel pipeline has no Rust/Anchor toolchain. The TypeScript
// PDA derivation is exercised by `packages/api/test/merchantBinding.test.ts`
// inside the npm test suite; this file documents the on-chain behaviour and
// gates anchor releases locally.

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
