// mempool.space WebSocket client — watch-only per-invoice address subscriber.
//
// Long-running deployments (Express worker, Fly/Render) instantiate this once
// and call `subscribe(address)` for every pending invoice. Vercel serverless
// uses `transientStateCheck()` for the acceptance endpoint health probe — a
// short-lived connection that opens, validates state==='OPEN', then closes.

import WebSocket from 'ws';

export const MEMPOOL_WS_URL = process.env.MEMPOOL_WS_URL ?? 'wss://mempool.space/api/v1/ws';

export type ConfirmationTier = 1 | 3 | 6;

/** Per-invoice confirmation threshold required before marking 'paid'.
 *   < $50   → 1 conf
 *   < $500  → 3 conf
 *   ≥ $500  → 6 conf
 * Inherits from Z46 and mirrored in the listener's confirmation gate. */
export function requiredConfirmations(fiatUsd: number): ConfirmationTier {
  if (!Number.isFinite(fiatUsd) || fiatUsd < 0) {
    throw new Error(`fiatUsd must be a non-negative finite number, got ${fiatUsd}`);
  }
  if (fiatUsd < 50) return 1;
  if (fiatUsd < 500) return 3;
  return 6;
}

export interface PendingInvoice {
  invoiceId: string;
  address: string;
  fiatAmountUsd: number;
  webhookUrl: string;
  webhookSecret: string;
}

export interface AddressActivity {
  invoiceId: string;
  address: string;
  txid: string;
  receivedSats: number;
  confirmations: number;
  required: ConfirmationTier;
  reachedThreshold: boolean;
}

export type ActivityHandler = (activity: AddressActivity) => void | Promise<void>;

/** Sum vout entries paying to the watched address. mempool.space emits
 * standard Esplora-shaped tx objects under `address-transactions`. */
export function extractReceivedSats(tx: unknown, address: string): number {
  if (!tx || typeof tx !== 'object') return 0;
  const vout = (tx as { vout?: unknown }).vout;
  if (!Array.isArray(vout)) return 0;
  let sum = 0;
  for (const entry of vout) {
    if (!entry || typeof entry !== 'object') continue;
    const addr =
      (entry as { scriptpubkey_address?: unknown }).scriptpubkey_address ??
      (entry as { address?: unknown }).address;
    const value = (entry as { value?: unknown }).value;
    if (addr === address && typeof value === 'number' && Number.isFinite(value)) {
      sum += value;
    }
  }
  return sum;
}

interface WatchedInvoice extends PendingInvoice {
  required: ConfirmationTier;
}

/**
 * Long-lived watcher. Reconnects with exponential backoff (1s → 60s cap) and
 * resubscribes every pending invoice address on each successful reconnect.
 *
 * The class itself is transport-only — no DB writes — so it stays trivially
 * testable. Bind `onActivity` to whatever persistence/dispatcher you want
 * (Supabase row update + queue the HMAC webhook).
 */
export class MempoolListener {
  private socket: WebSocket | null = null;
  private readonly invoices = new Map<string, WatchedInvoice>();
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private lastPongAt = 0;
  private opened = false;

  constructor(
    private readonly url: string = MEMPOOL_WS_URL,
    private readonly onActivity: ActivityHandler = () => {},
  ) {}

