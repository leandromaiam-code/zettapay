export interface Merchant {
  id: number;
  name: string;
  walletPubkey: string;
  usdcAta: string;
  createdAt: number;
}

export interface RegisterMerchantInput {
  name: string;
  walletPubkey: string;
  usdcAta: string;
}

export interface UpdateMerchantInput {
  name?: string;
  walletPubkey?: string;
  usdcAta?: string;
}

export interface ListMerchantsOptions {
  limit?: number;
  offset?: number;
}

export interface ListMerchantsResponse {
  items: Merchant[];
  count: number;
}

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

export interface PayResponse {
  accepted: boolean;
  paymentId: string;
  feePayer: string;
  signers: string[];
  signatureCount: number;
  recentBlockhash: string;
  isVersioned: boolean;
  version: number | null;
  transactionBytes: number;
}

export interface ListPaymentsOptions {
  limit?: number;
  offset?: number;
}

export interface ListPaymentsResponse {
  items: PaymentRecord[];
  count: number;
  total: number;
}

export interface HealthStatus {
  status: 'ok';
  merchants: number;
  payments: number;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
