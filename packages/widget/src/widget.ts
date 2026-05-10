import { openCheckout } from './modal.js';
import { injectStylesOnce } from './styles.js';
import type { WidgetConfig } from './types.js';

/**
 * Renders a Pay button into `target`. Returns an `unmount()` cleanup so SPA
 * frameworks can detach the widget when the host component unmounts.
 */
export function mount(target: HTMLElement, config: WidgetConfig): { unmount(): void } {
  injectStylesOnce();
  const button = buildButton(config);
  button.addEventListener('click', () => {
    openCheckout(config);
  });
  target.appendChild(button);
  return {
    unmount(): void {
      button.remove();
    },
  };
}

/** Programmatic open without rendering a button. */
export function open(config: WidgetConfig): { close(): void } {
  injectStylesOnce();
  return openCheckout(config);
}

function buildButton(config: WidgetConfig): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'zp-btn zp-widget';
  btn.setAttribute('data-zettapay-button', '');
  const currency = (config.currency ?? 'USDC').toUpperCase();
  const label = config.label ?? `Pay ${formatAmount(config.amount)} ${currency}`;
  btn.innerHTML = `${SOLANA_ICON}<span>${escapeHtml(label)}</span>`;
  return btn;
}

function formatAmount(amount: number): string {
  if (!Number.isFinite(amount)) return String(amount);
  if (Number.isInteger(amount)) return String(amount);
  // Trim trailing zeros — `10.5` not `10.50`.
  return amount.toFixed(2).replace(/\.?0+$/, '');
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

const SOLANA_ICON = '<svg class="zp-btn-icon" viewBox="0 0 397.7 311.7" aria-hidden="true"><linearGradient id="zp-sol-a" gradientUnits="userSpaceOnUse" x1="360.879" y1="351.455" x2="141.213" y2="-69.294" gradientTransform="matrix(1 0 0 -1 0 314)"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".95"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient><path fill="url(#zp-sol-a)" d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7zM64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8zM333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.6z"/></svg>';

export type { WidgetConfig } from './types.js';
