/**
 * ZettaPay Anchor IDL — frozen snapshot mirroring `idl/zettapay.json` at
 * repo root (which itself mirrors `target/idl/zettapay.json` after each
 * `anchor build`).
 *
 * Embedded as a TypeScript constant rather than a `.json` import so the
 * compiled SDK bundle has zero runtime file lookups: ESM consumers and
 * bundlers (Vite, Webpack, esbuild) get a static object literal.
 *
 * If you change the on-chain program (`programs/zettapay/src/lib.rs`),
 * regenerate `target/idl/zettapay.json` via `anchor build`, copy it to
 * `idl/zettapay.json`, and update the discriminators below. Drift between
 * this constant and the deployed program will silently mis-derive
 * discriminators and break instruction decoding on the client.
 */
export const ZETTAPAY_IDL = {
  address: 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS',
  metadata: {
    name: 'zettapay',
    version: '0.1.0',
    spec: '0.1.0',
    description: 'ZettaPay merchant binding + payment receipt program (Z9).',
  },
  instructions: {
    registerMerchant: {
      name: 'register_merchant',
      discriminator: [238, 245, 77, 132, 161, 88, 216, 248] as const,
    },
    recordPayment: {
      name: 'record_payment',
      discriminator: [226, 154, 10, 27, 9, 14, 148, 137] as const,
    },
  },
  accounts: {
    MerchantBinding: {
      discriminator: [27, 4, 136, 253, 13, 147, 60, 128] as const,
    },
    Payment: {
      discriminator: [227, 231, 51, 26, 244, 88, 4, 148] as const,
    },
  },
  events: {
    MerchantRegistered: {
      discriminator: [202, 61, 140, 95, 139, 239, 17, 83] as const,
    },
    PaymentRecorded: {
      discriminator: [214, 3, 212, 116, 135, 35, 104, 98] as const,
    },
  },
  errors: [
    { code: 6000, name: 'HandleLengthInvalid', msg: 'Merchant handle must be between 3 and 32 bytes inclusive' },
    { code: 6001, name: 'HandleCharsInvalid', msg: 'Merchant handle must be lowercase ASCII alphanumerics with - or _, and must start with an alphanumeric' },
    { code: 6002, name: 'AmountMustBePositive', msg: 'Payment amount must be strictly greater than zero' },
  ],
} as const;

export type ZettaPayErrorCode = (typeof ZETTAPAY_IDL)['errors'][number]['name'];
