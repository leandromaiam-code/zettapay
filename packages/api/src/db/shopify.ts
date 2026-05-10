import type { Database as Db } from "better-sqlite3";

export type ShopifyInstallationStatus = "pending" | "installed" | "uninstalled";

export interface ShopifyInstallationRow {
  id: string;
  shop_domain: string;
  merchant_id: string;
  access_token: string | null;
  scope: string | null;
  status: ShopifyInstallationStatus;
  oauth_nonce: string | null;
  created_at: string;
  installed_at: string | null;
  uninstalled_at: string | null;
  updated_at: string;
}

export interface ShopifyInstallation {
  id: string;
  shopDomain: string;
  merchantId: string;
  accessToken: string | null;
  scope: string | null;
  status: ShopifyInstallationStatus;
  oauthNonce: string | null;
  createdAt: string;
  installedAt: string | null;
  uninstalledAt: string | null;
  updatedAt: string;
}

function toInstallation(row: ShopifyInstallationRow): ShopifyInstallation {
  return {
    id: row.id,
    shopDomain: row.shop_domain,
    merchantId: row.merchant_id,
    accessToken: row.access_token,
    scope: row.scope,
    status: row.status,
    oauthNonce: row.oauth_nonce,
    createdAt: row.created_at,
    installedAt: row.installed_at,
    uninstalledAt: row.uninstalled_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertPendingInput {
  id: string;
  shopDomain: string;
  merchantId: string;
  oauthNonce: string;
}

/**
 * Records a fresh OAuth attempt. If the merchant retries `/install`, the
 * pending nonce is overwritten so a stale callback can't replay against the
 * new attempt.
 */
export function upsertPendingInstallation(
  db: Db,
  input: UpsertPendingInput,
): ShopifyInstallation {
  const stmt = db.prepare<[string, string, string, string]>(
    `INSERT INTO shopify_installations (id, shop_domain, merchant_id, oauth_nonce, status)
     VALUES (?, ?, ?, ?, 'pending')
     ON CONFLICT(shop_domain) DO UPDATE SET
       merchant_id = excluded.merchant_id,
       oauth_nonce = excluded.oauth_nonce,
       status      = CASE WHEN shopify_installations.status = 'installed'
                          THEN shopify_installations.status
                          ELSE 'pending' END,
       updated_at  = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  );
  stmt.run(input.id, input.shopDomain, input.merchantId, input.oauthNonce);
  const row = findRowByShopDomain(db, input.shopDomain);
  if (!row) throw new Error("shopify installation not retrievable after upsert");
  return toInstallation(row);
}

export function findInstallationByShopDomain(
  db: Db,
  shopDomain: string,
): ShopifyInstallation | null {
  const row = findRowByShopDomain(db, shopDomain);
  return row ? toInstallation(row) : null;
}

function findRowByShopDomain(db: Db, shopDomain: string): ShopifyInstallationRow | undefined {
  return db
    .prepare<[string]>("SELECT * FROM shopify_installations WHERE shop_domain = ?")
    .get(shopDomain) as ShopifyInstallationRow | undefined;
}

export interface CompleteInstallationInput {
  shopDomain: string;
  accessToken: string;
  scope: string;
  expectedNonce: string;
}

/**
 * Closes the OAuth handshake. Returns null when the row is missing or the
 * stored nonce doesn't match — the caller treats that as 401, not 500.
 */
export function completeInstallation(
  db: Db,
  input: CompleteInstallationInput,
): ShopifyInstallation | null {
  const existing = findRowByShopDomain(db, input.shopDomain);
  if (!existing) return null;
  if (existing.oauth_nonce !== input.expectedNonce) return null;

  const stmt = db.prepare<[string, string, string]>(
    `UPDATE shopify_installations
        SET access_token   = ?,
            scope          = ?,
            status         = 'installed',
            oauth_nonce    = NULL,
            installed_at   = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            uninstalled_at = NULL,
            updated_at     = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE shop_domain = ?`,
  );
  stmt.run(input.accessToken, input.scope, input.shopDomain);
  const row = findRowByShopDomain(db, input.shopDomain);
  return row ? toInstallation(row) : null;
}

export function markUninstalled(db: Db, shopDomain: string): boolean {
  const stmt = db.prepare<[string]>(
    `UPDATE shopify_installations
        SET status         = 'uninstalled',
            access_token   = NULL,
            uninstalled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at     = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE shop_domain = ?`,
  );
  return stmt.run(shopDomain).changes > 0;
}
