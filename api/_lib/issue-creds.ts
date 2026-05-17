import { createHash, createHmac, randomBytes } from 'node:crypto';

const ID_HMAC_KEY = process.env.ZETTAPAY_MERCHANT_ID_SECRET || 'zettapay-merchant-id-dev-secret';
const KEY_HMAC_KEY = process.env.ZETTAPAY_DASHBOARD_SECRET || 'zettapay-dashboard-dev-secret';

export interface IssuedCredentials {
  merchantId: string;
  apiKey: string;
  webhookSecret: string;
  apiKeyHash: string;
  webhookSecretHash: string;
}

export function deriveMerchantId(email: string): string {
  const digest = createHmac('sha256', ID_HMAC_KEY)
    .update('merchant_id:' + email.toLowerCase())
    .digest('hex');
  return 'mch_' + digest.slice(0, 24);
}

export function freshApiKey(): string {
  return 'zk_live_' + randomBytes(24).toString('base64url');
}

export function freshWebhookSecret(): string {
  return 'whsec_' + randomBytes(32).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function deterministicApiKey(merchantId: string): string {
  return (
    'zk_live_' +
    createHmac('sha256', KEY_HMAC_KEY).update('apiKey:' + merchantId).digest('base64url').slice(0, 32)
  );
}

export function deterministicWebhookSecret(merchantId: string): string {
  return (
    'whsec_' +
    createHmac('sha256', KEY_HMAC_KEY)
      .update('webhookSecret:' + merchantId)
      .digest('base64url')
      .slice(0, 40)
  );
}

export function issueCredentials(email: string): IssuedCredentials {
  const merchantId = deriveMerchantId(email);
  const apiKey = deterministicApiKey(merchantId);
  const webhookSecret = deterministicWebhookSecret(merchantId);
  return {
    merchantId,
    apiKey,
    webhookSecret,
    apiKeyHash: sha256Hex(apiKey),
    webhookSecretHash: sha256Hex(webhookSecret),
  };
}
