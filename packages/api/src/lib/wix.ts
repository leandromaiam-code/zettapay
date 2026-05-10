/**
 * Wix App Market integration.
 *
 * Wix surfaces two paradigms a third-party can plug into:
 *
 *  1. **Wix Velo** — the merchant writes JS that runs in the Wix CMS
 *     (backend `.web.js` modules + page-level frontend code). We expose a
 *     pre-built backend module they paste into `backend/zettapay.web.js` and a
 *     short page snippet that wires a Wix button to the checkout modal.
 *
 *  2. **Wix App Market submission** — a static manifest describing the app
 *     (slug, scopes, components, OAuth endpoints). The Wix submission tool
 *     consumes this; the `/wix/manifest.json` route serves it.
 *
 * Token replacement in the Velo modules:
 *   __ZETTAPAY_API_BASE__   the public origin the page calls into
 *   __ZETTAPAY_PAY_BASE__   the public origin the checkout iframe loads from
 *   __ZETTAPAY_BUILD_ID__   short build identifier baked at request time
 *   __ZETTAPAY_MERCHANT__   merchant id baked into per-merchant modules
 */

const WIX_APP_SLUG = "zettapay-wix-app";

const VELO_BACKEND_TEMPLATE = `// ZettaPay · Wix Velo backend module — paste into backend/zettapay.web.js
// Build: __ZETTAPAY_BUILD_ID__
import { Permissions, webMethod } from 'wix-web-module';
import { fetch } from 'wix-fetch';

const API_BASE = '__ZETTAPAY_API_BASE__';
const PAY_BASE = '__ZETTAPAY_PAY_BASE__';
const MERCHANT_ID = '__ZETTAPAY_MERCHANT__';

function trimSlashes(s) {
  return String(s || '').replace(/\\/+$/, '');
}

function isPositiveAmount(v) {
  if (v == null) return false;
  const n = String(v).trim();
  return /^[0-9]+(?:\\.[0-9]{1,8})?$/.test(n) && Number(n) > 0;
}

function buildCheckoutUrl(opts) {
  const base = trimSlashes(PAY_BASE);
  const params = ['merchant=' + encodeURIComponent(MERCHANT_ID)];
  if (opts && opts.amount && isPositiveAmount(opts.amount)) {
    params.push('amount=' + encodeURIComponent(String(opts.amount)));
  }
  if (opts && opts.currency) {
    params.push('currency=' + encodeURIComponent(String(opts.currency).slice(0, 8)));
  }
  if (opts && opts.orderRef) {
    params.push('order_ref=' + encodeURIComponent(String(opts.orderRef).slice(0, 64)));
  }
  if (opts && opts.successUrl && /^https?:\\/\\//i.test(opts.successUrl)) {
    params.push('success_url=' + encodeURIComponent(opts.successUrl));
  }
  if (opts && opts.cancelUrl && /^https?:\\/\\//i.test(opts.cancelUrl)) {
    params.push('cancel_url=' + encodeURIComponent(opts.cancelUrl));
  }
  params.push('source=wix');
  return base + '/pay/checkout?' + params.join('&');
}

/**
 * createCheckout({ amount, currency, orderRef, successUrl, cancelUrl })
 *   → { url, merchantId, source }
 *
 * Called from the Wix page module. Returns a checkout URL the page opens in
 * an iframe / popup. Permissions.Anyone so anonymous shoppers can pay.
 */
export const createCheckout = webMethod(Permissions.Anyone, async function (opts) {
  const url = buildCheckoutUrl(opts || {});
  return { url: url, merchantId: MERCHANT_ID, source: 'wix' };
});

/**
 * fetchPaymentStatus(paymentId) → { id, status, amountUsdc?, completedAt? }
 *
 * Page-level polling helper for orders that opened the checkout modal. Hits
 * GET /pay/{id} on the public API. Anyone can read because payment ids are
 * unguessable (ULIDs).
 */
export const fetchPaymentStatus = webMethod(Permissions.Anyone, async function (paymentId) {
  const id = String(paymentId || '').trim();
  if (!/^[a-zA-Z0-9_:-]{8,80}$/.test(id)) {
    return { id: '', status: 'invalid' };
  }
  const res = await fetch(trimSlashes(API_BASE) + '/pay/' + encodeURIComponent(id), {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    return { id: id, status: 'unknown' };
  }
  const body = await res.json();
  return {
    id: body && body.id ? String(body.id) : id,
    status: body && body.status ? String(body.status) : 'unknown',
    amountUsdc: body && body.amount_usdc ? String(body.amount_usdc) : undefined,
    completedAt: body && body.completed_at ? String(body.completed_at) : undefined,
  };
});

/**
 * pluginInfo() → { slug, version, merchantId, apiBase }
 * Useful for support / debugging when a merchant pings us.
 */
export const pluginInfo = webMethod(Permissions.Anyone, async function () {
  return {
    slug: '${WIX_APP_SLUG}',
    version: '__ZETTAPAY_BUILD_ID__',
    merchantId: MERCHANT_ID,
    apiBase: trimSlashes(API_BASE),
  };
});
`;

