/**
 * IP → ISO country code resolution. Z13.3 anomaly detector consumes this to
 * compare an incoming payment's origin against a wallet's historical countries.
 *
 * The default resolver returns `null` for everything — we never want to ship a
 * stub that quietly fabricates geolocations. Production deployments pass a
 * real resolver (MaxMind GeoLite2, ipdata, ipinfo) via `CreatePaymentDeps`.
 * Tests use `staticGeoIpResolver` to pin known IPs to known countries.
 */
export type GeoIpResolver = (ip: string | null) => string | null;

export const noopGeoIpResolver: GeoIpResolver = () => null;

export function staticGeoIpResolver(
  map: Readonly<Record<string, string>>,
): GeoIpResolver {
  return (ip) => (ip && map[ip]) || null;
}
