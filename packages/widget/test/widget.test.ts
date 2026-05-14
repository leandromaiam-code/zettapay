import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, open } from '../src/widget.js';
import { renderQrSvg } from '../src/qr.js';
import { __resetStylesInjectedForTest } from '../src/styles.js';

describe('renderQrSvg', () => {
  it('produces a valid square SVG with the requested size', () => {
    const svg = renderQrSvg('solana:abc?amount=1', { size: 200 });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox="0 0 200 200"');
    expect(svg).toContain('width="200"');
    expect(svg).toContain('height="200"');
    expect(svg).toContain('</svg>');
  });

  it('encodes longer payloads at level H without throwing', () => {
    const long = 'https://pay.zettapay.io/c/' + 'p'.repeat(120);
    expect(() => renderQrSvg(long, { level: 'H', size: 256 })).not.toThrow();
  });
});

describe('mount()', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    __resetStylesInjectedForTest();
    document.querySelectorAll('style[data-zettapay-widget]').forEach((s) => s.remove());
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a styled Pay button into the target', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);

    mount(target, { merchantId: '@yourshop', amount: 10 });

    const btn = target.querySelector('button[data-zettapay-button]');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain('Pay 10 USDC');
    expect(document.querySelector('style[data-zettapay-widget]')).not.toBeNull();
  });

  it('honors the label override', () => {
    const target = document.createElement('div');
    mount(target, { merchantId: '@x', amount: 5, label: 'Buy now' });
    expect(target.textContent).toContain('Buy now');
  });

  it('formats fractional amounts without trailing zeros', () => {
    const target = document.createElement('div');
    mount(target, { merchantId: '@x', amount: 10.5 });
    expect(target.textContent).toContain('Pay 10.5 USDC');
  });

  it('unmount() removes the button', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const handle = mount(target, { merchantId: '@x', amount: 1 });
    expect(target.querySelector('button')).not.toBeNull();
    handle.unmount();
    expect(target.querySelector('button')).toBeNull();
  });
});

describe('open()', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    __resetStylesInjectedForTest();
    document.querySelectorAll('style[data-zettapay-widget]').forEach((s) => s.remove());
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ payment: { id: 'pay_test', status: 'pending' } }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('mounts a modal with QR slot and Phantom deeplink button', async () => {
    open({ merchantId: '@yourshop', amount: 12.5 });
    const overlay = document.querySelector('.zp-modal') as HTMLElement;
    expect(overlay).not.toBeNull();
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(overlay.querySelector('[data-zp-qr]')).not.toBeNull();
    expect(overlay.querySelector('[data-zp-phantom]')).not.toBeNull();
    expect(overlay.querySelector('[data-zp-wallets]')).not.toBeNull();
    expect(overlay.querySelector('.zp-amount')?.textContent).toContain('12.5 USDC');
  });

  it('renders an adaptive multi-wallet row once the intent resolves', async () => {
    open({ merchantId: '@yourshop', amount: 5 });
    // Wait for the createPaymentIntent promise + DOM update.
    await new Promise((r) => setTimeout(r, 30));
    const row = document.querySelector('[data-zp-wallets]') as HTMLElement;
    expect(row).not.toBeNull();
    const wallets = row.querySelectorAll('a[data-wallet]');
    // Phantom is surfaced via the primary CTA, so the row carries the
    // remaining five wallets.
    expect(wallets.length).toBe(5);
    const ids = Array.from(wallets).map((el) => el.getAttribute('data-wallet'));
    expect(ids).toEqual(expect.arrayContaining(['solflare', 'backpack', 'glow', 'trust', 'coinbase']));
    // None of the rendered affordances may include a `connect()` call.
    const html = row.innerHTML.toLowerCase();
    expect(html).not.toContain('connect wallet');
    expect(html).not.toContain('wallet.connect');
  });

  it('Esc dismisses the modal and fires onCancel', async () => {
    const onCancel = vi.fn();
    open({ merchantId: '@x', amount: 1, onCancel });
    expect(document.querySelector('.zp-modal')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.zp-modal')).toBeNull();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCancel.mock.calls[0]?.[0]?.reason).toBe('esc_pressed');
  });

  it('rejects invalid config eagerly', () => {
    expect(() => open({ merchantId: '', amount: 1 })).toThrow(/merchantId/);
    expect(() => open({ merchantId: '@x', amount: 0 })).toThrow(/amount/);
  });
});

describe('postMessage broadcasts', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    __resetStylesInjectedForTest();
    document.querySelectorAll('style[data-zettapay-widget]').forEach((s) => s.remove());
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ payment: { id: 'pay_msg', status: 'pending' } }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('emits a discriminated cancel postMessage on dismiss', async () => {
    const events: MessageEvent[] = [];
    const listener = (e: MessageEvent): void => {
      if ((e.data as { source?: string })?.source === 'zettapay-widget') events.push(e);
    };
    window.addEventListener('message', listener);
    open({ merchantId: '@x', amount: 1 });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((r) => setTimeout(r, 10));
    window.removeEventListener('message', listener);
    const cancel = events.find((e) => (e.data as { type?: string }).type === 'cancel');
    expect(cancel).toBeDefined();
  });
});