const VELO_PAGE_TEMPLATE = `// ZettaPay · Wix Velo page module
// Paste into the page code where you placed the Pay button (#zpPayButton).
// Customize the element ids to match your design.
//
// Build: __ZETTAPAY_BUILD_ID__
import { createCheckout, fetchPaymentStatus } from 'backend/zettapay.web.js';
import wixWindow from 'wix-window';

// --- Configure these to match your page elements -------------------------
const PAY_BUTTON_ID = '#zpPayButton';
const STATUS_TEXT_ID = '#zpStatusText';
const AMOUNT_INPUT_ID = '#zpAmount'; // optional — omit if amount is fixed

// Default amount used when there is no #zpAmount input on the page.
const DEFAULT_AMOUNT = '10.00';
const DEFAULT_CURRENCY = 'USDC';
// -------------------------------------------------------------------------

let pollHandle = null;

function setStatus(text) {
  const el = $w(STATUS_TEXT_ID);
  if (el && typeof el.text !== 'undefined') el.text = String(text || '');
}

function readAmount() {
  const input = $w(AMOUNT_INPUT_ID);
  if (input && typeof input.value === 'string' && input.value) return input.value;
  return DEFAULT_AMOUNT;
}

async function openZettaPay() {
  setStatus('Abrindo checkout…');
  const res = await createCheckout({
    amount: readAmount(),
    currency: DEFAULT_CURRENCY,
    orderRef: 'wix-' + Date.now(),
  });
  const popup = await wixWindow.openLightbox('zettapay-checkout', { url: res.url });
  if (popup && popup.paymentId) startPolling(popup.paymentId);
  else setStatus('');
}

function startPolling(paymentId) {
  setStatus('Aguardando confirmação…');
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(async function () {
    const status = await fetchPaymentStatus(paymentId);
    if (status.status === 'completed') {
      clearInterval(pollHandle);
      pollHandle = null;
      setStatus('Pagamento confirmado · ' + (status.amountUsdc || '') + ' USDC');
    } else if (status.status === 'failed' || status.status === 'cancelled') {
      clearInterval(pollHandle);
      pollHandle = null;
      setStatus('Pagamento ' + status.status);
    }
  }, 4000);
}

$w.onReady(function () {
  const btn = $w(PAY_BUTTON_ID);
  if (btn && typeof btn.onClick === 'function') {
    btn.onClick(openZettaPay);
  }
});
`;

export interface RenderVeloModuleInput {
  /** Public origin of the ZettaPay API (used by wix-fetch). */
  apiBase: string;
  /** Public origin the checkout iframe loads from (often equal to apiBase). */
  payBase: string;
  /** Short build/version identifier baked into the module (cache busting + support). */
  buildId: string;
  /** Merchant id baked into the per-merchant module. */
  merchantId: string;
}

