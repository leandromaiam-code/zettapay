/**
 * ZettaPay Embed Widget — drop-in <script> tag for any site
 *
 * Usage:
 *   <script src="https://zettapay.vercel.app/embed.js"
 *           data-merchant="m_xxx"
 *           data-pk="pk_live_xxx"
 *           data-amount="10"        (optional, USDC)
 *           data-currency="USDC"    (optional, default USDC)
 *           data-label="Pay 10 USDC"  (optional, button text)
 *           data-mount="#zettapay-button"  (optional, CSS selector to mount; default: inserts after <script>)
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
      '.zettapay-modal-inner{background:#fff;border-radius:20px;padding:32px;max-width:440px;width:90%;box-shadow:0 24px 80px rgba(0,0,0,.4);position:relative;}',
      '.zettapay-modal-close{position:absolute;top:16px;right:16px;background:none;border:none;font-size:22px;color:#666;cursor:pointer;width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;}',
      '.zettapay-modal-close:hover{background:#f3f4f6;}',
      '.zettapay-modal h3{font-size:22px;font-weight:700;color:#0a0a0a;margin:0 0 4px;}',
      '.zettapay-modal p{font-size:13px;color:#666;margin:0 0 20px;}',
      '.zettapay-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:14px;}',
      '.zettapay-row .label{color:#666;}',
      '.zettapay-row .value{color:#0a0a0a;font-weight:600;font-family:ui-monospace,monospace;}',
      '.zettapay-pay-btn{width:100%;margin-top:20px;padding:14px;border-radius:12px;background:linear-gradient(135deg,#4F6BFF,#6B85FF);color:#fff;border:none;font-weight:600;font-size:15px;cursor:pointer;}',
      '.zettapay-status{margin-top:16px;padding:12px;border-radius:10px;font-size:13px;font-family:ui-monospace,monospace;display:none;}',
      '.zettapay-status.show{display:block;}',
      '.zettapay-status.info{background:#eef2ff;color:#3730a3;}',
      '.zettapay-status.success{background:#d1fae5;color:#065f46;}',
      '.zettapay-status.error{background:#fee2e2;color:#991b1b;}',
      '.zettapay-foot{margin-top:14px;text-align:center;font-size:11px;color:#999;}',
      '.zettapay-foot a{color:#4F6BFF;text-decoration:none;}'
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
      '<h3>Pay with ZettaPay</h3>' +
      '<p>Solana USDC · Settles in seconds · 0.30% fee</p>' +
      '<div class="zettapay-row"><span class="label">Merchant</span><span class="value" data-zp-merchant>' + escapeHTML(config.merchant) + '</span></div>' +
      (config.amount ? '<div class="zettapay-row"><span class="label">Amount</span><span class="value">' + escapeHTML(config.amount) + ' ' + escapeHTML(config.currency) + '</span></div>' : '') +
      '<div class="zettapay-row"><span class="label">Network</span><span class="value">Solana Devnet</span></div>' +
      '<button type="button" class="zettapay-pay-btn" data-zp-pay>Connect Phantom &amp; Pay</button>' +
      '<div class="zettapay-status" data-zp-status></div>' +
      '<div class="zettapay-foot">Powered by <a href="' + BASE + '" target="_blank" rel="noopener">ZettaPay</a></div>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener('click', function (e) {
      if (e.target === el || e.target.hasAttribute('data-zp-close')) closeModal();
    });
    var payBtn = el.querySelector('[data-zp-pay]');
    payBtn.addEventListener('click', function () { handlePay(config, el); });
    return el;
  }

  function openModal(config) {
    injectStyles();
    var modal = buildModal(config);
    setStatus(modal, '', '');
    modal.classList.add('open');
  }

  function closeModal() {
    var modal = document.getElementById('zettapay-modal');
    if (modal) modal.classList.remove('open');
  }

  function setStatus(modal, text, kind) {
    var s = modal.querySelector('[data-zp-status]');
    if (!s) return;
    s.className = 'zettapay-status' + (kind ? ' ' + kind + ' show' : '');
    s.textContent = text || '';
  }

  function getPhantom() {
    var p = (window.phantom && window.phantom.solana) || window.solana;
    return (p && p.isPhantom) ? p : null;
  }

  function isMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  }

  var USDC_MINT_ADDR = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  var USDC_DECIMALS = 6;
  var SOLANA_RPC = 'https://api.devnet.solana.com';
  var SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  var WEB3_URL = 'https://esm.sh/@solana/web3.js@1.95.8';
  var SPL_URL = 'https://esm.sh/@solana/spl-token@0.4.9?deps=@solana/web3.js@1.95.8';

  var solanaLibs = null;
  function loadSolanaLibs() {
    if (solanaLibs) return solanaLibs;
    solanaLibs = Promise.all([
      import(/* @vite-ignore */ WEB3_URL),
      import(/* @vite-ignore */ SPL_URL)
    ]).then(function (mods) {
      return { web3: mods[0], spl: mods[1] };
    });
    return solanaLibs;
  }

  function resolveMerchantWallet(libs, ref, amount) {
    if (SOLANA_ADDRESS_RE.test(ref)) {
      return Promise.resolve(new libs.web3.PublicKey(ref));
    }
    var url = BASE + '/api/simulate/' + encodeURIComponent(ref) + '?amount=' + (amount || 1);
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('Merchant lookup failed (' + r.status + ')');
        return r.json();
      })
      .then(function (data) {
        var wallet = data && data.merchant && data.merchant.walletAddress;
        if (!wallet || !SOLANA_ADDRESS_RE.test(wallet)) throw new Error('Merchant has no wallet on file');
        return new libs.web3.PublicKey(wallet);
      });
  }

  function classifyError(err) {
    var msg = (err && err.message) ? String(err.message) : String(err || '');
    var code = err && (err.code || (err.error && err.error.code));
    if (code === 4001 || /user reject|rejected|denied|cancel/i.test(msg)) {
      return 'Payment cancelled in wallet.';
    }
    if (/insufficient.*fund|0x1|TokenAccountInsufficientFunds|custom program error: 0x1/i.test(msg)) {
      return 'Insufficient USDC balance on devnet.';
    }
    if (/blockhash|expired/i.test(msg)) return 'Blockhash expired. Try again.';
    if (/timeout|timed out/i.test(msg)) return 'RPC timeout. Try again.';
    if (/fetch|network/i.test(msg)) return 'Network error. Check your connection.';
    return msg || 'Payment failed.';
  }

  function showSuccess(modal, signature) {
    var s = modal.querySelector('[data-zp-status]');
    if (!s) return;
    s.className = 'zettapay-status success show';
    s.innerHTML = '';
    s.appendChild(document.createTextNode('✓ Paid! Tx: '));
    var a = document.createElement('a');
    a.href = 'https://explorer.solana.com/tx/' + signature + '?cluster=devnet';
    a.target = '_blank';
    a.rel = 'noopener';
    a.style.color = 'inherit';
    a.style.textDecoration = 'underline';
    a.textContent = signature.slice(0, 12) + '...' + signature.slice(-8);
    s.appendChild(a);
  }

  function handlePay(config, modal) {
    var btn = modal.querySelector('[data-zp-pay]');
    var provider = getPhantom();

    if (!provider && isMobile()) {
      setStatus(modal, 'Opening Phantom app...', 'info');
      var ref = encodeURIComponent(window.location.origin);
      window.location.href = 'https://phantom.app/ul/browse/' + encodeURIComponent(window.location.href) + '?ref=' + ref;
      return;
    }
    if (!provider) {
      setStatus(modal, 'Phantom not installed. Get it at phantom.app', 'error');
      window.open('https://phantom.app/download', '_blank', 'noopener');
      return;
    }

    var amount = parseFloat(config.amount || '0');
    if (!isFinite(amount) || amount <= 0) {
      setStatus(modal, 'Invalid amount.', 'error');
      return;
    }

    btn.disabled = true;
    setStatus(modal, 'Loading Solana SDK...', 'info');

    var ctx = {};

    loadSolanaLibs()
      .then(function (libs) {
        ctx.libs = libs;
        setStatus(modal, 'Connecting Phantom...', 'info');
        return provider.connect();
      })
      .then(function (resp) {
        var addr = resp && resp.publicKey ? resp.publicKey.toString() : null;
        if (!addr) throw new Error('No public key returned');
        ctx.payerPubkey = new ctx.libs.web3.PublicKey(addr);
        setStatus(modal, 'Resolving merchant...', 'info');
        return resolveMerchantWallet(ctx.libs, config.merchant, amount);
      })
      .then(function (merchantWallet) {
        ctx.merchantWallet = merchantWallet;
        setStatus(modal, 'Building transaction...', 'info');
        var web3 = ctx.libs.web3;
        var spl = ctx.libs.spl;
        ctx.mint = new web3.PublicKey(USDC_MINT_ADDR);
        ctx.connection = new web3.Connection(SOLANA_RPC, 'confirmed');
        ctx.payerAta = spl.getAssociatedTokenAddressSync(ctx.mint, ctx.payerPubkey, false);
        ctx.merchantAta = spl.getAssociatedTokenAddressSync(ctx.mint, ctx.merchantWallet, false);
        return Promise.all([
          ctx.connection.getAccountInfo(ctx.payerAta),
          ctx.connection.getAccountInfo(ctx.merchantAta),
          ctx.connection.getLatestBlockhash('confirmed')
        ]);
      })
      .then(function (results) {
        var payerInfo = results[0];
        var merchantInfo = results[1];
        var latest = results[2];
        ctx.latest = latest;
        var web3 = ctx.libs.web3;
        var spl = ctx.libs.spl;
        var tx = new web3.Transaction({ feePayer: ctx.payerPubkey, recentBlockhash: latest.blockhash });
        if (!payerInfo) {
          tx.add(spl.createAssociatedTokenAccountInstruction(
            ctx.payerPubkey, ctx.payerAta, ctx.payerPubkey, ctx.mint,
            spl.TOKEN_PROGRAM_ID, spl.ASSOCIATED_TOKEN_PROGRAM_ID
          ));
        }
        if (!merchantInfo) {
          tx.add(spl.createAssociatedTokenAccountInstruction(
            ctx.payerPubkey, ctx.merchantAta, ctx.merchantWallet, ctx.mint,
            spl.TOKEN_PROGRAM_ID, spl.ASSOCIATED_TOKEN_PROGRAM_ID
          ));
        }
        var micro = BigInt(Math.round(amount * Math.pow(10, USDC_DECIMALS)));
        tx.add(spl.createTransferCheckedInstruction(
          ctx.payerAta, ctx.mint, ctx.merchantAta, ctx.payerPubkey,
          micro, USDC_DECIMALS, [], spl.TOKEN_PROGRAM_ID
        ));
        setStatus(modal, 'Confirm in Phantom...', 'info');
        return provider.signAndSendTransaction(tx);
      })
      .then(function (result) {
        ctx.signature = result.signature;
        setStatus(modal, 'Submitting to network...', 'info');
        return ctx.connection.confirmTransaction({
          signature: ctx.signature,
          blockhash: ctx.latest.blockhash,
          lastValidBlockHeight: ctx.latest.lastValidBlockHeight
        }, 'confirmed');
      })
      .then(function (confirmation) {
        if (confirmation && confirmation.value && confirmation.value.err) {
          throw new Error('On-chain error: ' + JSON.stringify(confirmation.value.err));
        }
        showSuccess(modal, ctx.signature);
        var payload = { signature: ctx.signature, merchant: config.merchant, amount: amount, network: 'solana-devnet' };
        if (config.onSuccess && typeof window[config.onSuccess] === 'function') {
          try { window[config.onSuccess](payload); } catch (e) {}
        }
        window.dispatchEvent(new CustomEvent('zettapay:success', { detail: payload }));
        setTimeout(closeModal, 4000);
      })
      .catch(function (err) {
        setStatus(modal, classifyError(err), 'error');
        if (config.onCancel && typeof window[config.onCancel] === 'function') {
          try { window[config.onCancel](err); } catch (e) {}
        }
        window.dispatchEvent(new CustomEvent('zettapay:error', { detail: err }));
      })
      .then(function () { btn.disabled = false; });
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
    // Default: insert button right after the <script> tag
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
