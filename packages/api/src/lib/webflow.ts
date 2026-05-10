/**
 * Inline asset for the Webflow drop-in embed.
 *
 * Webflow projects can paste a single `<script src=".../webflow/embed.js">`
 * tag into their site head. The script scans the rendered page for elements
 * carrying `data-zettapay-merchant="<id>"` and turns each into a USDC checkout
 * button that opens a hosted ZettaPay checkout modal.
 *
 * The script is plain ES5 (no transpiler step on the API side) and contains no
 * runtime dependencies — Webflow merchants paste only the one tag.
 *
 * Token replacement:
 *   __ZETTAPAY_PAY_BASE__   the public origin checkouts redirect to
 *   __ZETTAPAY_BUILD_ID__   short build identifier baked at request time
 */
const SCRIPT_TEMPLATE = `(function () {
  'use strict';

  var PAY_BASE = '__ZETTAPAY_PAY_BASE__';
  var BUILD_ID = '__ZETTAPAY_BUILD_ID__';
  var ATTR = 'data-zettapay-merchant';
  var INIT_FLAG = '__zettapayInit';
  var MOUNTED_FLAG = '__zettapayMounted';

  function trimSlashes(s) {
    return String(s || '').replace(/\\/+$/, '');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[<>&"']/g, function (c) {
      if (c === '<') return '&lt;';
      if (c === '>') return '&gt;';
      if (c === '&') return '&amp;';
      if (c === '"') return '&quot;';
      return '&#39;';
    });
  }

  function buildCheckoutUrl(merchantId, opts) {
    var base = trimSlashes(PAY_BASE);
    var qs = ['merchant=' + encodeURIComponent(merchantId)];
    if (opts.amount) qs.push('amount=' + encodeURIComponent(opts.amount));
    if (opts.currency) qs.push('currency=' + encodeURIComponent(opts.currency));
    if (opts.orderRef) qs.push('order_ref=' + encodeURIComponent(opts.orderRef));
    if (opts.successUrl) qs.push('success_url=' + encodeURIComponent(opts.successUrl));
    if (opts.cancelUrl) qs.push('cancel_url=' + encodeURIComponent(opts.cancelUrl));
    qs.push('source=webflow');
    return base + '/pay/checkout?' + qs.join('&');
  }

  function injectStyles() {
    if (document.getElementById('zettapay-embed-styles')) return;
    var s = document.createElement('style');
    s.id = 'zettapay-embed-styles';
    s.textContent = [
      '.zp-btn{display:inline-flex;align-items:center;gap:10px;',
      'padding:12px 20px;border-radius:10px;border:0;cursor:pointer;',
      'background:#0a1612;color:#f5e6c8;text-decoration:none;',
      'font-family:Manrope,system-ui,-apple-system,Segoe UI,sans-serif;',
      'font-size:15px;line-height:1;transition:transform .15s ease,box-shadow .15s ease;}',
      '.zp-btn:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(212,169,97,.25);}',
      '.zp-btn:focus-visible{outline:2px solid #d4a961;outline-offset:2px;}',
      '.zp-btn__brand{font-family:Cinzel,Cormorant Garamond,serif;font-weight:600;',
      'color:#d4a961;letter-spacing:.12em;text-transform:uppercase;font-size:13px;}',
      '.zp-btn__amount{opacity:.85;font-variant-numeric:tabular-nums;}',
      '.zp-modal{position:fixed;inset:0;z-index:2147483600;display:flex;',
      'align-items:center;justify-content:center;background:rgba(10,22,18,.72);',
      'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}',
      '.zp-modal__frame{position:relative;width:min(440px,calc(100% - 32px));',
      'height:min(680px,calc(100% - 64px));border-radius:18px;overflow:hidden;',
      'box-shadow:0 24px 64px rgba(0,0,0,.5),0 0 0 1px rgba(212,169,97,.2);',
      'background:#0a1612;}',
      '.zp-modal__iframe{width:100%;height:100%;border:0;display:block;background:#0a1612;}',
      '.zp-modal__close{position:absolute;top:10px;right:10px;width:32px;height:32px;',
      'border-radius:50%;border:0;cursor:pointer;background:rgba(245,230,200,.12);',
      'color:#f5e6c8;font-size:18px;line-height:32px;text-align:center;',
      'font-family:inherit;}',
      '.zp-modal__close:hover{background:rgba(245,230,200,.22);}',
      '@media (max-width:480px){.zp-modal__frame{width:100%;height:100%;border-radius:0;}}'
    ].join('');
    document.head.appendChild(s);
  }

  function readNumberAttr(el, name) {
    var raw = el.getAttribute(name);
    if (!raw) return '';
    var n = String(raw).trim();
    return /^[0-9]+(?:\\.[0-9]+)?$/.test(n) ? n : '';
  }

  function readSafeUrl(el, name) {
    var raw = el.getAttribute(name);
    if (!raw) return '';
    var v = String(raw).trim();
    return /^https?:\\/\\//i.test(v) ? v : '';
  }

  function readMerchantId(el) {
    var raw = el.getAttribute(ATTR);
    if (!raw) return '';
    var v = String(raw).trim();
    return /^[a-zA-Z0-9_:-]{1,80}$/.test(v) ? v : '';
  }

  function buildOpts(el) {
    return {
      amount: readNumberAttr(el, 'data-zettapay-amount'),
      currency: (el.getAttribute('data-zettapay-currency') || 'USDC').replace(/[^A-Za-z]/g, '').slice(0, 8),
      orderRef: (el.getAttribute('data-zettapay-order-ref') || '').slice(0, 64),
      successUrl: readSafeUrl(el, 'data-zettapay-success-url'),
      cancelUrl: readSafeUrl(el, 'data-zettapay-cancel-url')
    };
  }

  function formatAmountLabel(opts) {
    if (!opts.amount) return '';
    return opts.amount + ' ' + (opts.currency || 'USDC');
  }

  function renderButtonInto(host, merchantId, opts) {
    var label = host.getAttribute('data-zettapay-label') || 'Pagar com USDC';
    var amountLabel = formatAmountLabel(opts);
    host.innerHTML = ''
      + '<span class="zp-btn__brand">ZettaPay</span>'
      + '<span class="zp-btn__label">' + escapeHtml(label) + '</span>'
      + (amountLabel ? '<span class="zp-btn__amount">' + escapeHtml(amountLabel) + '</span>' : '');
    host.classList.add('zp-btn');
    host.setAttribute('role', 'button');
    host.setAttribute('tabindex', '0');
    host.setAttribute('aria-label', label + (amountLabel ? ' ' + amountLabel : ''));
  }

  var openOverlay = null;

  function closeModal() {
    if (!openOverlay) return;
    var node = openOverlay;
    openOverlay = null;
    document.removeEventListener('keydown', onKeyDown);
    if (node.parentNode) node.parentNode.removeChild(node);
  }

  function onKeyDown(ev) {
    if (ev.key === 'Escape' || ev.keyCode === 27) closeModal();
  }

  function openCheckoutModal(href) {
    closeModal();
    var overlay = document.createElement('div');
    overlay.className = 'zp-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'ZettaPay checkout');

    var frame = document.createElement('div');
    frame.className = 'zp-modal__frame';

    var iframe = document.createElement('iframe');
    iframe.className = 'zp-modal__iframe';
    iframe.src = href;
    iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
    iframe.setAttribute('title', 'ZettaPay checkout');

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'zp-modal__close';
    close.setAttribute('aria-label', 'Fechar checkout');
    close.innerHTML = '&times;';
    close.addEventListener('click', closeModal);

    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) closeModal();
    });

    frame.appendChild(iframe);
    frame.appendChild(close);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
    openOverlay = overlay;
    document.addEventListener('keydown', onKeyDown);
  }

  function onActivate(el, ev) {
    if (ev) {
      ev.preventDefault();
      if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
    }
    var merchantId = readMerchantId(el);
    if (!merchantId) return;
    var href = buildCheckoutUrl(merchantId, buildOpts(el));
    openCheckoutModal(href);
  }

  function attachHandlers(el) {
    el.addEventListener('click', function (ev) { onActivate(el, ev); });
    el.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.keyCode === 13 || ev.keyCode === 32) {
        onActivate(el, ev);
      }
    });
  }

  function mountElement(el) {
    if (el[MOUNTED_FLAG]) return;
    var merchantId = readMerchantId(el);
    if (!merchantId) return;
    el[MOUNTED_FLAG] = true;
    var opts = buildOpts(el);
    renderButtonInto(el, merchantId, opts);
    attachHandlers(el);
  }

  function scan(root) {
    var nodes = (root || document).querySelectorAll('[' + ATTR + ']');
    for (var i = 0; i < nodes.length; i++) mountElement(nodes[i]);
  }

  function watchForLateNodes() {
    if (typeof MutationObserver === 'undefined') return;
    var obs = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          if (n.hasAttribute && n.hasAttribute(ATTR)) mountElement(n);
          if (n.querySelectorAll) scan(n);
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    if (window[INIT_FLAG]) return;
    window[INIT_FLAG] = true;
    injectStyles();
    scan(document);
    watchForLateNodes();
  }

  if (window.ZettaPay && window.ZettaPay.__loaded) return;
  window.ZettaPay = {
    __loaded: true,
    buildId: BUILD_ID,
    payBase: PAY_BASE,
    mount: function (el) { mountElement(el); },
    open: function (merchantId, opts) {
      if (!merchantId) return;
      openCheckoutModal(buildCheckoutUrl(String(merchantId), opts || {}));
    },
    close: closeModal
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`;

