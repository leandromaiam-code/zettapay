// Express-side KeyManager (Z45). Thin wrapper that re-exports the
// canonical implementation from @zettapay/sdk so the long-running API
// server and the Vercel /api/admin lane stay in lock-step on derivation
// rules. Intentionally left out of the long-running build allow-list
// (packages/api/tsconfig.build.json) until the chronic packages/api
// syntax rot in src/db/payments.ts + src/server.ts is unwound — the
// canonical derivation already ships through the SDK lane and the public
// admin endpoint already runs through /api/admin/invoices.

export {
  KeyManager,
  InMemoryIndexAllocator,
  mnemonicToMasterKey,
  deriveAddressFromMaster,
  deriveBtcAddressFromMaster,
  deriveEvmAddressFromMaster,
  chainToNamespace,
  btcPathFor,
  evmPathFor,
  pathFor,
  type IndexAllocator,
  type IndexNamespace,
  type InvoiceChain,
  type DerivedInvoiceAddress,
  type KeyManagerOptions,
  type BitcoinNetwork,
} from '@zettapay/sdk';
