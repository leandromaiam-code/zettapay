import type { VercelRequest, VercelResponse } from '@vercel/node';

const SERVICE = 'zettapay';
const RUNTIME = 'vercel-serverless';

function normalizeRef(raw: unknown): string | null {
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
}

function originFromRequest(req: VercelRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  const hostStr = Array.isArray(host) ? host[0] : host;
  return hostStr ? `${proto}://${hostStr}` : 'https://zettapay.io';
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET only' } });
    return;
  }

  const merchantRef = normalizeRef(req.query.merchant);
  const origin = originFromRequest(req);

  const checklist = [
    { id: 'connect_wallet', title: 'Conecte sua wallet Phantom', completed: false },
    { id: 'register_merchant', title: 'Registre seu merchant', completed: Boolean(merchantRef) },
    { id: 'copy_embed_code', title: 'Copie o snippet de embed', completed: false },
    { id: 'first_payment', title: 'Receba seu primeiro pagamento USDC', completed: false },
  ];

  const embedSnippet = merchantRef
    ? `<script src="${origin}/embed.js" data-merchant="${merchantRef}" defer></script>`
    : null;

  res.status(200).json({
    service: SERVICE,
    runtime: RUNTIME,
    endpoint: '/api/merchants/onboard',
    method: 'GET',
    description:
      'Self-service onboarding state for a merchant: checklist + embed snippet + dashboard link.',
    merchant: merchantRef,
    network: 'solana-devnet',
    fees: { rate: '0.30%', settlement: 'instant' },
    checklist,
    embedSnippet,
    links: {
      dashboard: merchantRef
        ? `${origin}/dashboard?merchant=${encodeURIComponent(merchantRef)}`
        : `${origin}/dashboard`,
      docs: `${origin}/docs/quickstart`,
      register: `${origin}/api/merchants/register`,
      analytics: merchantRef ? `${origin}/analytics/${encodeURIComponent(merchantRef)}` : null,
    },
  });
}
