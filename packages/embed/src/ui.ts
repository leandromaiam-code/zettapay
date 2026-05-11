/**
 * DOM rendering for the embed. Inline-only — no modal. The lean embed
 * lives wherever the host page drops the script, leaving full-modal
 * UX to `@zettapay/widget`.
 *
 * Styles are inlined with `style=` attributes so the embed never fights
 * the host page's cascade or pulls in a `<style>` block that conscious
 * merchants would have to allowlist via CSP.
 */
import type { Cluster } from './types.js';

const BRAND = {
  // Veridian brand tokens — Forest / Brass / Parchment.
  forest: '#0a1612',
  brass: '#d4a961',
  parchment: '#f5e6c8',
  emerald: '#1f6d52',
  ember: '#c87a3f',
};

const FONT_STACK =
  'Manrope, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export interface RenderParams {
  recipient: string;
  amount: string;
  currency: string;
  cluster: Cluster;
  payUri: string;
  qrUrl: string;
  theme: 'dark' | 'light';
  label?: string;
}

export interface RenderHandle {
  root: HTMLElement;
  setStatus(text: string, kind: 'pending' | 'success' | 'error'): void;
}

export function render(target: HTMLElement, params: RenderParams): RenderHandle {
  const dark = params.theme !== 'light';
  const bg = dark ? BRAND.forest : BRAND.parchment;
  const fg = dark ? BRAND.parchment : BRAND.forest;
  const accent = BRAND.brass;
  const border = dark ? 'rgba(212,169,97,0.32)' : 'rgba(10,22,18,0.16)';

  const root = document.createElement('div');
  root.setAttribute('data-zettapay-embed', '');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'ZettaPay USDC checkout');
  root.style.cssText = [
    `font-family:${FONT_STACK}`,
    `background:${bg}`,
    `color:${fg}`,
    `border:1px solid ${border}`,
    'border-radius:14px',
    'padding:20px',
    'max-width:360px',
    'width:100%',
    'box-sizing:border-box',
    'display:flex',
    'flex-direction:column',
    'gap:14px',
    'line-height:1.45',
    '-webkit-font-smoothing:antialiased',
  ].join(';');

  const eyebrow = document.createElement('div');
  eyebrow.style.cssText = [
    `color:${accent}`,
    'font-family:"JetBrains Mono",ui-monospace,Menlo,Consolas,monospace',
    'font-size:11px',
    'letter-spacing:0.16em',
    'text-transform:uppercase',
  ].join(';');
  eyebrow.textContent = `ZettaPay · ${params.cluster}`;

  const amountEl = document.createElement('div');
  amountEl.style.cssText = [
    'font-family:"Cormorant Garamond",Georgia,serif',
    'font-size:32px',
    'font-weight:600',
    'letter-spacing:-0.01em',
  ].join(';');
  amountEl.textContent = `${params.amount} ${params.currency}`;

  if (params.label) {
    const labelEl = document.createElement('div');
    labelEl.style.cssText = `font-size:13px;opacity:0.78`;
    labelEl.textContent = params.label;
    amountEl.appendChild(labelEl);
  }

  const qrWrap = document.createElement('a');
  qrWrap.href = params.payUri;
  qrWrap.target = '_blank';
  qrWrap.rel = 'noopener noreferrer';
  qrWrap.style.cssText = [
    'display:block',
    'background:#fff',
    'padding:10px',
    'border-radius:10px',
    'align-self:center',
    'line-height:0',
  ].join(';');
  const qrImg = document.createElement('img');
  qrImg.src = params.qrUrl;
  qrImg.alt = 'Scan with a Solana wallet to pay';
  qrImg.width = 220;
  qrImg.height = 220;
  qrImg.style.cssText = 'display:block;width:220px;height:220px';
  qrWrap.appendChild(qrImg);

  const addrLabel = document.createElement('div');
  addrLabel.style.cssText = `font-size:11px;opacity:0.72;letter-spacing:0.08em;text-transform:uppercase`;
  addrLabel.textContent = 'Pay to address';

  const addrRow = document.createElement('div');
  addrRow.style.cssText = [
    'display:flex',
    'gap:8px',
    'align-items:center',
    `background:${dark ? 'rgba(245,230,200,0.06)' : 'rgba(10,22,18,0.04)'}`,
    `border:1px solid ${border}`,
    'border-radius:8px',
    'padding:8px 10px',
    'font-family:"JetBrains Mono",ui-monospace,Menlo,Consolas,monospace',
    'font-size:12px',
    'word-break:break-all',
  ].join(';');
  const addrText = document.createElement('span');
  addrText.textContent = params.recipient;
  addrText.style.cssText = 'flex:1 1 auto;min-width:0';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = 'Copy';
  copyBtn.style.cssText = [
    'flex:0 0 auto',
    'border:none',
    'cursor:pointer',
    'padding:6px 10px',
    'border-radius:6px',
    `background:${accent}`,
    `color:${BRAND.forest}`,
    'font-weight:600',
    'font-family:inherit',
    'font-size:11px',
    'letter-spacing:0.08em',
    'text-transform:uppercase',
  ].join(';');
  copyBtn.addEventListener('click', () => {
    const nav = navigator as Navigator & { clipboard?: { writeText(t: string): Promise<void> } };
    if (nav.clipboard?.writeText) {
      nav.clipboard.writeText(params.recipient).catch(() => undefined);
    }
    const previous = copyBtn.textContent;
    copyBtn.textContent = 'Copied';
    setTimeout(() => {
      copyBtn.textContent = previous;
    }, 1400);
  });
  addrRow.appendChild(addrText);
  addrRow.appendChild(copyBtn);

  const status = document.createElement('div');
  status.setAttribute('aria-live', 'polite');
  status.style.cssText = [
    'display:flex',
    'gap:8px',
    'align-items:center',
    'font-size:13px',
    'opacity:0.88',
  ].join(';');
  const dot = document.createElement('span');
  dot.style.cssText = [
    'width:8px',
    'height:8px',
    'border-radius:50%',
    `background:${accent}`,
    'box-shadow:0 0 8px rgba(212,169,97,0.6)',
    'flex:0 0 auto',
  ].join(';');
  const statusText = document.createElement('span');
  statusText.textContent = 'Waiting for payment…';
  status.appendChild(dot);
  status.appendChild(statusText);

  root.appendChild(eyebrow);
  root.appendChild(amountEl);
  root.appendChild(qrWrap);
  root.appendChild(addrLabel);
  root.appendChild(addrRow);
  root.appendChild(status);
  target.appendChild(root);

  return {
    root,
    setStatus(text, kind) {
      statusText.textContent = text;
      const color =
        kind === 'success' ? BRAND.emerald : kind === 'error' ? BRAND.ember : accent;
      dot.style.background = color;
      dot.style.boxShadow = `0 0 8px ${color}`;
    },
  };
}
