import { ApiError, createPaymentIntent, pollPaymentStatus, DEFAULT_API_BASE, DEFAULT_CHECKOUT_BASE } from './api.js';
import { renderQrSvg } from './qr.js';
import { injectStylesOnce } from './styles.js';
import type {
  PaymentIntent,
  WidgetConfig,
  WidgetCancelEvent,
  WidgetErrorEvent,
  WidgetOpenEvent,
  WidgetPostMessage,
  WidgetSuccessEvent,
} from './types.js';

interface ResolvedConfig {
  merchantId: string;
  amount: number;
  currency: string;
  apiBase: string;
  checkoutBase: string;
  theme: 'dark' | 'light';
  metadata?: Record<string, unknown>;
}

function resolveConfig(cfg: WidgetConfig): ResolvedConfig {
  if (!cfg.merchantId) throw new Error('ZettaPay widget: `merchantId` is required');
  if (!Number.isFinite(cfg.amount) || cfg.amount <= 0) {
    throw new Error('ZettaPay widget: `amount` must be a positive number');
  }
  return {
    merchantId: cfg.merchantId,
    amount: cfg.amount,
    currency: (cfg.currency ?? 'USDC').toUpperCase(),
    apiBase: (cfg.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, ''),
    checkoutBase: (cfg.checkoutBase ?? DEFAULT_CHECKOUT_BASE).replace(/\/+$/, ''),
    theme: cfg.theme ?? 'dark',
    metadata: cfg.metadata,
  };
}

/**
 * Builds the canonical hosted-checkout URL for a payment intent. The widget
 * encodes this URL inside the QR and into the Phantom universal link. The
 * hosted page is responsible for the actual on-chain transfer (it knows the
 * merchant's wallet and constructs the Solana Pay URI server-side), so the
 * embedded widget never needs to ship Solana web3.js or know the merchant
 * recipient address.
 */
function checkoutUrlFor(intent: PaymentIntent, base: string): string {
  return `${base}/c/${encodeURIComponent(intent.id)}`;
}

/**
 * Phantom universal link for desktop + mobile. On mobile (iOS/Android) this
 * deep-links straight into the Phantom app; on desktop it falls back to a
 * Phantom-branded landing that bridges to the wallet extension.
 *
 * Reference: https://docs.phantom.app/phantom-deeplinks/provider-methods/browse
 */
function phantomDeeplink(checkoutUrl: string): string {
  const encoded = encodeURIComponent(checkoutUrl);
  const ref = encodeURIComponent(new URL(checkoutUrl).origin);
  return `https://phantom.app/ul/browse/${encoded}?ref=${ref}`;
}

function broadcast(msg: WidgetPostMessage): void {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(msg, '*');
    }
    window.postMessage(msg, '*');
  } catch {
    // postMessage to a cross-origin parent with strict CSP can throw — the
    // JS callbacks are still invoked, so swallow.
  }
}

const ICON_PHANTOM = '<svg class="zp-btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2C6.5 2 2 6.5 2 12c0 5.5 4.5 10 10 10 1.4 0 2.7-.3 3.9-.8.5-.2.8-.7.6-1.2-.2-.5-.7-.8-1.2-.6-1 .4-2.1.6-3.3.6-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8c0 .8-.1 1.5-.3 2.2-.1.5.2 1 .7 1.1.5.1 1-.2 1.1-.7.3-.9.5-1.7.5-2.6 0-5.5-4.5-10-10-10z" fill="currentColor"/><circle cx="9" cy="11" r="1.5" fill="currentColor"/><circle cx="15" cy="11" r="1.5" fill="currentColor"/></svg>';
const ICON_COPY = '<svg class="zp-btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="2"/></svg>';

interface OpenHandle {
  close(reason?: WidgetCancelEvent['reason']): void;
}

