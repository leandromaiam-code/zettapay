// rpc-quorum tests (Z76, FIX 2) — pure cross-check of per-endpoint Transfer
// observations. No I/O, no network.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVM_RPCS,
  quorumThreshold,
  resolveRpcList,
  tallyTransferQuorum,
  type TransferObservation,
} from '../src/rpc-quorum.js';

function obs(over: Partial<TransferObservation> = {}): TransferObservation {
  return {
    key: over.key ?? '0xabc:0x0',
    txHash: over.txHash ?? '0xabc',
    value: over.value ?? 29_000042n,
    confirmations: over.confirmations ?? 3,
  };
}

describe('resolveRpcList', () => {
  it('falls back to the chain defaults when no override is given', () => {
    expect(resolveRpcList(undefined, DEFAULT_EVM_RPCS.base!)).toEqual(DEFAULT_EVM_RPCS.base);
  });

  it('lets a csv override win and strips trailing slashes', () => {
    expect(resolveRpcList('https://my-node/ , https://backup/', DEFAULT_EVM_RPCS.base!)).toEqual([
      'https://my-node',
      'https://backup',
    ]);
  });

  it('de-duplicates while preserving order and never returns empty', () => {
    expect(resolveRpcList('https://a,https://a,https://b', DEFAULT_EVM_RPCS.base!)).toEqual([
      'https://a',
      'https://b',
    ]);
    expect(resolveRpcList('   ', DEFAULT_EVM_RPCS.base!)).toEqual(DEFAULT_EVM_RPCS.base);
  });
});

describe('quorumThreshold', () => {
  it('requires 2 when >=2 endpoints are configured', () => {
    expect(quorumThreshold(3)).toBe(2);
    expect(quorumThreshold(2)).toBe(2);
  });

  it('requires 1 for a single deliberately-trusted endpoint', () => {
    expect(quorumThreshold(1)).toBe(1);
  });
});

describe('tallyTransferQuorum', () => {
  it('confirms when two endpoints agree on the same (key,value)', () => {
    const r = tallyTransferQuorum([[obs()], [obs()]], 1, 2);
    expect(r.confirmed).toHaveLength(1);
    expect(r.degraded).toHaveLength(0);
    expect(r.confirmed[0]!.value).toBe(29_000042n);
    expect(r.confirmed[0]!.agreement).toBe(2);
  });

  it('reports degraded (not confirmed) when only one of two endpoints sees it', () => {
    const r = tallyTransferQuorum([[obs()], []], 1, 2);
    expect(r.confirmed).toHaveLength(0);
    expect(r.degraded).toHaveLength(1);
    expect(r.degraded[0]!.agreement).toBe(1);
    expect(r.degraded[0]!.required).toBe(2);
  });

  it('never confirms a forged value: a single endpoint reporting a different value cannot reach quorum', () => {
    const honest = obs({ value: 29_000042n });
    const forged = obs({ value: 99_000042n });
    // Two honest endpoints agree on the real value; one rogue endpoint forges.
    const r = tallyTransferQuorum([[honest], [honest], [forged]], 1, 2);
    const confirmedValues = r.confirmed.map((c) => c.value);
    expect(confirmedValues).toContain(29_000042n);
    expect(confirmedValues).not.toContain(99_000042n);
    // The forged value is left degraded (1 < 2).
    expect(r.degraded.some((d) => d.value === 99_000042n)).toBe(true);
  });

  it('omits an observation still below minConfirmations everywhere (normal maturing)', () => {
    const r = tallyTransferQuorum([[obs({ confirmations: 1 })], [obs({ confirmations: 1 })]], 2, 2);
    expect(r.confirmed).toHaveLength(0);
    expect(r.degraded).toHaveLength(0);
  });

  it('reports the minimum confirmations among agreeing endpoints', () => {
    const r = tallyTransferQuorum(
      [[obs({ confirmations: 5 })], [obs({ confirmations: 3 })]],
      1,
      2,
    );
    expect(r.confirmed[0]!.confirmations).toBe(3);
  });

  it('counts one vote per endpoint even if it reports the same (key,value) twice', () => {
    const r = tallyTransferQuorum([[obs(), obs()]], 1, 1);
    expect(r.confirmed).toHaveLength(1);
    expect(r.confirmed[0]!.agreement).toBe(1);
  });

  it('confirms on a single endpoint when required is 1 (self-run node)', () => {
    const r = tallyTransferQuorum([[obs()]], 1, 1);
    expect(r.confirmed).toHaveLength(1);
  });
});
