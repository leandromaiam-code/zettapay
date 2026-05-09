export interface MerchantRow {
  id: number;
  name: string;
  wallet_pubkey: string;
  usdc_ata: string;
  created_at: number;
}

export interface Merchant {
  id: number;
  name: string;
  walletPubkey: string;
  usdcAta: string;
  createdAt: number;
}

export function rowToMerchant(row: MerchantRow): Merchant {
  return {
    id: row.id,
    name: row.name,
    walletPubkey: row.wallet_pubkey,
    usdcAta: row.usdc_ata,
    createdAt: row.created_at,
  };
}
