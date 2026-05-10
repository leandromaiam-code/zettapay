import { mount, open } from './widget.js';
import type { WidgetConfig } from './types.js';

const VERSION = (globalThis.__ZETTAPAY_WIDGET_VERSION__ ?? 'dev') as string;

export { mount, open };
export type {
  WidgetConfig,
  WidgetOpenEvent,
  WidgetSuccessEvent,
  WidgetCancelEvent,
  WidgetErrorEvent,
  WidgetPostMessage,
  PaymentIntent,
} from './types.js';

/**
 * Auto-init: when the widget is loaded via `<script src="…/widget.js" data-merchant data-amount>`
 * the bundle reads its own dataset and renders a Pay button right after the
 * script tag. This is the canonical drop-in path documented for merchants.
 *
 * Multiple `data-zettapay` script tags on the same page are supported — each
 * mounts its own button. Programmatic users can call `ZettaPay.mount()` /
 * `ZettaPay.open()` instead and skip the auto-init entirely.
 */
function readConfigFromScript(el: HTMLScriptElement): WidgetConfig | null {
  const ds = el.dataset;
  const merchantId = ds.merchant ?? ds.merchantId;
  const amountRaw = ds.amount;
  if (!merchantId || !amountRaw) return null;
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    // eslint-disable-next-line no-console
    console.warn(`[zettapay-widget] data-amount must be a positive number, got: ${amountRaw}`);
    return null;
  }
  const cfg: WidgetConfig = {
    merchantId,
    amount,
    currency: ds.currency,
    apiBase: ds.apiBase,
    checkoutBase: ds.checkoutBase,
    label: ds.label,
    theme: (ds.theme === 'light' ? 'light' : ds.theme === 'dark' ? 'dark' : undefined),
  };
  if (ds.metadata) {
    try {
      cfg.metadata = JSON.parse(ds.metadata) as Record<string, unknown>;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[zettapay-widget] data-metadata is not valid JSON; ignored');
    }
  }
  return cfg;
}

function autoInit(): void {
  if (typeof document === 'undefined') return;
  const scripts = document.querySelectorAll<HTMLScriptElement>(
    'script[data-merchant][data-amount]:not([data-zettapay-mounted])',
  );
  scripts.forEach((script) => {
    const cfg = readConfigFromScript(script);
    if (!cfg) return;
    script.setAttribute('data-zettapay-mounted', '');
    const target = document.createElement('span');
    target.setAttribute('data-zettapay-target', '');
    script.parentNode?.insertBefore(target, script.nextSibling);
    mount(target, cfg);
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit, { once: true });
  } else {
    autoInit();
  }
}

export const version = VERSION;
