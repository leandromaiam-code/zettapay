// Outbound-request guard for merchant-supplied webhook URLs.
//
// Signup is open, and the dispatcher POSTs to whatever URL a merchant stores.
// Without a guard that is a server-side request forgery primitive against
// everything reachable from the host (loopback, the container bridge, cloud
// metadata). So a webhook URL must be https and must resolve ONLY to public
// addresses — checked when it is saved and again right before every delivery
// (a hostname can be re-pointed after it was accepted).

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type LookupFn = (hostname: string) => Promise<string[]>;

export class UnsafeUrlError extends Error {
  constructor(public readonly reason: string) {
    super(`webhook url rejected: ${reason}`);
  }
}

const defaultLookup: LookupFn = async (hostname) => {
  const found = await dnsLookup(hostname, { all: true, verbatim: true });
  return found.map((f) => f.address);
};

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>> 0;
}

function inRange(ip: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
];

/** True when an IP literal is loopback, private, link-local, reserved or multicast. */
export function isNonPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const n = ipv4ToInt(address);
    return BLOCKED_V4.some(([base, bits]) => inRange(n, base, bits));
  }
  if (kind === 6) {
    const a = address.toLowerCase();
    if (a === '::' || a === '::1') return true;
    // IPv4-mapped (::ffff:a.b.c.d) — judge the embedded IPv4.
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isNonPublicAddress(mapped[1]);
    const head = parseInt(a.split(':')[0] || '0', 16);
    if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
  }
  return true; // not an IP at all
}

/**
 * Throw {@link UnsafeUrlError} unless `raw` is an https URL on the default port
 * whose host resolves exclusively to public addresses.
 */
export async function assertPublicHttpsUrl(raw: string, lookup: LookupFn = defaultLookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('not a valid URL');
  }
  if (url.protocol !== 'https:') throw new UnsafeUrlError('must be https');
  if (url.username || url.password) throw new UnsafeUrlError('must not carry credentials');
  if (url.port && url.port !== '443') throw new UnsafeUrlError('must use the default https port');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isNonPublicAddress(host)) throw new UnsafeUrlError('address is not public');
    return url;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new UnsafeUrlError('hostname is not public');
  }
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new UnsafeUrlError('hostname does not resolve');
  }
  if (addresses.length === 0) throw new UnsafeUrlError('hostname does not resolve');
  if (addresses.some(isNonPublicAddress)) throw new UnsafeUrlError('hostname resolves to a non-public address');
  return url;
}
