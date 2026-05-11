import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSolanaPayUri, matchesTransfer, mount, toBaseUnits } from '../src/index.js';

const RECIPIENT = '7vYAYP6sH5DEKpzCRYAYn5dShGE1LdgqHCT9KuExJgWY';
const REFERENCE = 'D8jU5sZ6hbVQHBhAJW9D2yh3sDWg7XHnH9Cx8GxKDDax';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

describe('toBaseUnits', () => {
  it('converts integer USDC amounts', () => {
    expect(toBaseUnits('10', 6)).toBe(10_000_000n);
  });

  it('converts fractional amounts exactly', () => {
    expect(toBaseUnits('1.5', 6)).toBe(1_500_000n);
    expect(toBaseUnits('0.000001', 6)).toBe(1n);
    expect(toBaseUnits('24.99', 6)).toBe(24_990_000n);
  });

  it('preserves precision above Number.MAX_SAFE_INTEGER', () => {
    expect(toBaseUnits('9999999999.999999', 6)).toBe(9_999_999_999_999_999n);
  });

  it('rejects malformed input', () => {
    expect(() => toBaseUnits('abc', 6)).toThrow(/invalid amount/);
    expect(() => toBaseUnits('-1', 6)).toThrow(/invalid amount/);
  });

  it('rejects amounts with too much precision', () => {
    expect(() => toBaseUnits('1.1234567', 6)).toThrow(/precision/);
  });
});

describe('buildSolanaPayUri', () => {
  it('builds a spec-compliant URI with reference', () => {
    const uri = buildSolanaPayUri({
      recipient: RECIPIENT,
      amount: '10.5',
      mint: USDC,
      reference: REFERENCE,
      label: 'Order #42',
    });
    expect(uri.startsWith(`solana:${RECIPIENT}?`)).toBe(true);
    expect(uri).toContain('amount=10.5');
    expect(uri).toContain(`spl-token=${USDC}`);
    expect(uri).toContain(`reference=${REFERENCE}`);
    expect(uri).toContain('label=Order+%2342');
  });

  it('omits reference when not provided', () => {
    const uri = buildSolanaPayUri({ recipient: RECIPIENT, amount: '1', mint: USDC });
    expect(uri).not.toContain('reference=');
  });
});

describe('matchesTransfer', () => {
  it('matches a transferChecked to the recipient with right amount and mint', () => {
    const ok = matchesTransfer(
      [
        {
          program: 'spl-token',
          parsed: {
            type: 'transferChecked',
            info: {
              destination: RECIPIENT,
              mint: USDC,
              tokenAmount: { amount: '1500000', decimals: 6 },
            },
          },
        },
      ],
      RECIPIENT,
      USDC,
      1_500_000n,
    );
    expect(ok).toBe(true);
  });

  it('matches a legacy transfer by destination + amount', () => {
    const ok = matchesTransfer(
      [
        {
          program: 'spl-token',
          parsed: { type: 'transfer', info: { destination: RECIPIENT, amount: '1500000' } },
        },
      ],
      RECIPIENT,
      USDC,
      1_500_000n,
    );
    expect(ok).toBe(true);
  });

  it('rejects wrong destination', () => {
    const ok = matchesTransfer(
      [
        {
          program: 'spl-token',
          parsed: {
            type: 'transferChecked',
            info: {
              destination: 'wrong',
              mint: USDC,
              tokenAmount: { amount: '1500000', decimals: 6 },
            },
          },
        },
      ],
      RECIPIENT,
      USDC,
      1_500_000n,
    );
    expect(ok).toBe(false);
  });

  it('rejects wrong mint for transferChecked', () => {
    const ok = matchesTransfer(
      [
        {
          program: 'spl-token',
          parsed: {
            type: 'transferChecked',
            info: {
              destination: RECIPIENT,
              mint: 'OTHER_MINT',
              tokenAmount: { amount: '1500000', decimals: 6 },
            },
          },
        },
      ],
      RECIPIENT,
      USDC,
      1_500_000n,
    );
    expect(ok).toBe(false);
  });

  it('rejects wrong amount', () => {
    const ok = matchesTransfer(
      [
        {
          program: 'spl-token',
          parsed: {
            type: 'transferChecked',
            info: {
              destination: RECIPIENT,
              mint: USDC,
              tokenAmount: { amount: '999', decimals: 6 },
            },
          },
        },
      ],
      RECIPIENT,
      USDC,
      1_500_000n,
    );
    expect(ok).toBe(false);
  });

  it('ignores non spl-token instructions', () => {
    const ok = matchesTransfer(
      [{ program: 'system', parsed: { type: 'transfer', info: { destination: RECIPIENT } } }],
      RECIPIENT,
      USDC,
      1n,
    );
    expect(ok).toBe(false);
  });
});

describe('mount()', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
    // happy-dom may not provide fetch — install a stub that never resolves
    (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
      () => new Promise<Response>(() => {}),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('renders amount, recipient, and QR image into the target', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);

    mount(target, {
      recipient: RECIPIENT,
      amount: '24.99',
      reference: REFERENCE,
      cluster: 'devnet',
    });

    const root = target.querySelector('[data-zettapay-embed]') as HTMLElement | null;
    expect(root).not.toBeNull();
    expect(root!.textContent).toContain('24.99');
    expect(root!.textContent).toContain(RECIPIENT);
    const img = root!.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.src).toContain('api.qrserver.com');
    expect(decodeURIComponent(img!.src)).toContain(`solana:${RECIPIENT}`);
  });

  it('honors custom qrRenderer and decimals', () => {
    const target = document.createElement('div');
    mount(target, {
      recipient: RECIPIENT,
      amount: '1',
      cluster: 'devnet',
      qrRenderer: 'https://my-qr/render?p=',
      decimals: 0,
      mint: USDC,
    });
    const img = target.querySelector('img');
    expect(img!.src.startsWith('https://my-qr/render?p=')).toBe(true);
  });

  it('throws on missing recipient', () => {
    const target = document.createElement('div');
    expect(() =>
      mount(target, { recipient: '', amount: '1' } as never),
    ).toThrow(/recipient is required/);
  });

  it('destroy removes the rendered DOM and stops further work', () => {
    const target = document.createElement('div');
    const handle = mount(target, {
      recipient: RECIPIENT,
      amount: '1',
      cluster: 'devnet',
    });
    expect(target.querySelector('[data-zettapay-embed]')).not.toBeNull();
    handle.destroy();
    expect(target.querySelector('[data-zettapay-embed]')).toBeNull();
  });
});
