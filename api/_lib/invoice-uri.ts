// Wallet-less checkout URI builders (Z45). The customer never connects a
// wallet to ZettaPay — they scan a QR code (or click a deep link) that
// their own wallet recognises and pre-fills with our derived address + the
// exact amount. BIP-21 for Bitcoin, EIP-681 for EVM/USDC.

import type { InvoiceChain } from './hd-wallet.js';

export interface InvoiceUriParams {
  chain: InvoiceChain;
  address: string;
  amountNative: string;
}

// Native USDC contracts. Pinned to mainnet — testnet usage flips via the
// BTC_NETWORK env and is out of scope for this foundation mission.
const USDC_CONTRACT: Record<Exclude<InvoiceChain, 'btc'>, string> = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
};

const EVM_CHAIN_ID: Record<Exclude<InvoiceChain, 'btc'>, number> = {
  base: 8453,
  polygon: 137,
  ethereum: 1,
};

const USDC_DECIMALS = 6;

export function buildInvoiceUri({ chain, address, amountNative }: InvoiceUriParams): string {
  if (chain === 'btc') {
    return `bitcoin:${address}?amount=${amountNative}`;
  }
  const contract = USDC_CONTRACT[chain];
  const chainId = EVM_CHAIN_ID[chain];
  const amountSmallest = decimalToSmallestUnits(amountNative, USDC_DECIMALS);
  // EIP-681: <contract>@<chainId>/transfer?address=<to>&uint256=<amount>
  return `ethereum:${contract}@${chainId}/transfer?address=${address}&uint256=${amountSmallest}`;
}

function decimalToSmallestUnits(amount: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error(`invoice-uri: invalid decimal amount ${amount}`);
  }
  const [whole, frac = ''] = amount.split('.');
  if (frac.length > decimals) {
    throw new Error(`invoice-uri: amount ${amount} exceeds ${decimals} decimals`);
  }
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, '');
  return combined.length === 0 ? '0' : combined;
}

export function defaultRequiredConfirmations(chain: InvoiceChain): number {
  switch (chain) {
    case 'btc':
      return 2;
    case 'base':
      return 5;
    case 'polygon':
      return 30;
    case 'ethereum':
      return 12;
  }
}
