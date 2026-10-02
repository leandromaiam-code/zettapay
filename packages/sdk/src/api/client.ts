import { PlanLimitReachedError, RateLimitedError, ZettaPayApiError } from './errors.js';
import type {
  BaseInvoiceCreated,
  BtcInvoiceCreated,
  CloudHealth,
  CreateBaseInvoiceInput,
  CreateBtcInvoiceInput,
  ListenerHealth,
  ZettaPayHealth,
  ZettaPayInvoice,
} from './types.js';

/** Header carrying the merchant API key on both the listener and Cloud. */
export const API_KEY_HEADER = 'X-ZettaPay-Api-Key';

/** Route prefix per deployment kind. */
export const API_PATH_PREFIX = {
  /** Self-hosted `@zettapay/listener`: `/invoice`, `/invoice/:id`, `/health`. */
  listener: '',
  /** ZettaPay Cloud: `/api/v1/invoice`, `/api/v1/invoice/:id`, `/api/v1/health`. */
  cloud: '/api/v1',
} as const;

export type ZettaPayTarget = keyof typeof API_PATH_PREFIX;

const DEFAULT_TIMEOUT_MS = 15_000;

export interface ZettaPayApiOptions {
  /**
   * Origin of the server, e.g. `http://localhost:8787` for a local listener or
   * the origin of your Cloud deployment. No default — the SDK never assumes a
   * host.
   */
  baseUrl: string;
  /**
   * Which server `baseUrl` points at. Selects the route prefix (`''` for the
   * listener, `/api/v1` for Cloud). It is never inferred from the URL.
   */
  target: ZettaPayTarget;
  /**
   * Merchant API key, sent as `X-ZettaPay-Api-Key`. Required by Cloud on every
   * invoice call and by a listener configured with `ZETTAPAY_API_KEY`. Keep it
   * server-side.
   */
  apiKey?: string;
  /** Overrides the prefix chosen by `target` (e.g. when behind a reverse proxy path). */
  pathPrefix?: string;
  /** Per-request timeout in milliseconds. Default 15000. */
  timeoutMs?: number;
  /** `fetch` implementation. Defaults to the global `fetch` (Node >= 18, browsers, edge runtimes). */
  fetch?: typeof fetch;
}

/**
 * Dependency-free client for the current ZettaPay HTTP API. Works against the
 * self-hosted listener and against ZettaPay Cloud — the two expose the same
 * routes and response fields, differing only in the route prefix.
 *
 * @example
 *   const zp = new ZettaPayApi({ baseUrl: 'http://localhost:8787', target: 'listener', apiKey });
 *   const invoice = await zp.createBaseInvoice({ amountUsd: 29 });
 *   // show invoice.qr_uri as a QR code, then poll zp.getInvoice(invoice.invoice_id)
 */