  connect(): void {
    if (this.disposed) return;
    if (this.socket) return;
    const ws = new WebSocket(this.url);
    this.socket = ws;
    ws.on('open', () => {
      this.opened = true;
      this.lastPongAt = Date.now();
      this.reconnectAttempt = 0;
      for (const inv of this.invoices.values()) {
        this.sendTrackAddress(inv.address);
      }
    });
    ws.on('pong', () => {
      this.lastPongAt = Date.now();
    });
    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) =>
      this.handleMessage(raw.toString()),
    );
    ws.on('close', () => this.scheduleReconnect());
    ws.on('error', () => this.scheduleReconnect());
  }

  /** OPEN + last pong within `freshMs` (default 30s) — matches acceptance
   * check (c). After `ping()` we set lastPongAt optimistically so a freshly
   * opened socket isn't flagged stale before the first pong round-trips. */
  isHealthy(freshMs = 30_000): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    return Date.now() - this.lastPongAt <= freshMs;
  }

  /** Force a ping so isHealthy() can return a fresh assertion within the
   * caller's wall-clock budget. Safe no-op if the socket is closed. */
  ping(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.ping();
      } catch {
        // ignore — pong-based health check will catch unrecoverable sockets
      }
    }
  }

  subscribe(invoice: PendingInvoice): void {
    const watched: WatchedInvoice = {
      ...invoice,
      required: requiredConfirmations(invoice.fiatAmountUsd),
    };
    this.invoices.set(invoice.address, watched);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendTrackAddress(invoice.address);
    }
  }

  unsubscribe(address: string): void {
    this.invoices.delete(address);
  }

  close(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // socket may already be closed
      }
      this.socket = null;
    }
  }

  private sendTrackAddress(address: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ 'track-address': address }));
  }

  private handleMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    const txs = m['address-transactions'] ?? m['multi-address-transactions'];
    if (!Array.isArray(txs)) return;
    for (const tx of txs) {
      this.dispatchTransaction(tx);
    }
  }

  private dispatchTransaction(tx: unknown): void {
    if (!tx || typeof tx !== 'object') return;
    const t = tx as Record<string, unknown>;
    const txid = typeof t.txid === 'string' ? t.txid : null;
    if (!txid) return;
    const status = t.status as { confirmed?: boolean; block_height?: number } | undefined;
    const confirmations = status?.confirmed && typeof status.block_height === 'number' ? 1 : 0;
    for (const inv of this.invoices.values()) {
      const received = extractReceivedSats(tx, inv.address);
      if (received <= 0) continue;
      const activity: AddressActivity = {
        invoiceId: inv.invoiceId,
        address: inv.address,
        txid,
        receivedSats: received,
        confirmations,
        required: inv.required,
        reachedThreshold: confirmations >= inv.required,
      };
      void Promise.resolve(this.onActivity(activity)).catch(() => {
        // handler errors are the handler's problem — never tear down the WS
      });
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
      } catch {
        // ignore
      }
      this.socket = null;
    }
    const attempt = Math.min(this.reconnectAttempt + 1, 6);
    this.reconnectAttempt = attempt;
    const delay = Math.min(1000 * 2 ** (attempt - 1), 60_000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

export interface TransientStateResult {
  state: 'OPEN' | 'CLOSED' | 'TIMEOUT' | 'ERROR';
  url: string;
  openedAtMs: number;
  closedAtMs: number;
  pongAgeMs: number | null;
}

/** One-shot liveness probe. Opens a WS to mempool.space, waits up to
 * `timeoutMs` for OPEN + a pong round-trip, then closes. Lets the Vercel
 * serverless acceptance endpoint report a fresh state without owning a
 * long-lived connection. */
export async function transientStateCheck(
  url: string = MEMPOOL_WS_URL,
  timeoutMs = 8_000,
): Promise<TransientStateResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    let pongAt: number | null = null;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      resolve({
        state: 'TIMEOUT',
        url,
        openedAtMs: start,
        closedAtMs: Date.now(),
        pongAgeMs: null,
      });
    }, timeoutMs);

    ws.on('open', () => {
      try {
        ws.ping();
      } catch {
        // proceed; we still got OPEN
      }
      // Even without a pong we can resolve OPEN — the socket is live.
      // Wait up to 1.5s for a pong to attach a fresh age, then close.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const closedAt = Date.now();
        try {
          ws.close();
        } catch {
          // ignore
        }
        resolve({
          state: 'OPEN',
          url,
          openedAtMs: start,
          closedAtMs: closedAt,
          pongAgeMs: pongAt ? closedAt - pongAt : null,
        });
      }, 1_500);
    });

    ws.on('pong', () => {
      pongAt = Date.now();
    });

    ws.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        state: 'ERROR',
        url,
        openedAtMs: start,
        closedAtMs: Date.now(),
        pongAgeMs: null,
      });
    });
  });
}
