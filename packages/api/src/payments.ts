export interface PaymentRecord {
  id: string;
  feePayer: string;
  signers: string[];
  signatures: string[];
  recentBlockhash: string;
  isVersioned: boolean;
  version: number | null;
  transactionBytes: number;
  acceptedAt: number;
}

export interface ListPaymentsOptions {
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_RETAINED = 1000;

export class PaymentLog {
  private readonly entries: PaymentRecord[] = [];
  private sequence = 0;

  record(input: Omit<PaymentRecord, 'id' | 'acceptedAt'>): PaymentRecord {
    const acceptedAt = Date.now();
    this.sequence += 1;
    const record: PaymentRecord = {
      id: `${acceptedAt.toString(36)}-${this.sequence.toString(36)}`,
      acceptedAt,
      ...input,
    };
    this.entries.unshift(record);
    if (this.entries.length > MAX_RETAINED) {
      this.entries.length = MAX_RETAINED;
    }
    return record;
  }

  list(options: ListPaymentsOptions = {}): PaymentRecord[] {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(options.offset ?? 0, 0);
    return this.entries.slice(offset, offset + limit);
  }

  findById(id: string): PaymentRecord | null {
    return this.entries.find((entry) => entry.id === id) ?? null;
  }

  count(): number {
    return this.entries.length;
  }
}
