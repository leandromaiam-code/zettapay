export type PaymentSource = 'x402' | 'onramp';

export interface X402PaymentDetails {
  feePayer: string;
  signers: string[];
  signatures: string[];
  recentBlockhash: string;
  isVersioned: boolean;
  version: number | null;
  transactionBytes: number;
}

export interface OnrampPaymentDetails {
  provider: 'moonpay';
  externalTransactionId: string;
  status: 'completed';
  baseAmount: number;
  baseCurrency: string;
  quoteAmount: number;
  quoteCurrency: string;
  walletAddress: string;
  providerCreatedAt: string | null;
  providerCompletedAt: string | null;
}

interface BasePaymentRecord {
  id: string;
  acceptedAt: number;
  source: PaymentSource;
}

export type PaymentRecord =
  | (BasePaymentRecord & { source: 'x402' } & X402PaymentDetails)
  | (BasePaymentRecord & { source: 'onramp' } & OnrampPaymentDetails);

export interface ListPaymentsOptions {
  limit?: number;
  offset?: number;
  source?: PaymentSource;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_RETAINED = 1000;

export class PaymentLog {
  private readonly entries: PaymentRecord[] = [];
  private readonly externalIndex = new Map<string, PaymentRecord>();
  private sequence = 0;

  record(input: X402PaymentDetails): PaymentRecord {
    return this.append({ source: 'x402', ...input });
  }

  recordOnramp(input: OnrampPaymentDetails): PaymentRecord {
    const dedupeKey = onrampDedupeKey(input.provider, input.externalTransactionId);
    const existing = this.externalIndex.get(dedupeKey);
    if (existing) return existing;
    const record = this.append({ source: 'onramp', ...input });
    this.externalIndex.set(dedupeKey, record);
    return record;
  }

  findOnrampByExternalId(provider: 'moonpay', externalTransactionId: string): PaymentRecord | null {
    return this.externalIndex.get(onrampDedupeKey(provider, externalTransactionId)) ?? null;
  }

  list(options: ListPaymentsOptions = {}): PaymentRecord[] {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(options.offset ?? 0, 0);
    const filtered = options.source
      ? this.entries.filter((entry) => entry.source === options.source)
      : this.entries;
    return filtered.slice(offset, offset + limit);
  }

  findById(id: string): PaymentRecord | null {
    return this.entries.find((entry) => entry.id === id) ?? null;
  }

  count(): number {
    return this.entries.length;
  }

  private append(payload: Omit<PaymentRecord, 'id' | 'acceptedAt'>): PaymentRecord {
    const acceptedAt = Date.now();
    this.sequence += 1;
    const record = {
      id: `${acceptedAt.toString(36)}-${this.sequence.toString(36)}`,
      acceptedAt,
      ...payload,
    } as PaymentRecord;
    this.entries.unshift(record);
    if (this.entries.length > MAX_RETAINED) {
      const dropped = this.entries.splice(MAX_RETAINED);
      for (const entry of dropped) {
        if (entry.source === 'onramp') {
          this.externalIndex.delete(onrampDedupeKey(entry.provider, entry.externalTransactionId));
        }
      }
    }
    return record;
  }
}

function onrampDedupeKey(provider: string, externalTransactionId: string): string {
  return `${provider}:${externalTransactionId}`;
}
