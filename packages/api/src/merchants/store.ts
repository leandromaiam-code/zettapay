import type { Merchant } from "./types.js";

export interface MerchantStore {
  insert(merchant: Merchant): Promise<void>;
  update(merchant: Merchant): Promise<void>;
  findById(id: string): Promise<Merchant | null>;
  findByWallet(walletAddress: string): Promise<Merchant | null>;
  findByEmail(email: string): Promise<Merchant | null>;
  findByApiKey(apiKey: string): Promise<Merchant | null>;
  list(): Promise<Merchant[]>;
  clear(): Promise<void>;
}

/**
 * Z2.1 will replace this with a Postgres-backed store. The shape is designed
 * so swapping the implementation requires no changes in the routes/services.
 */
export class InMemoryMerchantStore implements MerchantStore {
  private readonly byId = new Map<string, Merchant>();
  private readonly byWallet = new Map<string, string>();
  private readonly byEmail = new Map<string, string>();
  private readonly byApiKey = new Map<string, string>();

  async insert(merchant: Merchant): Promise<void> {
    this.byId.set(merchant.id, merchant);
    this.byWallet.set(merchant.walletAddress, merchant.id);
    this.byEmail.set(merchant.email.toLowerCase(), merchant.id);
    this.byApiKey.set(merchant.apiKey, merchant.id);
  }

  async update(merchant: Merchant): Promise<void> {
    const prev = this.byId.get(merchant.id);
    if (prev === undefined) {
      throw new Error(`merchant ${merchant.id} not found`);
    }
    if (prev.walletAddress !== merchant.walletAddress) {
      this.byWallet.delete(prev.walletAddress);
      this.byWallet.set(merchant.walletAddress, merchant.id);
    }
    if (prev.email.toLowerCase() !== merchant.email.toLowerCase()) {
      this.byEmail.delete(prev.email.toLowerCase());
      this.byEmail.set(merchant.email.toLowerCase(), merchant.id);
    }
    if (prev.apiKey !== merchant.apiKey) {
      this.byApiKey.delete(prev.apiKey);
      this.byApiKey.set(merchant.apiKey, merchant.id);
    }
    this.byId.set(merchant.id, merchant);
  }

  async findById(id: string): Promise<Merchant | null> {
    return this.byId.get(id) ?? null;
  }

  async findByWallet(walletAddress: string): Promise<Merchant | null> {
    const id = this.byWallet.get(walletAddress);
    return id === undefined ? null : (this.byId.get(id) ?? null);
  }

  async findByEmail(email: string): Promise<Merchant | null> {
    const id = this.byEmail.get(email.toLowerCase());
    return id === undefined ? null : (this.byId.get(id) ?? null);
  }

  async findByApiKey(apiKey: string): Promise<Merchant | null> {
    const id = this.byApiKey.get(apiKey);
    return id === undefined ? null : (this.byId.get(id) ?? null);
  }

  async list(): Promise<Merchant[]> {
    return [...this.byId.values()];
  }

  async clear(): Promise<void> {
    this.byId.clear();
    this.byWallet.clear();
    this.byEmail.clear();
    this.byApiKey.clear();
  }
}

let singleton: MerchantStore | null = null;
export function getMerchantStore(): MerchantStore {
  if (singleton === null) singleton = new InMemoryMerchantStore();
  return singleton;
}

export function setMerchantStoreForTests(store: MerchantStore | null): void {
  singleton = store;
}
