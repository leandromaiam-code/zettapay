// rpc-quorum tests (Z76 FIX 2) — pure decision + url-list helpers. No network.

import { describe, expect, it } from 'vitest';
import {
  decideTransferQuorum,
  quorumThreshold,
  resolveRpcUrls,
  parseRpcCsv,
  DEFAULT_RPC_URLS,
  DEFAULT_QUORUM,
} from '../src/rpc-quorum.js';

describe('quorumThreshold', () => {
  it('is 1 for a single configured endpoint (own node / test)', () => {
    expect(quorumThreshold(1)).toBe(1);
  });
  it('caps at DEFAULT_QUORUM for many endpoints', () => {
    expect(quorumThreshold(3)).toBe(DEFAULT_QUORUM);
    expect(quorumThreshold(2)).toBe(2);
  });
  it('never returns 0', () => {
    expect(quorumThreshold(0)).toBe(1);
  });
});

describe('resolveRpcUrls / parseRpcCsv', () => {
  it('returns the bundled defaults when no override', () => {
    expect(resolveRpcUrls('base', undefined)).toEqual(DEFAULT_RPC_URLS.base);
    expect(resolveRpcUrls('ethereum', '')).toEqual(DEFAULT_RPC_URLS.ethereum);
  });
  it('lets a merchant override replace the defaults (csv)', () => {
    expect(resolveRpcUrls('base', 'https://my-node,https://backup')).toEqual([
      'https://my-node',
      'https://backup',
    ]);
  });
  it('supports a single private node override (collapses quorum to 1)', () => {
    const urls = resolveRpcUrls('base', 'https://only-mine');
    expect(urls).toEqual(['https://only-mine']);
    expect(quorumThreshold(urls.length)).toBe(1);
  });
  it('de-duplicates and trims', () => {
    expect(parseRpcCsv(' a , a , b ')).toEqual(['a', 'b']);
  });
});

describe('decideTransferQuorum', () => {
  it('agrees when >= threshold report the same value', () => {
    const d = decideTransferQuorum(
      [
        { value: 100n, confirmations: 5 },
        { value: 100n, confirmations: 3 },
      ],
      2,
    );
    expect(d.status).toBe('agreed');
    if (d.status === 'agreed') {
      expect(d.value).toBe(100n);
      expect(d.confirmations).toBe(3); // conservative minimum
      expect(d.agree).toBe(2);
    }
  });

  it('reports insufficient when a single value has too few reporters', () => {
    const d = decideTransferQuorum([{ value: 100n, confirmations: 9 }], 2);
    expect(d.status).toBe('insufficient');
  });

  it('reports conflict when RPCs disagree on the value (possible forgery)', () => {
    const d = decideTransferQuorum(
      [
        { value: 100n, confirmations: 9 },
        { value: 999n, confirmations: 9 },
      ],
      2,
    );
    expect(d.status).toBe('conflict');
  });

  it('an honest majority wins over a single forging RPC', () => {
    const d = decideTransferQuorum(
      [
        { value: 100n, confirmations: 9 },
        { value: 100n, confirmations: 9 },
        { value: 666n, confirmations: 9 }, // forged minority
      ],
      2,
    );
    expect(d.status).toBe('agreed');
    if (d.status === 'agreed') expect(d.value).toBe(100n);
  });

  it('single-source threshold=1 agrees (back-compat / own node)', () => {
    const d = decideTransferQuorum([{ value: 42n, confirmations: 1 }], 1);
    expect(d.status).toBe('agreed');
  });
});