export interface RenderEmbedScriptInput {
  /** Public origin the checkout will load from. Trailing slash trimmed. */
  payBase: string;
  /** Short build/version identifier baked into the script (cache busting). */
  buildId: string;
}

export function renderWebflowEmbedScript(input: RenderEmbedScriptInput): string {
  const safePayBase = sanitizeForJsString(input.payBase || "");
  const safeBuildId = sanitizeForJsString(input.buildId || "");
  return SCRIPT_TEMPLATE
    .replace(/__ZETTAPAY_PAY_BASE__/g, safePayBase)
    .replace(/__ZETTAPAY_BUILD_ID__/g, safeBuildId);
}

export interface RenderEmbedSnippetInput {
  merchantId: string;
  merchantName: string;
  scriptUrl: string;
}

/**
 * Static HTML snippet a merchant can copy-paste into a Webflow Embed block.
 * Renders a button container with all data attributes pre-filled with the
 * merchant id and a sample amount; the merchant edits the amount/orderRef in
 * Webflow Designer per page or per CMS item.
 */
export function renderWebflowEmbedSnippet(input: RenderEmbedSnippetInput): string {
  const merchantId = sanitizeForHtmlAttr(input.merchantId);
  const merchantName = escapeHtml(input.merchantName);
  const scriptUrl = sanitizeForHtmlAttr(input.scriptUrl);
  return [
    `<!-- ZettaPay · Webflow embed -->`,
    `<!-- Merchant: ${merchantName} (${merchantId}) -->`,
    `<div`,
    `  class="zettapay-checkout"`,
    `  data-zettapay-merchant="${merchantId}"`,
    `  data-zettapay-amount="10.00"`,
    `  data-zettapay-currency="USDC"`,
    `  data-zettapay-label="Pagar com USDC"`,
    `></div>`,
    `<script src="${scriptUrl}" defer></script>`,
    ``,
  ].join("\n");
}

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

function sanitizeForHtmlAttr(s: string): string {
  return String(s).replace(/[<>"'&]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      case "&":
        return "&amp;";
      default:
        return c;
    }
  });
}

function escapeHtml(s: string): string {
  return sanitizeForHtmlAttr(s);
}
