// ZettaPay · Wix Velo page module
//
// Paste this into the page code where the Pay button lives.
// Customize the element ids to match your design.
//
// Build: 0.1.0
import { createCheckout, fetchPaymentStatus } from 'backend/zettapay.web.js';
import wixWindow from 'wix-window';

// ---- Configure these to match your page elements -----------------------
const PAY_BUTTON_ID = '#zpPayButton';
const STATUS_TEXT_ID = '#zpStatusText';
const AMOUNT_INPUT_ID = '#zpAmount'; // optional — omit if amount is fixed

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
