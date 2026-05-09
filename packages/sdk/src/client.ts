import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { fromAxiosError } from './errors.js';
import type {
  HealthStatus,
  ListMerchantsOptions,
  ListMerchantsResponse,
  ListPaymentsOptions,
  ListPaymentsResponse,
  Merchant,
  PayResponse,
  PaymentRecord,
  RegisterMerchantInput,
  UpdateMerchantInput,
} from './types.js';

export const X402_HEADER = 'x-402-payment';

export interface ZettaPayClientOptions {
  baseURL: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  axiosInstance?: AxiosInstance;
}

export interface PayInput {
  /** Base64-encoded signed Solana transaction (legacy or v0). Max 1232 bytes decoded. */
  transaction: string;
}

function toBase64(transaction: string | Uint8Array): string {
  if (typeof transaction === 'string') return transaction;
  return Buffer.from(transaction).toString('base64');
}

export class ZettaPayClient {
  private readonly http: AxiosInstance;

  constructor(options: ZettaPayClientOptions) {
    if (!options.baseURL || typeof options.baseURL !== 'string') {
      throw new Error('ZettaPayClient: baseURL is required');
    }
    this.http =
      options.axiosInstance ??
      axios.create({
        baseURL: options.baseURL.replace(/\/+$/, ''),
        timeout: options.timeoutMs ?? 10_000,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...options.headers,
        },
      });
  }

  /** Submit a signed Solana transaction to the X-402 /pay endpoint. */
  async pay(input: PayInput | string | Uint8Array): Promise<PayResponse> {
    const transaction =
      typeof input === 'string' || input instanceof Uint8Array
        ? toBase64(input)
        : toBase64(input.transaction);
    if (!transaction || transaction.length === 0) {
      throw new Error('ZettaPayClient.pay: transaction is required');
    }
    return this.request<PayResponse>({
      method: 'post',
      url: '/pay',
      headers: { [X402_HEADER]: transaction },
    });
  }

  /** Register a new merchant. POST /merchants */
  async registerMerchant(input: RegisterMerchantInput): Promise<Merchant> {
    return this.request<Merchant>({
      method: 'post',
      url: '/merchants',
      data: {
        name: input.name,
        wallet_pubkey: input.walletPubkey,
        usdc_ata: input.usdcAta,
      },
    });
  }

  /** Fetch a merchant by id. GET /merchants/:id */
  async getMerchant(id: number): Promise<Merchant> {
    return this.request<Merchant>({ method: 'get', url: `/merchants/${id}` });
  }

  /** List merchants. GET /merchants */
  async listMerchants(options: ListMerchantsOptions = {}): Promise<ListMerchantsResponse> {
    return this.request<ListMerchantsResponse>({
      method: 'get',
      url: '/merchants',
      params: options,
    });
  }

  /** Patch a merchant. PATCH /merchants/:id */
  async updateMerchant(id: number, patch: UpdateMerchantInput): Promise<Merchant> {
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.walletPubkey !== undefined) body.wallet_pubkey = patch.walletPubkey;
    if (patch.usdcAta !== undefined) body.usdc_ata = patch.usdcAta;
    return this.request<Merchant>({
      method: 'patch',
      url: `/merchants/${id}`,
      data: body,
    });
  }

  /** Delete a merchant. DELETE /merchants/:id */
  async deleteMerchant(id: number): Promise<void> {
    await this.request<void>({ method: 'delete', url: `/merchants/${id}` });
  }

  /** Fetch a payment by id. GET /payments/:id */
  async getPayment(id: string): Promise<PaymentRecord> {
    if (!id || typeof id !== 'string') {
      throw new Error('ZettaPayClient.getPayment: id is required');
    }
    return this.request<PaymentRecord>({
      method: 'get',
      url: `/payments/${encodeURIComponent(id)}`,
    });
  }

  /** List payments. GET /payments */
  async listPayments(options: ListPaymentsOptions = {}): Promise<ListPaymentsResponse> {
    return this.request<ListPaymentsResponse>({
      method: 'get',
      url: '/payments',
      params: options,
    });
  }

  /** Health probe. GET /healthz */
  async health(): Promise<HealthStatus> {
    return this.request<HealthStatus>({ method: 'get', url: '/healthz' });
  }

  private async request<T>(config: AxiosRequestConfig): Promise<T> {
    try {
      const response = await this.http.request<T>(config);
      return response.data;
    } catch (err) {
      throw fromAxiosError(err);
    }
  }
}
