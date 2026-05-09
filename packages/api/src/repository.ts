import type { DB } from './db.js';
import { type Merchant, type MerchantRow, rowToMerchant } from './types.js';

export interface CreateMerchantInput {
  name: string;
  walletPubkey: string;
  usdcAta: string;
}

export interface UpdateMerchantInput {
  name?: string;
  walletPubkey?: string;
  usdcAta?: string;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
}

export class MerchantRepository {
  constructor(private readonly db: DB) {}

  create(input: CreateMerchantInput): Merchant {
    const stmt = this.db.prepare<[string, string, string]>(
      `INSERT INTO merchants (name, wallet_pubkey, usdc_ata)
       VALUES (?, ?, ?)
       RETURNING id, name, wallet_pubkey, usdc_ata, created_at`,
    );
    const row = stmt.get(input.name, input.walletPubkey, input.usdcAta) as MerchantRow;
    return rowToMerchant(row);
  }

  findById(id: number): Merchant | null {
    const row = this.db
      .prepare<[number]>('SELECT id, name, wallet_pubkey, usdc_ata, created_at FROM merchants WHERE id = ?')
      .get(id) as MerchantRow | undefined;
    return row ? rowToMerchant(row) : null;
  }

  findByWallet(walletPubkey: string): Merchant | null {
    const row = this.db
      .prepare<[string]>(
        'SELECT id, name, wallet_pubkey, usdc_ata, created_at FROM merchants WHERE wallet_pubkey = ?',
      )
      .get(walletPubkey) as MerchantRow | undefined;
    return row ? rowToMerchant(row) : null;
  }

  list(options: ListOptions = {}): Merchant[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const rows = this.db
      .prepare<[number, number]>(
        `SELECT id, name, wallet_pubkey, usdc_ata, created_at
         FROM merchants
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as MerchantRow[];
    return rows.map(rowToMerchant);
  }

  update(id: number, input: UpdateMerchantInput): Merchant | null {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.name !== undefined) {
      fields.push('name = ?');
      values.push(input.name);
    }
    if (input.walletPubkey !== undefined) {
      fields.push('wallet_pubkey = ?');
      values.push(input.walletPubkey);
    }
    if (input.usdcAta !== undefined) {
      fields.push('usdc_ata = ?');
      values.push(input.usdcAta);
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    const row = this.db
      .prepare(
        `UPDATE merchants SET ${fields.join(', ')}
         WHERE id = ?
         RETURNING id, name, wallet_pubkey, usdc_ata, created_at`,
      )
      .get(...values) as MerchantRow | undefined;

    return row ? rowToMerchant(row) : null;
  }

  delete(id: number): boolean {
    const result = this.db.prepare<[number]>('DELETE FROM merchants WHERE id = ?').run(id);
    return result.changes > 0;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM merchants').get() as { n: number };
    return row.n;
  }
}
