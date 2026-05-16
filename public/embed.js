/**
 * ZettaPay Embed Widget — drop-in <script> tag for any site
 *
 * Wallet-less by design: opens a modal showing a Solana Pay QR code + the
 * merchant USDC address. The customer pays from their wallet of choice
 * (Phantom, Solflare, hardware wallet, mobile, exchange) — no extension,
 * no connect, no signature prompt from this page.
 *
 * Usage:
 *   <script src="https://zettapay.vercel.app/embed.js"
 *           data-merchant="m_xxx"
 *           data-pk="pk_live_xxx"
 *           data-amount="10"        (optional, USDC)
 *           data-currency="USDC"    (optional, default USDC)
 *           data-label="Pay 10 USDC"  (optional, button text)
 *           data-mount="#zettapay-button"  (optional, CSS selector; default: insert after <script>)
 *           data-network="mainnet"    (optional, default "devnet"; accepts "mainnet"|"devnet")
 *           defer></script>
 */
(function () {
  'use strict';

  var BASE = (function () {
    try {
      var s = document.currentScript || document.querySelector('script[src*="zettapay"][src$="embed.js"]');
      if (s && s.src) return new URL(s.src).origin;
    } catch (e) {}
    return 'https://zettapay.vercel.app';
  })();

  var SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  var USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  var USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  var QR_CDN = 'https://unpkg.com/qrcode@1.5.3/build/qrcode.min.js';

  function normalizeNetwork(value) {
    var v = String(value || '').toLowerCase().trim();
    if (v === 'mainnet' || v === 'mainnet-beta' || v === 'main') return 'mainnet';
    return 'devnet';
  }

  function mintForNetwork(network) {
    return network === 'mainnet' ? USDC_MINT_MAINNET : USDC_MINT_DEVNET;
  }

  function labelForNetwork(network) {
    return network === 'mainnet' ? 'Solana Mainnet' : 'Solana Devnet';
  }

  function getScriptTag() {
    return document.currentScript || document.querySelector('script[src*="zettapay"][src$="embed.js"]');
  }

  function loadConfig() {
    var s = getScriptTag();
    if (!s) return null;
    return {
      merchant: s.getAttribute('data-merchant'),
      pk: s.getAttribute('data-pk'),
      amount: s.getAttribute('data-amount') || '',
      currency: s.getAttribute('data-currency') || 'USDC',
      label: s.getAttribute('data-label') || (s.getAttribute('data-amount') ? 'Pay ' + s.getAttribute('data-amount') + ' USDC' : 'Pay with USDC'),
      mount: s.getAttribute('data-mount') || null,
      onSuccess: s.getAttribute('data-on-success') || null,
      onCancel: s.getAttribute('data-on-cancel') || null,
      network: normalizeNetwork(s.getAttribute('data-network')),
      script: s
    };
  }

  function injectStyles() {
    if (document.getElementById('zettapay-embed-styles')) return;
    var css = [
      '.zettapay-btn{display:inline-flex;align-items:center;gap:8px;padding:12px 20px;border-radius:12px;background:linear-gradient(135deg,#4F6BFF 0%,#6B85FF 100%);color:#fff;font-family:Inter,ui-sans-serif,system-ui,sans-serif;font-weight:600;font-size:14px;border:none;cursor:pointer;box-shadow:0 4px 14px rgba(79,107,255,0.35);transition:all .2s ease;text-decoration:none;}',
      '.zettapay-btn:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(79,107,255,0.45);}',
      '.zettapay-btn:active{transform:translateY(0);}',
      '.zettapay-btn:disabled{opacity:.6;cursor:not-allowed;transform:none;}',
      '.zettapay-btn .zp-z{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;background:#fff;color:#4F6BFF;border-radius:4px;font-weight:800;font-size:11px;letter-spacing:-1px;}',
      '.zettapay-modal{position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;background:rgba(10,15,30,.65);backdrop-filter:blur(8px);font-family:Inter,system-ui,sans-serif;}',
      '.zettapay-modal.open{display:flex;}',
      '.zettapay-modal-inner{background:#fff;border-radius:20px;padding:28px;max-width:440px;width:92%;box-shadow:0 24px 80px rgba(0,0,0,.4);position:relative;}',
      '.zettapay-modal-close{position:absolute;top:14px;right:14px;background:none;border:none;font-size:22px;color:#666;cursor:pointer;width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;}',
      '.zettapay-modal-close:hover{background:#f3f4f6;}',
      '.zettapay-modal h3{font-size:20px;font-weight:700;color:#0a0a0a;margin:0 0 4px;}',
      '.zettapay-modal p.zp-sub{font-size:13px;color:#666;margin:0 0 16px;}',
      '.zettapay-row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f3f4f6;font-size:13px;}',
      '.zettapay-row .label{color:#666;}',
      '.zettapay-row .value{color:#0a0a0a;font-weight:600;font-family:ui-monospace,monospace;}',
      '.zettapay-qr{display:flex;justify-content:center;margin:16px 0 12px;}',
      '.zettapay-qr img{background:#fff;padding:8px;border-radius:12px;width:200px;height:200px;border:1px solid #e5e7eb;}',
      '.zettapay-addr{background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;font-family:ui-monospace,monospace;font-size:11px;color:#0a0a0a;word-break:break-all;margin-bottom:10px;transition:background .4s,border-color .4s;}',
      '.zettapay-addr.zp-copied{background:#d1fae5;border-color:#34d399;}',
      '.zettapay-actions{display:flex;gap:8px;margin-bottom:10px;}',
      '.zettapay-actions button,.zettapay-actions a{flex:1;padding:11px 12px;border-radius:10px;font-size:13px;font-weight:600;font-family:Inter,system-ui,sans-serif;text-align:center;text-decoration:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:all .15s;}',
      '.zp-btn-secondary{background:#f3f4f6;color:#0a0a0a;border:1px solid #e5e7eb;}',
      '.zp-btn-secondary:hover{background:#e5e7eb;}',
      '.zp-btn-primary{background:linear-gradient(135deg,#4F6BFF,#6B85FF);color:#fff;border:none;}',
      '.zp-btn-primary:hover{transform:translateY(-1px);}',
      '.zettapay-status{margin-top:12px;padding:10px 12px;border-radius:10px;font-size:12px;font-family:ui-monospace,monospace;display:flex;align-items:center;gap:8px;background:#eef2ff;color:#3730a3;}',
      '.zettapay-status .zp-dot{width:7px;height:7px;border-radius:50%;background:#14F195;animation:zpPulse 1.4s infinite;}',
      '@keyframes zpPulse{0%,100%{opacity:.4}50%{opacity:1}}',
      '.zettapay-helper{font-size:11px;color:#888;margin-top:10px;line-height:1.5;}',
      '.zettapay-foot{margin-top:14px;text-align:center;font-size:11px;color:#999;}',
      '.zettapay-foot a{color:#4F6BFF;text-decoration:none;}',
      '.zettapay-error{margin-top:12px;padding:10px 12px;border-radius:10px;font-size:12px;background:#fee2e2;color:#991b1b;display:none;}',
      '.zettapay-error.show{display:block;}'
    ].join('\n');
    var style = document.createElement('style');
    style.id = 'zettapay-embed-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildButton(config) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'zettapay-btn';
    btn.setAttribute('data-zettapay', 'pay-button');
    btn.innerHTML = '<span class="zp-z">Z</span>' + escapeHTML(config.label);
    btn.addEventListener('click', function () { openModal(config); });
    return btn;
  }

  function escapeHTML(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function buildModal(config) {
    var existing = document.getElementById('zettapay-modal');
    if (existing) return existing;
    var el = document.createElement('div');
    el.id = 'zettapay-modal';
    el.className = 'zettapay-modal';
    el.innerHTML =
      '<div class="zettapay-modal-inner">' +
      '<button type="button" class="zettapay-modal-close" data-zp-close>×</button>' +
      '<h3>Pay with Solana</h3>' +
      '<p class="zp-sub">Scan or paste — no wallet connect required.</p>' +
      '<div class="zettapay-row"><span class="label">Merchant</span><span class="value" data-zp-merchant>' + escapeHTML(config.merchant) + '</span></div>' +
      (config.amount ? '<div class="zettapay-row"><span class="label">Amount</span><span class="value">' + escapeHTML(config.amount) + ' ' + escapeHTML(config.currency) + '</span></div>' : '') +
      '<div class="zettapay-row"><span class="label">Network</span><span class="value">' + escapeHTML(labelForNetwork(config.network)) + '</span></div>' +
      '<div class="zettapay-qr"><img alt="Solana Pay QR" data-zp-qr /></div>' +
      '<div class="zettapay-addr" data-zp-addr>Loading merchant address…</div>' +
      '<div class="zettapay-actions">' +
      '<button type="button" class="zp-btn-secondary" data-zp-copy>Copy address</button>' +
      '<a class="zp-btn-primary" data-zp-open href="#" target="_blank" rel="noopener">Open in wallet</a>' +
      '</div>' +
      '<div class="zettapay-status"><span class="zp-dot"></span><span>Awaiting payment on-chain</span></div>' +
      '<p class="zettapay-helper">Open any Solana wallet (Phantom, Solflare, hardware wallet, mobile, exchange), scan the QR or paste the address, then send the amount. ZettaPay watches the chain — the merchant is notified on confirmation.</p>' +
      '<div class="zettapay-error" data-zp-error></div>' +
      '<div class="zettapay-foot">Powered by <a href="' + BASE + '" target="_blank" rel="noopener">ZettaPay</a></div>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener('click', function (e) {
      if (e.target === el || e.target.hasAttribute('data-zp-close')) closeModal();
    });
    var copyBtn = el.querySelector('[data-zp-copy]');
    copyBtn.addEventListener('click', function () { handleCopy(el); });
    return el;
  }

  function openModal(config) {
    injectStyles();
    var modal = buildModal(config);
    modal.classList.add('open');
    showError(modal, '');
    bootPayment(config, modal);
  }

  function closeModal() {
    var modal = document.getElementById('zettapay-modal');
    if (modal) modal.classList.remove('open');
  }

  function showError(modal, text) {
    var el = modal.querySelector('[data-zp-error]');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('show', Boolean(text));
  }

  function loadQrcodeLib() {
    if (window.QRCode) return Promise.resolve(window.QRCode);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = QR_CDN;
      s.async = true;
      s.onload = function () { resolve(window.QRCode); };
      s.onerror = function () { reject(new Error('Failed to load QR library')); };
      document.head.appendChild(s);
    });
  }

  function resolveMerchantWallet(ref, amount) {
    if (SOLANA_ADDRESS_RE.test(ref)) return Promise.resolve(ref);
    var url = BASE + '/api/simulate/' + encodeURIComponent(ref) + '?amount=' + (amount || 1);
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('Merchant lookup failed (' + r.status + ')');
        return r.json();
      })
      .then(function (data) {
        var wallet = data && data.merchant && data.merchant.walletAddress;
        if (!SOLANA_ADDRESS_RE.test(wallet || '')) {
          throw new Error('Merchant has no wallet on file');
        }
        return wallet;
      });
  }

  function buildSolanaPayUri(merchantWallet, amount, label, reference, network) {
    var params = new URLSearchParams();
    if (amount) params.set('amount', String(amount));
    params.set('spl-token', mintForNetwork(network));
    params.set('label', 'ZettaPay');
    if (label) params.set('message', label);
    if (reference) params.set('reference', reference);
    return 'solana:' + merchantWallet + '?' + params.toString();
  }

  function setQr(modal, dataUrl) {
    var img = modal.querySelector('[data-zp-qr]');
    if (img) img.src = dataUrl;
  }

  function setAddress(modal, addr) {
    var el = modal.querySelector('[data-zp-addr]');
    if (el) el.textContent = addr;
  }

  function setOpenLink(modal, uri) {
    var a = modal.querySelector('[data-zp-open]');
    if (a) a.setAttribute('href', uri);
  }

  function handleCopy(modal) {
    var el = modal.querySelector('[data-zp-addr]');
    var addr = el ? (el.textContent || '').trim() : '';
    if (!SOLANA_ADDRESS_RE.test(addr)) return;
    var flash = function () {
      el.classList.add('zp-copied');
      setTimeout(function () { el.classList.remove('zp-copied'); }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(addr).then(flash, function () { fallbackCopy(addr); flash(); });
    } else {
      fallbackCopy(addr); flash();
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  function bootPayment(config, modal) {
    var amount = parseFloat(config.amount || '0');
    if (!isFinite(amount) || amount <= 0) {
      showError(modal, 'Invalid amount on this checkout.');
      return;
    }

    resolveMerchantWallet(config.merchant, amount)
      .then(function (wallet) {
        setAddress(modal, wallet);
        var uri = buildSolanaPayUri(wallet, amount, config.label, config.merchant, config.network);
        setOpenLink(modal, uri);
        return loadQrcodeLib().then(function (lib) {
          return new Promise(function (resolve, reject) {
            lib.toDataURL(uri, { width: 400, margin: 1, color: { dark: '#0A0A0A', light: '#FFFFFF' } }, function (err, dataUrl) {
              if (err || !dataUrl) reject(err || new Error('QR render failed'));
              else resolve(dataUrl);
            });
          });
        });
      })
      .then(function (dataUrl) {
        setQr(modal, dataUrl);
        window.dispatchEvent(new CustomEvent('zettapay:ready', { detail: { merchant: config.merchant, amount: amount } }));
      })
      .catch(function (err) {
        showError(modal, (err && err.message) ? err.message : 'Unable to prepare payment.');
        if (config.onCancel && typeof window[config.onCancel] === 'function') {
          try { window[config.onCancel](err); } catch (_e) {}
        }
        window.dispatchEvent(new CustomEvent('zettapay:error', { detail: err }));
      });
  }

  function init() {
    var config = loadConfig();
    if (!config || !config.merchant) {
      console.warn('[ZettaPay] embed.js: missing data-merchant');
      return;
    }
    injectStyles();
    var btn = buildButton(config);
    if (config.mount) {
      var target = document.querySelector(config.mount);
      if (target) {
        target.appendChild(btn);
        return;
      }
      console.warn('[ZettaPay] mount target not found:', config.mount);
    }
    var s = config.script;
    if (s && s.parentNode) {
      s.parentNode.insertBefore(btn, s.nextSibling);
    } else {
      document.body.appendChild(btn);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
