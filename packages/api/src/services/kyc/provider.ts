/**
 * KYC provider abstraction. Sumsub is canonical (Z21.1) but the surface keeps
 * the door open for Persona / others without leaking SDK shapes into routes.
 *
 * The contract is intentionally minimal — the heavy lifting (document
 * collection, OCR, biometrics) happens client-side via the provider's WebSDK.
 * The server records intent + applicant linkage and consumes review verdicts
 * via the webhook channel.
 */
export interface CreateApplicantInput {
  /** Stable external id we use to correlate the applicant to our merchant. */
  externalUserId: string;
  /** Provider-specific verification level (e.g., "basic-kyb-level"). */
  levelName: string;
  email?: string | null;
}

export interface CreateApplicantResult {
  applicantId: string;
}

export interface AccessTokenInput {
  externalUserId: string;
  levelName: string;
  /** Token TTL in seconds. Sumsub default is 600. */
  ttlSeconds?: number;
}

export interface AccessTokenResult {
  token: string;
  expiresAt: string;
  userId: string;
}

export type WebhookVerifyResult =
  | { valid: true }
  | { valid: false; reason: string };

export interface KycProviderClient {
  readonly name: "sumsub" | "persona";
  createApplicant(input: CreateApplicantInput): Promise<CreateApplicantResult>;
  issueAccessToken(input: AccessTokenInput): Promise<AccessTokenResult>;
  /**
   * Verify a webhook delivery. `rawBody` MUST be the unparsed request body —
   * Sumsub signs the bytes, so any JSON re-serialization breaks the signature.
   */
  verifyWebhook(input: {
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
  }): WebhookVerifyResult;
}