export class ZettaPayApi {
  private readonly root: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ZettaPayApiOptions) {
    if (!opts || typeof opts.baseUrl !== 'string' || opts.baseUrl.trim() === '') {
      throw new ZettaPayApiError('ZettaPayApi: baseUrl is required', 'invalid_request');
    }
    let prefix: string;
    if (opts.pathPrefix !== undefined) {
      prefix = opts.pathPrefix;
    } else if (opts.target === 'listener' || opts.target === 'cloud') {
      prefix = API_PATH_PREFIX[opts.target];
    } else {
      throw new ZettaPayApiError(
        'ZettaPayApi: target must be "listener" or "cloud" (or pass pathPrefix)',
        'invalid_request',
      );
    }
    const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '');
    this.root = opts.baseUrl.trim().replace(/\/+$/, '') + (cleanPrefix ? `/${cleanPrefix}` : '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const f = opts.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof f !== 'function') {
      throw new ZettaPayApiError(
        'ZettaPayApi: no fetch implementation available — pass options.fetch',
        'invalid_request',
      );
    }
    this.fetchImpl = opts.fetch ? f : f.bind(globalThis);
  }

  /** Create a Bitcoin invoice for an amount in satoshis. */
  async createBtcInvoice(input: CreateBtcInvoiceInput): Promise<BtcInvoiceCreated> {
    if (!Number.isInteger(input?.amountSats) || input.amountSats <= 0) {
      throw new ZettaPayApiError(
        'createBtcInvoice: amountSats must be a positive integer',
        'invalid_request',
      );
    }
    const body: Record<string, unknown> = { chain: 'btc', amount_sats: input.amountSats };
    if (input.memo !== undefined) body.memo = input.memo;
    if (input.expiresInSeconds !== undefined) body.expires_in = requireTtl(input.expiresInSeconds);
    return this.request<BtcInvoiceCreated>('POST', '/invoice', body);
  }

  /** Create a USDC (default) or USDT invoice on Base for an amount in USD. */
  async createBaseInvoice(input: CreateBaseInvoiceInput): Promise<BaseInvoiceCreated> {
    if (typeof input?.amountUsd !== 'number' || !Number.isFinite(input.amountUsd) || input.amountUsd <= 0) {
      throw new ZettaPayApiError(
        'createBaseInvoice: amountUsd must be a positive number',
        'invalid_request',
      );
    }
    const asset = input.asset ?? 'usdc';
    if (asset !== 'usdc' && asset !== 'usdt') {
      throw new ZettaPayApiError(
        'createBaseInvoice: asset must be "usdc" or "usdt"',
        'invalid_request',
      );
    }
    const body: Record<string, unknown> = { chain: 'base', amount_usd: input.amountUsd, asset };
    if (input.expiresInSeconds !== undefined) body.expires_in = requireTtl(input.expiresInSeconds);
    const invoice = await this.request<BaseInvoiceCreated>('POST', '/invoice', body);
    // A deployment in xpub mode issues USDC regardless of the requested asset.
    // Never hand back an invoice in a different token than the caller asked for.
    if (typeof invoice.asset === 'string' && invoice.asset.toLowerCase() !== asset) {
      throw new ZettaPayApiError(
        `createBaseInvoice: requested ${asset} but the server issued a ${invoice.asset} invoice ` +
          `(${invoice.invoice_id}) — this deployment does not serve ${asset} on Base`,
        'asset_mismatch',
        201,
        invoice,
      );
    }
    return invoice;
  }

  /** Fetch an invoice by id. Poll this to follow `status`. */
  async getInvoice(invoiceId: string): Promise<ZettaPayInvoice> {
    if (typeof invoiceId !== 'string' || invoiceId === '') {
      throw new ZettaPayApiError('getInvoice: invoiceId is required', 'invalid_request');
    }
    return this.request<ZettaPayInvoice>('GET', `/invoice/${encodeURIComponent(invoiceId)}`);
  }

  /**
   * Liveness probe. The listener answers `ListenerHealth`, Cloud answers
   * `CloudHealth`; narrow with `'service' in health`.
   */
  async health(): Promise<ZettaPayHealth> {
    return this.request<ListenerHealth | CloudHealth>('GET', '/health');
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) headers[API_KEY_HEADER] = this.apiKey;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(this.root + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (err) {
      if (ctrl.signal.aborted) {
        throw new ZettaPayApiError(
          `${method} ${path}: no response within ${this.timeoutMs}ms`,
          'timeout',
          undefined,
          undefined,
          { cause: err },
        );
      }
      throw new ZettaPayApiError(
        `${method} ${path}: ${err instanceof Error ? err.message : 'network error'}`,
        'network_error',
        undefined,
        undefined,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    let decoded: unknown;
    let isJson = false;
    if (text.length > 0) {
      try {
        decoded = JSON.parse(text);
        isJson = true;
      } catch {
        decoded = text;
      }
    }

    if (!res.ok) throw toApiError(res, decoded);
    if (!isJson || typeof decoded !== 'object' || decoded === null) {
      throw new ZettaPayApiError(
        `${method} ${path}: expected a JSON object in the response`,
        'invalid_response',
        res.status,
        decoded,
      );
    }
    return decoded as T;
  }
}

function requireTtl(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ZettaPayApiError('expiresInSeconds must be a positive integer', 'invalid_request');
  }
  return value;
}

function toApiError(res: Response, decoded: unknown): ZettaPayApiError {
  const envelope =
    decoded && typeof decoded === 'object'
      ? (decoded as { error?: unknown }).error
      : undefined;
  const err =
    envelope && typeof envelope === 'object' ? (envelope as Record<string, unknown>) : undefined;
  const code = typeof err?.code === 'string' ? err.code : undefined;
  const message =
    typeof err?.message === 'string' ? err.message : (code ?? `request failed with status ${res.status}`);

  if (res.status === 402 && code === 'plan_limit_reached') {
    return new PlanLimitReachedError(
      message,
      {
        plan: typeof err?.plan === 'string' ? err.plan : undefined,
        limit: typeof err?.limit === 'number' ? err.limit : undefined,
        used: typeof err?.used === 'number' ? err.used : undefined,
      },
      decoded,
    );
  }
  if (res.status === 429) {
    const raw = res.headers.get('retry-after');
    const seconds = raw === null ? Number.NaN : Number(raw);
    return new RateLimitedError(
      message,
      Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined,
      decoded,
    );
  }
  return new ZettaPayApiError(message, code ?? 'http_error', res.status, decoded);
}
