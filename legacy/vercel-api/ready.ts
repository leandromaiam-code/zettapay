// @ts-nocheck — Node 18+ has global fetch, TS 4.9 cannot type it
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withSentry } from './_lib/sentry.js';

const READY_TIMEOUT_MS = 2_500;

type CheckResult = {
  ok: boolean;
  detail?: string;
  latencyMs?: number;
};

async function checkSolanaRpc(url: string): Promise<CheckResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return { ok: false, detail: `http_${response.status}`, latencyMs };
    }
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) {
      return { ok: false, detail: body.error.message ?? 'rpc_error', latencyMs };
    }
    return { ok: body.result === 'ok', detail: String(body.result ?? 'unknown'), latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const detail = err instanceof Error ? err.name : 'unknown_error';
    return { ok: false, detail, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET only' } });
    return;
  }

  const rpcUrl = process.env.SOLANA_RPC_URL?.trim();
  const checks: Record<string, CheckResult> = {};

  if (rpcUrl && rpcUrl.length > 0) {
    checks.solanaRpc = await checkSolanaRpc(rpcUrl);
  } else {
    checks.solanaRpc = { ok: false, detail: 'not_configured' };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ready' : 'unready',
    service: 'zettapay',
    runtime: 'vercel-serverless',
    timestamp: new Date().toISOString(),
    checks,
  });
}

export default withSentry(handler);
