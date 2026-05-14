/**
 * All widget CSS lives in this string and is injected into a single
 * `<style data-zettapay-widget>` tag the first time `mount()` runs.
 * Scoping every selector under `.zp-widget` / `.zp-modal` means the host
 * page's stylesheet can't bleed into the widget and vice-versa, so we
 * don't need a Shadow DOM (which would break Tailwind preflight on hosts
 * that proxy CSS variables).
 */
export const WIDGET_STYLES = /* css */ `
.zp-widget,
.zp-modal,
.zp-modal * {
  box-sizing: border-box;
  -webkit-font-smoothing: antialiased;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.zp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 20px;
  border-radius: 12px;
  border: 0;
  cursor: pointer;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.01em;
  background: linear-gradient(135deg, #4F6BFF 0%, #6B82FF 100%);
  color: #FFFFFF;
  box-shadow: 0 4px 14px rgba(79, 107, 255, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.18);
  transition: transform 120ms ease, box-shadow 200ms ease, filter 200ms ease;
}
.zp-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(79, 107, 255, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.22); }
.zp-btn:active { transform: translateY(0); filter: brightness(0.96); }
.zp-btn:disabled { cursor: not-allowed; opacity: 0.6; }
.zp-btn:focus-visible { outline: 2px solid #14F195; outline-offset: 2px; }

.zp-btn-icon { width: 18px; height: 18px; }

.zp-modal {
  position: fixed;
  inset: 0;
  z-index: 2147483600;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(10, 10, 10, 0.72);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  animation: zp-fade-in 180ms ease;
}

.zp-modal[data-theme="light"] { background: rgba(15, 23, 42, 0.55); }

.zp-card {
  width: min(420px, 100%);
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  background: #111111;
  color: #FFFFFF;
  border: 1px solid rgba(79, 107, 255, 0.22);
  border-radius: 20px;
  padding: 28px 24px 24px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(79, 107, 255, 0.08);
  animation: zp-pop 220ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.zp-modal[data-theme="light"] .zp-card {
  background: #FFFFFF;
  color: #0A0A0A;
  border-color: rgba(15, 23, 42, 0.08);
}

.zp-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.zp-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #94A3B8;
}
.zp-brand-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #14F195;
  box-shadow: 0 0 12px #14F195;
  animation: zp-pulse 2s ease-in-out infinite;
}

.zp-close {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 0;
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  cursor: pointer;
  font-size: 20px;
  line-height: 1;
}
.zp-close:hover { background: rgba(255, 255, 255, 0.12); }
.zp-modal[data-theme="light"] .zp-close { background: rgba(15, 23, 42, 0.06); }
.zp-modal[data-theme="light"] .zp-close:hover { background: rgba(15, 23, 42, 0.12); }

.zp-amount {
  font-size: 32px;
  font-weight: 800;
  letter-spacing: -0.025em;
  background: linear-gradient(135deg, #4F6BFF 0%, #14F195 50%, #9945FF 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  margin: 0 0 4px;
}
.zp-merchant {
  font-size: 13px;
  color: #94A3B8;
  margin: 0 0 20px;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
}

.zp-qr-wrap {
  background: #FFFFFF;
  border-radius: 12px;
  padding: 16px;
  margin: 0 auto 16px;
  width: max-content;
  max-width: 100%;
}
.zp-qr-wrap svg { display: block; width: 100%; height: auto; max-width: 240px; }

.zp-actions { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }

.zp-btn-secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.04);
  color: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
  transition: background 200ms ease, border-color 200ms ease;
}
.zp-btn-secondary:hover { background: rgba(255, 255, 255, 0.08); border-color: rgba(79, 107, 255, 0.4); }
.zp-modal[data-theme="light"] .zp-btn-secondary {
  border-color: rgba(15, 23, 42, 0.08);
  background: rgba(15, 23, 42, 0.04);
}
.zp-modal[data-theme="light"] .zp-btn-secondary:hover { background: rgba(15, 23, 42, 0.08); }

.zp-wallets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 14px;
}
.zp-wallets:empty { display: none; }
.zp-wallet-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
  color: inherit;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  transition: background 180ms ease, border-color 180ms ease;
}
.zp-wallet-pill:hover {
  background: rgba(79, 107, 255, 0.14);
  border-color: rgba(79, 107, 255, 0.32);
}
.zp-modal[data-theme="light"] .zp-wallet-pill {
  background: rgba(15, 23, 42, 0.05);
  border-color: rgba(15, 23, 42, 0.1);
}
.zp-wallet-pill[data-installed="true"] {
  border-color: rgba(20, 241, 149, 0.45);
  background: rgba(20, 241, 149, 0.08);
}
.zp-wallet-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.32);
}
.zp-modal[data-theme="light"] .zp-wallet-dot { background: rgba(15, 23, 42, 0.32); }
.zp-wallet-pill[data-installed="true"] .zp-wallet-dot {
  background: #14F195;
  box-shadow: 0 0 6px rgba(20, 241, 149, 0.6);
}

.zp-status {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(79, 107, 255, 0.08);
  border: 1px solid rgba(79, 107, 255, 0.18);
  font-size: 13px;
  color: #FFFFFF;
}
.zp-modal[data-theme="light"] .zp-status { color: #0A0A0A; }
.zp-status[data-state="success"] { background: rgba(20, 241, 149, 0.12); border-color: rgba(20, 241, 149, 0.32); }
.zp-status[data-state="error"] { background: rgba(239, 68, 68, 0.12); border-color: rgba(239, 68, 68, 0.32); }

.zp-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.18);
  border-top-color: #4F6BFF;
  border-radius: 50%;
  animation: zp-spin 800ms linear infinite;
  flex-shrink: 0;
}
.zp-modal[data-theme="light"] .zp-spinner { border-color: rgba(15, 23, 42, 0.12); border-top-color: #4F6BFF; }

.zp-foot {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 11px;
  color: #94A3B8;
  text-align: center;
}
.zp-modal[data-theme="light"] .zp-foot { border-top-color: rgba(15, 23, 42, 0.06); }

@keyframes zp-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes zp-pop { from { opacity: 0; transform: scale(0.96) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
@keyframes zp-spin { to { transform: rotate(360deg); } }
@keyframes zp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

@media (prefers-reduced-motion: reduce) {
  .zp-modal, .zp-card, .zp-spinner, .zp-brand-dot { animation: none; }
  .zp-btn { transition: none; }
}
`.trim();

let stylesInjected = false;

export function injectStylesOnce(doc: Document = document): void {
  if (stylesInjected) return;
  if (doc.querySelector('style[data-zettapay-widget]')) {
    stylesInjected = true;
    return;
  }
  const tag = doc.createElement('style');
  tag.setAttribute('data-zettapay-widget', '');
  tag.textContent = WIDGET_STYLES;
  (doc.head ?? doc.documentElement).appendChild(tag);
  stylesInjected = true;
}

// Test seam — vitest mounts fresh DOMs per test.
export function __resetStylesInjectedForTest(): void {
  stylesInjected = false;
}
