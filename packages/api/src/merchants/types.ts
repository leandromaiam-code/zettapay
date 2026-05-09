export type MerchantStatus = "pending" | "active" | "suspended";

export interface MerchantBinding {
  ataAddress: string;
  ataCreated: boolean;
  txSignature: string;
  memoPayload: string;
  feePayer: string;
  cluster: string;
  boundAt: string;
}

export interface Merchant {
  id: string;
  name: string;
  email: string;
  walletAddress: string;
  apiKey: string;
  webhookUrl: string | null;
  status: MerchantStatus;
  binding: MerchantBinding | null;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterMerchantInput {
  name: string;
  email: string;
  walletAddress: string;
  webhookUrl?: string | null;
}

export interface PublicMerchant {
  id: string;
  name: string;
  email: string;
  walletAddress: string;
  ataAddress: string | null;
  status: MerchantStatus;
  webhookUrl: string | null;
  createdAt: string;
}

export function toPublicMerchant(m: Merchant): PublicMerchant {
  return {
    id: m.id,
    name: m.name,
    email: m.email,
    walletAddress: m.walletAddress,
    ataAddress: m.binding?.ataAddress ?? null,
    status: m.status,
    webhookUrl: m.webhookUrl,
    createdAt: m.createdAt,
  };
}