export function renderWixVeloBackendModule(input: RenderVeloModuleInput): string {
  const safeApiBase = sanitizeForJsString(input.apiBase || "");
  const safePayBase = sanitizeForJsString(input.payBase || "");
  const safeBuildId = sanitizeForJsString(input.buildId || "");
  const safeMerchant = sanitizeForJsString(input.merchantId || "");
  return VELO_BACKEND_TEMPLATE
    .replace(/__ZETTAPAY_API_BASE__/g, safeApiBase)
    .replace(/__ZETTAPAY_PAY_BASE__/g, safePayBase)
    .replace(/__ZETTAPAY_BUILD_ID__/g, safeBuildId)
    .replace(/__ZETTAPAY_MERCHANT__/g, safeMerchant);
}

export function renderWixVeloPageModule(input: Pick<RenderVeloModuleInput, "buildId">): string {
  const safeBuildId = sanitizeForJsString(input.buildId || "");
  return VELO_PAGE_TEMPLATE.replace(/__ZETTAPAY_BUILD_ID__/g, safeBuildId);
}

export interface RenderManifestInput {
  /** Public origin of the API (used as the OAuth + webhook root). */
  apiBase: string;
  /** Plugin/build version surfaced to the App Market reviewer. */
  buildId: string;
}

export interface WixAppManifest {
  slug: string;
  name: string;
  vendor: string;
  version: string;
  description: string;
  permissions: string[];
  components: Array<{
    type: string;
    name: string;
    description: string;
  }>;
  oauth: {
    install_url: string;
    redirect_uri: string;
    token_url: string;
  };
  endpoints: {
    velo_backend_module: string;
    velo_page_module: string;
    plugin_info: string;
  };
  webhook: {
    url: string;
    events: string[];
  };
  support: {
    homepage: string;
    docs: string;
    contact: string;
  };
}

/**
 * App Market submission manifest. The Wix review team consumes this when the
 * vendor uploads their app — fields mirror Wix's `wix-developer.json` schema
 * (slug, components, permissions, OAuth + webhook URLs). The manifest is
 * intentionally JSON-serializable so it's the same payload returned by the
 * `/wix/manifest.json` route.
 */
export function renderWixAppManifest(input: RenderManifestInput): WixAppManifest {
  const base = trimSlashes(input.apiBase || "");
  const version = input.buildId || "0.0.0";
  return {
    slug: WIX_APP_SLUG,
    name: "ZettaPay",
    vendor: "ZettaPay",
    version,
    description:
      "Aceite USDC liquidado em segundos via Solana. Fees 10x menores que cartão, sem custódia.",
    permissions: [
      "wix.fetch.outbound",
      "wix.users.read",
      "wix.stores.orders.read",
    ],
    components: [
      {
        type: "velo_backend_module",
        name: "zettapay.web.js",
        description:
          "Backend module exposing createCheckout, fetchPaymentStatus and pluginInfo to page code.",
      },
      {
        type: "velo_page_module",
        name: "zettapay-checkout.js",
        description:
          "Page-level script that wires a Wix button to the ZettaPay hosted checkout lightbox.",
      },
      {
        type: "lightbox",
        name: "zettapay-checkout",
        description:
          "Lightbox containing the ZettaPay hosted checkout iframe. Reports paymentId back to the host page.",
      },
    ],
    oauth: {
      install_url: `${base}/wix/install`,
      redirect_uri: `${base}/wix/callback`,
      token_url: `${base}/wix/token`,
    },
    endpoints: {
      velo_backend_module: `${base}/wix/velo/backend/<merchantId>`,
      velo_page_module: `${base}/wix/velo/page`,
      plugin_info: `${base}/wix/app/info`,
    },
    webhook: {
      url: `${base}/wix/webhook`,
      events: ["payment.completed", "payment.failed", "payment.refunded"],
    },
    support: {
      homepage: "https://zettapay.io/wix",
      docs: "https://zettapay.io/docs/integrations/wix",
      contact: "support@zettapay.io",
    },
  };
}

export { WIX_APP_SLUG };

function sanitizeForJsString(s: string): string {
  return s.replace(/[\\'"<>\r\n\u2028\u2029]/g, (c) => {
    switch (c) {
      case "\\":
        return "\\\\";
      case "'":
        return "\\'";
      case '"':
        return '\\"';
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "\r":
        return "\\r";
      case "\n":
        return "\\n";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return c;
    }
  });
}

function trimSlashes(s: string): string {
  return String(s || "").replace(/\/+$/, "");
}