export function openCheckout(rawConfig: WidgetConfig): OpenHandle {
  const cfg = resolveConfig(rawConfig);
  injectStylesOnce();

  const overlay = document.createElement('div');
  overlay.className = 'zp-modal';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `Pay ${cfg.amount} ${cfg.currency}`);
  overlay.dataset.theme = cfg.theme;

  overlay.innerHTML = `
    <div class="zp-card" tabindex="-1">
      <div class="zp-card-head">
        <span class="zp-brand"><span class="zp-brand-dot"></span>ZettaPay</span>
        <button type="button" class="zp-close" aria-label="Close">&times;</button>
      </div>
      <h2 class="zp-amount">${cfg.amount} ${escapeHtml(cfg.currency)}</h2>
      <p class="zp-merchant">to ${escapeHtml(cfg.merchantId)}</p>
      <div class="zp-qr-wrap" data-zp-qr>
        <div class="zp-spinner" aria-hidden="true" style="margin: 110px auto;"></div>
      </div>
      <div class="zp-actions">
        <a class="zp-btn-secondary" data-zp-phantom target="_blank" rel="noopener noreferrer" href="#" aria-disabled="true">
          ${ICON_PHANTOM}<span>Open in Phantom</span>
        </a>
        <button type="button" class="zp-btn-secondary" data-zp-copy disabled>
          ${ICON_COPY}<span>Copy checkout link</span>
        </button>
      </div>
      <div class="zp-status" data-zp-status data-state="loading">
        <span class="zp-spinner" aria-hidden="true"></span>
        <span data-zp-status-text>Creating payment intent…</span>
      </div>
      <div class="zp-foot">Pay with USDC on Solana · settles in ~2 sec · 0.30% fee</div>
    </div>
  `;

  const card = overlay.querySelector('.zp-card') as HTMLElement;
  const closeBtn = overlay.querySelector('.zp-close') as HTMLButtonElement;
  const qrWrap = overlay.querySelector('[data-zp-qr]') as HTMLElement;
  const phantomLink = overlay.querySelector('[data-zp-phantom]') as HTMLAnchorElement;
  const copyBtn = overlay.querySelector('[data-zp-copy]') as HTMLButtonElement;
  const statusEl = overlay.querySelector('[data-zp-status]') as HTMLElement;
  const statusTextEl = overlay.querySelector('[data-zp-status-text]') as HTMLElement;

  const abortCtrl = new AbortController();
  let intentRef: PaymentIntent | null = null;
  let closed = false;

  function setStatus(state: 'loading' | 'success' | 'error' | 'info', text: string, withSpinner = false): void {
    statusEl.dataset.state = state;
    const spinnerHtml = withSpinner ? '<span class="zp-spinner" aria-hidden="true"></span>' : '';
    statusEl.innerHTML = `${spinnerHtml}<span data-zp-status-text>${escapeHtml(text)}</span>`;
  }

  function close(reason: WidgetCancelEvent['reason'] = 'user_dismissed'): void {
    if (closed) return;
    closed = true;
    abortCtrl.abort();
    document.removeEventListener('keydown', onKeydown);
    overlay.removeEventListener('click', onOverlayClick);
    overlay.remove();
    const event: WidgetCancelEvent = { paymentId: intentRef?.id ?? null, reason };
    broadcast({ source: 'zettapay-widget', type: 'cancel', paymentId: event.paymentId, reason });
    rawConfig.onCancel?.(event);
  }

  function fail(code: string, message: string, cause?: unknown): void {
    const event: WidgetErrorEvent = { paymentId: intentRef?.id ?? null, code, message, cause };
    setStatus('error', message);
    broadcast({ source: 'zettapay-widget', type: 'error', paymentId: event.paymentId, code, message });
    rawConfig.onError?.(event);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') close('esc_pressed');
  }
  function onOverlayClick(e: MouseEvent): void {
    if (e.target === overlay) close('overlay_clicked');
  }

  closeBtn.addEventListener('click', () => close('user_dismissed'));
  document.addEventListener('keydown', onKeydown);
  overlay.addEventListener('click', onOverlayClick);

  document.body.appendChild(overlay);
  card.focus({ preventScroll: true });

  void (async (): Promise<void> => {
    try {
      const intent = await createPaymentIntent({
        apiBase: cfg.apiBase,
        merchantId: cfg.merchantId,
        amount: cfg.amount,
        currency: cfg.currency,
        metadata: cfg.metadata,
      });
      if (closed) return;
      intentRef = intent;

      const checkoutUrl = checkoutUrlFor(intent, cfg.checkoutBase);
      const phantomUrl = phantomDeeplink(checkoutUrl);

      qrWrap.innerHTML = renderQrSvg(checkoutUrl, { size: 240 });
      phantomLink.href = phantomUrl;
      phantomLink.removeAttribute('aria-disabled');
      copyBtn.disabled = false;
      copyBtn.addEventListener('click', () => {
        void copyToClipboard(checkoutUrl).then((ok) => {
          if (!ok) return;
          const label = copyBtn.querySelector('span');
          if (!label) return;
          const original = label.textContent ?? 'Copy checkout link';
          label.textContent = 'Copied ✓';
          setTimeout(() => { label.textContent = original; }, 1800);
        });
      });

      const openEvent: WidgetOpenEvent = { paymentId: intent.id, intent };
      broadcast({ source: 'zettapay-widget', type: 'open', paymentId: intent.id });
      rawConfig.onOpen?.(openEvent);
      setStatus('loading', 'Waiting for payment…', true);

      const result = await pollPaymentStatus({
        apiBase: cfg.apiBase,
        paymentId: intent.id,
        signal: abortCtrl.signal,
      });
      if (closed) return;

      if (result.status === 'completed') {
        setStatus('success', 'Payment received ✓');
        const success: WidgetSuccessEvent = {
          paymentId: result.intent.id,
          txSignature: result.intent.txSignature ?? null,
          intent: result.intent,
        };
        broadcast({
          source: 'zettapay-widget',
          type: 'success',
          paymentId: success.paymentId,
          txSignature: success.txSignature,
        });
        rawConfig.onSuccess?.(success);
        // Auto-dismiss after a short victory beat.
        setTimeout(() => {
          if (!closed) {
            closed = true;
            abortCtrl.abort();
            document.removeEventListener('keydown', onKeydown);
            overlay.removeEventListener('click', onOverlayClick);
            overlay.remove();
          }
        }, 1600);
        return;
      }

      if (result.status === 'timeout') {
        fail('timeout', 'Payment was not received in time. The intent is still valid — try again.');
        return;
      }

      fail(result.status, `Payment ${result.status}.`);
    } catch (err) {
      if (closed) return;
      if (err instanceof ApiError) {
        fail(err.code, err.message, err);
      } else {
        fail('unknown', (err as Error).message ?? 'Unexpected error', err);
      }
    }
  })();

  return { close };
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const c = (navigator as { clipboard?: Clipboard }).clipboard;
    if (c?.writeText) {
      await c.writeText(text);
      return true;
    }
  } catch {
    // Some browsers reject writeText outside a user gesture (rare here, but
    // possible if the click was synthetic). Fall through to the textarea hack.
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(s: string | number): string {
  return String(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}
