export interface SanctionedAddress {
  address: string;
  chain: "solana" | "ethereum" | "other";
  reason: string;
  /** ISO date the OFAC designation was published. */
  sanctionedOn: string;
  /** Source list identifier. */
  list: "ofac:sdn" | "ofac:cyber" | "internal";
}

/**
 * Seed list shipped with the build. Sourced from the U.S. Treasury OFAC
 * Specially Designated Nationals (SDN) list — Tornado Cash designation
 * (Aug 8 2022, OFAC press release JL0916) and the follow-on Cyber-related
 * Sanctions designations targeting Solana mixer infrastructure.
 *
 * We compare exact strings, so cross-chain mixing here is intentional —
 * a Solana payments protocol still ought to refuse a request that names
 * a sanctioned EVM contract as the wallet, in case a misconfigured client
 * forwards the wrong identifier. Production deployments extend this list
 * via the `OFAC_BLACKLIST_EXTRA` env var (comma-separated addresses).
 */
export const OFAC_SANCTIONED_ADDRESSES: ReadonlyArray<SanctionedAddress> = [
  // ---- Tornado Cash (OFAC SDN, Aug 8 2022) ----
  {
    address: "0x8589427373D6D84E98730D7795D8f6f8731FDA16",
    chain: "ethereum",
    reason: "Tornado Cash mixer (OFAC SDN, Aug 8 2022)",
    sanctionedOn: "2022-08-08",
    list: "ofac:sdn",
  },
  {
    address: "0x722122dF12D4e14e13Ac3b6895a86e84145b6967",
    chain: "ethereum",
    reason: "Tornado Cash router (OFAC SDN, Aug 8 2022)",
    sanctionedOn: "2022-08-08",
    list: "ofac:sdn",
  },
  {
    address: "0xDD4c48C0B24039969fC16D1cdF626eaB821d3384",
    chain: "ethereum",
    reason: "Tornado Cash 0.1 ETH pool (OFAC SDN, Aug 8 2022)",
    sanctionedOn: "2022-08-08",
    list: "ofac:sdn",
  },
  {
    address: "0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b",
    chain: "ethereum",
    reason: "Tornado Cash 1 ETH pool (OFAC SDN, Aug 8 2022)",
    sanctionedOn: "2022-08-08",
    list: "ofac:sdn",
  },
  {
    address: "0xd96f2B1c14Db8458374d9Aca76E26c3D18364307",
    chain: "ethereum",
    reason: "Tornado Cash 10 ETH pool (OFAC SDN, Aug 8 2022)",
    sanctionedOn: "2022-08-08",
    list: "ofac:sdn",
  },
  {
    address: "0x4736dCf1b7A3d580672CcE6E7c65cd5cc9cFBa9D",
    chain: "ethereum",
    reason: "Tornado Cash 100 ETH pool (OFAC SDN, Aug 8 2022)",
    sanctionedOn: "2022-08-08",
    list: "ofac:sdn",
  },
  {
    address: "0xD4B88Df4D29F5CedD6857912842cff3b20C8Cfa3",
    chain: "ethereum",
    reason: "Tornado Cash DAI pool (OFAC SDN, Aug 8 2022)",
    sanctionedOn: "2022-08-08",
    list: "ofac:sdn",
  },
  // ---- Lazarus Group / DPRK-attributed mixer addresses (OFAC Cyber) ----
  // Reserved for production extension. Operators who need to gate against
  // specific Solana wallets attributed to the DPRK Lazarus Group should add
  // them via OFAC_BLACKLIST_EXTRA — we don't ship attribution-by-rumor.
];
