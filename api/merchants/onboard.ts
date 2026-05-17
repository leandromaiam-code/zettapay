import { randomBytes, randomUUID } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { findMerchantByEmail, rememberMerchant } from '../_lib/merchant-store.js';

const SERVICE = 'zettapay';
const RUNTIME = 'vercel-serverless';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NETWORK = 'solana-devnet';
const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

type ErrorBody = { error: { code: string; message: string } };

function badRequest(res: VercelResponse, code: string, message: string): void {
  const body: ErrorBody = { error: { code, message } };
  res.status(400).json(body);
}

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

function buildEmbedSnippet(origin: string, merchantId: string, publicKey: string): string {
  return `<script src="${origin}/embed.js" data-merchant="${merchantId}" data-pk="${publicKey}" defer></script>`;
}

function buildChecklist(merchantRef: string | null): Array<{
  id: string;
  title: string;
  completed: boolean;
}> {
  return [
    { id: 'paste_pubkey', title: 'Cole sua chave pública Solana', completed: false },
    { id: 'register_merchant', title: 'Registre seu merchant', completed: Boolean(merchantRef) },
    { id: 'copy_embed_code', title: 'Copie o snippet de embed', completed: false },
    { id: 'first_payment', title: 'Receba seu primeiro pagamento USDC', completed: false },
  ];
}

function handleGet(req: VercelRequest, res: VercelResponse): void {
  const merchantRef = normalizeRef(req.query.merchant);
  const origin = originFromRequest(req);

  res.status(200).json({
    service: SERVICE,
    runtime: RUNTIME,
    endpoint: '/api/merchants/onboard',
    method: 'GET',
    description:
      'Self-service onboarding state for a merchant: checklist + embed snippet + dashboard link. POST to this endpoint to create a merchant from the signup flow.',
    merchant: merchantRef,
    network: NETWORK,
    fees: { rate: '0.30%', settlement: 'instant' },
    checklist: buildChecklist(merchantRef),
    embedSnippet: merchantRef
      ? `<script src="${origin}/embed.js" data-merchant="${merchantRef}" defer></script>`
      : null,
    links: {
      signup: `${origin}/signup`,
      dashboard: merchantRef
        ? `${origin}/dashboard?merchant=${encodeURIComponent(merchantRef)}`
        : `${origin}/dashboard`,
      docs: `${origin}/docs/quickstart`,
      register: `${origin}/api/merchants/register`,
      analytics: merchantRef ? `${origin}/analytics/${encodeURIComponent(merchantRef)}` : null,
    },
  });
}

function handlePost(req: VercelRequest, res: VercelResponse): void {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
    string,
    unknown
  >;

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) {
    badRequest(res, 'invalid_name', 'Field "name" is required and must be ≤120 chars');
    return;
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) {
    badRequest(res, 'invalid_email', 'Field "email" must be a valid email address');
    return;
  }

  const existing = findMerchantByEmail(email);
  if (existing) {
    res.status(409).json({
      error: {
        code: 'email_already_registered',
        message: 'An account already exists for this email. Recover your credentials instead.',
      },
      login_url: '/signup#login',
      recover_url: '/api/merchants/recover-creds',
    });
    return;
  }

  // Wallet is optional under the wallet-less hard rule (Z36A). The signup
  // form no longer collects pubkeys; merchants configure them server-side
  // via env vars and zp.register(). We still accept and validate a wallet
  // when explicitly provided so older clients keep working.
  const walletRaw =
    typeof body.wallet === 'string'
      ? body.wallet.trim()
      : typeof body.walletAddress === 'string'
        ? body.walletAddress.trim()
        : '';
  if (walletRaw && !SOLANA_ADDRESS_RE.test(walletRaw)) {
    badRequest(res, 'invalid_wallet', 'Field "wallet" must be a base58 Solana pubkey');
    return;
  }
  const wallet = walletRaw || null;

  const idempotencyHeader = req.headers['idempotency-key'];
  const idemKey = Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader;
  if (idemKey !== undefined && (typeof idemKey !== 'string' || idemKey.length > 128)) {
    badRequest(
      res,
      'invalid_idempotency_key',
      'Header "Idempotency-Key" must be a string ≤128 chars',
    );
    return;
  }

  const origin = originFromRequest(req);
  const merchantId = `m_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const publicKey = `pk_live_${randomBytes(12).toString('hex')}`;
  const secretKey = `sk_live_${randomBytes(24).toString('hex')}`;
  const apiKey = `zp_live_${randomBytes(16).toString('hex')}`;
  const webhookSecret = `whsec_${randomBytes(24).toString('hex')}`;
  const createdAt = new Date().toISOString();

  rememberMerchant({ id: merchantId, email, name, createdAt });

  const dashboardUrl = `${origin}/dashboard?merchant=${encodeURIComponent(merchantId)}`;
  const embedCode = buildEmbedSnippet(origin, merchantId, publicKey);

  res.status(201).json({
    merchant: {
      id: merchantId,
      name,
      email,
      walletAddress: wallet,
      network: NETWORK,
      status: 'active',
      createdAt,
    },
    api_key: apiKey,
    webhook_secret: webhookSecret,
    public_key: publicKey,
    secret_key: secretKey,
    embed_code: embedCode,
    dashboard_url: dashboardUrl,
    binding: {
      mint: USDC_MINT_DEVNET,
      cluster: 'devnet',
      status: 'queued',
      ataCreated: false,
      txSignature: null,
      memoNamespace: 'zettapay:merchant_register:v1',
      note: 'USDC ATA + memo binding tx are processed by the long-running registration worker. Poll /api/merchants/register or the dashboard for confirmation.',
    },
    checklist: buildChecklist(merchantId).map((step) =>
      step.id === 'paste_pubkey' || step.id === 'register_merchant'
        ? { ...step, completed: true }
        : step,
    ),
    links: {
      dashboard: dashboardUrl,
      docs: `${origin}/docs/quickstart`,
      analytics: `${origin}/analytics/${encodeURIComponent(merchantId)}`,
      register: `${origin}/api/merchants/register`,
    },
  });
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method === 'POST') {
    handlePost(req, res);
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    handleGet(req, res);
    return;
  }
  res.setHeader('Allow', 'GET, HEAD, POST');
  res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET, HEAD or POST' } });
}
