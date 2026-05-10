// ZettaPay · Wix Velo backend module
//
// Drop this file into your Wix site at: backend/zettapay.web.js
// It exposes async functions the page code calls via Wix Web Modules.
//
// Build: 0.1.0
import { Permissions, webMethod } from 'wix-web-module';
import { fetch } from 'wix-fetch';

// ---- Configure these per environment ------------------------------------
// In production, fetch from /wix/velo/backend/<merchantId> on your ZettaPay
// API origin so the merchant id and bases are baked in for you.
const API_BASE = 'https://api.zettapay.io';
const PAY_BASE = 'https://api.zettapay.io';
const MERCHANT_ID = 'merch_REPLACE_ME';
// -------------------------------------------------------------------------

function trimSlashes(s) {
  return String(s || '').replace(/\/+$/, '');
}

function isPositiveAmount(v) {
  if (v == null) return false;
  const n = String(v).trim();
  return /^[0-9]+(?:\.[0-9]{1,8})?$/.test(n) && Number(n) > 0;
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
  if (opts && opts.successUrl && /^https?:\/\//i.test(opts.successUrl)) {
    params.push('success_url=' + encodeURIComponent(opts.successUrl));
  }
  if (opts && opts.cancelUrl && /^https?:\/\//i.test(opts.cancelUrl)) {
    params.push('cancel_url=' + encodeURIComponent(opts.cancelUrl));
  }
  params.push('source=wix');
  return base + '/pay/checkout?' + params.join('&');
}

export const createCheckout = webMethod(Permissions.Anyone, async function (opts) {
  const url = buildCheckoutUrl(opts || {});
  return { url: url, merchantId: MERCHANT_ID, source: 'wix' };
});

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

export const pluginInfo = webMethod(Permissions.Anyone, async function () {
  return {
    slug: 'zettapay-wix-app',
    version: '0.1.0',
    merchantId: MERCHANT_ID,
    apiBase: trimSlashes(API_BASE),
  };
});
