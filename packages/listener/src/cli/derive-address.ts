// `zettapay-listener derive-address` — derive a single BIP-84 receive
// address from the merchant's xpub. Pure read-only: never mutates the
// storage counter, never increments next_child_index. Use `create-invoice`
// when you want a fresh address bound to a payable record.
//
// Flags:
//   --index <n>     Explicit child index (defaults to merchant.next_child_index).
//   --xpub <key>    Override MERCHANT_XPUB from .env (handy for one-off checks).
//
// HR-CUSTODY: --xpub passes through validateXpubFormat, which rejects every
// extended-private prefix.
// HR-PHONE-HOME: zero network calls. Pure crypto.

import { createStorage } from '../storage/index.js';
import { deriveBip84Address, type Bech32Hrp } from '../derive-bip84.js';
import {
  getNetworkConfig,
  isNetwork,
  isNetworkCompatibleWithXpub,
  readNetwork,
  defaultNetworkForXpubKind,
  type Network,
} from '../network.js';
import {
  c,
  flagBool,
  flagString,
  parseFlags,
  validateXpubFormat,
  XpubFormatError,
} from './util.js';

export interface DeriveAddressOptions {
  env?: NodeJS.ProcessEnv;
}

function helpText(): string {
  return [
    `${c.bold('zettapay-listener derive-address')} — derive a BIP-84 receive address`,
    '',
    '  --index <n>      Explicit child index (defaults to merchant.next_child_index)',
    '  --xpub <key>     Override MERCHANT_XPUB from .env',
    '  --network <n>    mainnet | testnet | signet | regtest (defaults to MERCHANT_NETWORK)',
    '',
    'Output:',
    '  address: bc1q... / tb1q... / bcrt1q...   path: m/0/<n>   network: mainnet|testnet|signet|regtest',
    '',
    `${c.yellow('HR-CUSTODY:')} extended PRIVATE keys (xprv/zprv/...) are refused.`,
    '',
  ].join('\n');
}

export async function runDeriveAddress(
  argv: readonly string[],
  opts: DeriveAddressOptions = {},
): Promise<number> {
  const { flags } = parseFlags(argv);
  if (flagBool(flags, 'help')) {
    process.stdout.write(helpText());
    return 0;
  }

  const env = opts.env ?? process.env;
  const xpubRaw = flagString(flags, 'xpub') ?? env.MERCHANT_XPUB;
  if (!xpubRaw) {
    process.stderr.write(
      c.red('derive-address: MERCHANT_XPUB missing. Run `zettapay-listener init` or pass --xpub.\n'),
    );
    return 2;
  }

  let xpubKind: 'mainnet' | 'testnet';
  try {
    xpubKind = validateXpubFormat(xpubRaw).kind;
  } catch (err) {
    const msg = err instanceof XpubFormatError ? err.message : (err as Error).message;
    process.stderr.write(c.red(`derive-address: ${msg}\n`));
    return 2;
  }

  // Resolve the target network. Priority: explicit --network flag → env
  // MERCHANT_NETWORK → default derived from xpub kind. We then guard against
  // mainnet/testnet mixups so a vpub never accidentally produces a bc1...
  // address that the listener would try to subscribe to on signet.
  const networkFlag = flagString(flags, 'network');
  let network: Network;
  if (networkFlag) {
    if (!isNetwork(networkFlag)) {
      process.stderr.write(
        c.red(`derive-address: unknown --network "${networkFlag}"\n`),
      );
      return 2;
    }
    network = networkFlag;
  } else {
    try {
      network = readNetwork(env, defaultNetworkForXpubKind(xpubKind));
    } catch (err) {
      process.stderr.write(c.red(`derive-address: ${(err as Error).message}\n`));
      return 2;
    }
  }
  if (!isNetworkCompatibleWithXpub(network, xpubKind)) {
    process.stderr.write(
      c.red(
        `derive-address: ${xpubKind} xpub cannot be used on network "${network}". ` +
          (xpubKind === 'mainnet'
            ? 'mainnet xpub (zpub/xpub/ypub) only watches mainnet.'
            : 'testnet xpub (vpub/tpub/upub) only watches testnet, signet, or regtest.') +
          '\n',
      ),
    );
    return 2;
  }
  const profile = getNetworkConfig(network, env);
  const hrp: Bech32Hrp = profile.addressPrefix === 'bc1' ? 'bc' : profile.addressPrefix === 'bcrt1' ? 'bcrt' : 'tb';

  let index: number;
  const indexFlag = flagString(flags, 'index');
  if (indexFlag != null) {
    const parsed = Number.parseInt(indexFlag, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      process.stderr.write(c.red(`derive-address: --index must be a non-negative integer\n`));
      return 2;
    }
    index = parsed;
  } else {
    // Peek at next_child_index WITHOUT incrementing. Read-only.
    const storage = createStorage(env);
    try {
      const merchant = await storage.getMerchant(env.MERCHANT_ID ?? 'default');
      index = merchant?.next_child_index ?? 0;
    } finally {
      if (storage.close) await storage.close();
    }
  }

  let derived;
  try {
    derived = deriveBip84Address({ xpub: xpubRaw, index, hrp });
  } catch (err) {
    process.stderr.write(c.red(`derive-address: ${(err as Error).message}\n`));
    return 1;
  }

  process.stdout.write(
    [
      `${c.bold('address:')} ${derived.address}`,
      `${c.dim('path:')}    ${derived.path}`,
      `${c.dim('network:')} ${network}`,
      `${c.dim('pubkey:')}  ${derived.publicKey}`,
      '',
    ].join('\n'),
  );
  return 0;
}
