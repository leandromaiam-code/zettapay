/**
 * Public configuration accepted by `ZettaPay.mount()` and the global
 * `data-*` attribute auto-init path. Every field except `merchantId` /
 * `amount` has a sensible default so merchants can paste a single tag and
 * be done.
 */
export interface WidgetConfig {
  /**
   * Merchant handle (e.g. `@yourshop`) or merchant id from the registry.
   * Required.
   */
  merchantId: string;
  /** Payment amount (numeric, in `currency` units). Required. */
  amount: number;
  /** ISO currency code. Defaults to `USDC`. Only USDC is settled in V1. */
  currency?: string;
  /** ZettaPay API base URL. Defaults to the hosted production endpoint. */
  apiBase?: string;
  /**
   * Hosted checkout origin used for QR fallback + Phantom universal link.
   * Defaults to `https://pay.zettapay.io`.
   */
  checkoutBase?: string;
  /** Button label override. Defaults to `Pay {amount} {currency}`. */
  label?: string;
  /** Light or dark modal theme. Defaults to `dark` (matches ZettaPay brand). */
  theme?: 'dark' | 'light';
  /** Free-form metadata persisted on the payment record. */
  metadata?: Record<string, unknown>;
  /**
   * If supplied, the widget mounts the Pay button into this element instead
   * of injecting it next to the script tag. Accepts a CSS selector or DOM
   * node.
   */
  target?: string | HTMLElement | null;
  /** Fired after the modal opens and a payment intent is created. */
  onOpen?: (event: WidgetOpenEvent) => void;
  /** Fired when the payment lands on-chain (status === completed). */
  onSuccess?: (event: WidgetSuccessEvent) => void;
  /** Fired when the user dismisses the modal without paying. */
  onCancel?: (event: WidgetCancelEvent) => void;
  /** Fired when an error prevents the checkout flow from progressing. */
  onError?: (event: WidgetErrorEvent) => void;
}

export interface PaymentIntent {
  id: string;
  merchantId: string;
  amount: number;
  currency: string;
  status: 'pending' | 'completed' | 'failed' | 'expired' | string;
  txSignature?: string | null;
  createdAt?: string | number;
}

export interface WidgetOpenEvent {
  paymentId: string;
  intent: PaymentIntent;
}

export interface WidgetSuccessEvent {
  paymentId: string;
  txSignature: string | null;
  intent: PaymentIntent;
}

export interface WidgetCancelEvent {
  paymentId: string | null;
  reason: 'user_dismissed' | 'esc_pressed' | 'overlay_clicked';
}

export interface WidgetErrorEvent {
  paymentId: string | null;
  code: string;
  message: string;
  cause?: unknown;
}

/**
 * postMessage payloads broadcast to `window.parent` so embedders running the
 * widget inside an iframe can react without subscribing through the JS API.
 * The `source: 'zettapay-widget'` discriminator lets parents filter foreign
 * postMessage traffic safely.
 */
export type WidgetPostMessage =
  | { source: 'zettapay-widget'; type: 'open'; paymentId: string }
  | { source: 'zettapay-widget'; type: 'success'; paymentId: string; txSignature: string | null }
  | { source: 'zettapay-widget'; type: 'cancel'; paymentId: string | null; reason: string }
  | { source: 'zettapay-widget'; type: 'error'; paymentId: string | null; code: string; message: string };

declare global {
  // Widget version is injected at build time by esbuild's `define` config.
  // eslint-disable-next-line no-var
  var __ZETTAPAY_WIDGET_VERSION__: string;
}
