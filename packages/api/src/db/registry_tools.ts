import type { Database as Db } from "better-sqlite3";

export type RegistryToolStatus = "draft" | "published" | "suspended";

export interface RegistryToolRow {
  id: string;
  merchant_id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  endpoint_url: string;
  price_usdc: number;
  currency: string;
  input_schema_json: string;
  tags_json: string;
  homepage_url: string | null;
  docs_url: string | null;
  icon_url: string | null;
  status: RegistryToolStatus;
  install_count: number;
  call_count: number;
  created_at: string;
  updated_at: string;
}

export interface RegistryTool {
  id: string;
  merchantId: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  endpointUrl: string;
  priceUsdc: number;
  currency: string;
  inputSchema: Record<string, unknown>;
  tags: string[];
  homepageUrl: string | null;
  docsUrl: string | null;
  iconUrl: string | null;
  status: RegistryToolStatus;
  installCount: number;
  callCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface InsertRegistryToolInput {
  id: string;
  merchantId: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  endpointUrl: string;
  priceUsdc: number;
  currency: string;
  inputSchema: Record<string, unknown>;
  tags: string[];
  homepageUrl: string | null;
  docsUrl: string | null;
  iconUrl: string | null;
  status: RegistryToolStatus;
}

export interface UpdateRegistryToolInput {
  name?: string;
  description?: string;
  category?: string;
  endpointUrl?: string;
  priceUsdc?: number;
  currency?: string;
  inputSchema?: Record<string, unknown>;
  tags?: string[];
  homepageUrl?: string | null;
  docsUrl?: string | null;
  iconUrl?: string | null;
  status?: RegistryToolStatus;
}

export interface ListRegistryToolsFilter {
  status?: RegistryToolStatus;
  category?: string;
  merchantId?: string;
  query?: string;
  maxPriceUsdc?: number;
  limit?: number;
  offset?: number;
}

function toRegistryTool(row: RegistryToolRow): RegistryTool {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    endpointUrl: row.endpoint_url,
    priceUsdc: row.price_usdc,
    currency: row.currency,
    inputSchema: parseJsonObject(row.input_schema_json),
    tags: parseJsonArray(row.tags_json),
    homepageUrl: row.homepage_url,
    docsUrl: row.docs_url,
    iconUrl: row.icon_url,
    status: row.status,
    installCount: row.install_count,
    callCount: row.call_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

export function insertRegistryTool(
  db: Db,
  input: InsertRegistryToolInput,
): RegistryTool {
  db.prepare(
    `INSERT INTO registry_tools (
      id, merchant_id, slug, name, description, category, endpoint_url,
      price_usdc, currency, input_schema_json, tags_json,
      homepage_url, docs_url, icon_url, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.merchantId,
    input.slug,
    input.name,
    input.description,
    input.category,
    input.endpointUrl,
    input.priceUsdc,
    input.currency,
    JSON.stringify(input.inputSchema ?? {}),
    JSON.stringify(input.tags ?? []),
    input.homepageUrl,
    input.docsUrl,
    input.iconUrl,
    input.status,
  );

  const row = db
    .prepare<[string]>("SELECT * FROM registry_tools WHERE id = ?")
    .get(input.id) as RegistryToolRow | undefined;
  if (!row) throw new Error("registry_tools insert failed");
  return toRegistryTool(row);
}

export function findRegistryToolById(db: Db, id: string): RegistryTool | null {
  const row = db
    .prepare<[string]>("SELECT * FROM registry_tools WHERE id = ?")
    .get(id) as RegistryToolRow | undefined;
  return row ? toRegistryTool(row) : null;
}

export function findRegistryToolBySlug(
  db: Db,
  slug: string,
): RegistryTool | null {
  const row = db
    .prepare<[string]>("SELECT * FROM registry_tools WHERE slug = ?")
    .get(slug) as RegistryToolRow | undefined;
  return row ? toRegistryTool(row) : null;
}

export function listRegistryTools(
  db: Db,
  filter: ListRegistryToolsFilter = {},
): RegistryTool[] {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter.category) {
    where.push("category = ?");
    params.push(filter.category);
  }
  if (filter.merchantId) {
    where.push("merchant_id = ?");
    params.push(filter.merchantId);
  }
  if (typeof filter.maxPriceUsdc === "number") {
    where.push("price_usdc <= ?");
    params.push(filter.maxPriceUsdc);
  }
  if (filter.query && filter.query.trim().length > 0) {
    where.push("(name LIKE ? OR description LIKE ? OR slug LIKE ?)");
    const like = `%${filter.query.trim()}%`;
    params.push(like, like, like);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const limit = clamp(filter.limit ?? 50, 1, 200);
  const offset = Math.max(0, filter.offset ?? 0);

  const rows = db
    .prepare(
      `SELECT * FROM registry_tools
       ${whereClause}
       ORDER BY install_count DESC, created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as RegistryToolRow[];

  return rows.map(toRegistryTool);
}

export function updateRegistryTool(
  db: Db,
  id: string,
  input: UpdateRegistryToolInput,
): RegistryTool | null {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];

  if (input.name !== undefined) {
    sets.push("name = ?");
    params.push(input.name);
  }
  if (input.description !== undefined) {
    sets.push("description = ?");
    params.push(input.description);
  }
  if (input.category !== undefined) {
    sets.push("category = ?");
    params.push(input.category);
  }
  if (input.endpointUrl !== undefined) {
    sets.push("endpoint_url = ?");
    params.push(input.endpointUrl);
  }
  if (input.priceUsdc !== undefined) {
    sets.push("price_usdc = ?");
    params.push(input.priceUsdc);
  }
  if (input.currency !== undefined) {
    sets.push("currency = ?");
    params.push(input.currency);
  }
  if (input.inputSchema !== undefined) {
    sets.push("input_schema_json = ?");
    params.push(JSON.stringify(input.inputSchema));
  }
  if (input.tags !== undefined) {
    sets.push("tags_json = ?");
    params.push(JSON.stringify(input.tags));
  }
  if (input.homepageUrl !== undefined) {
    sets.push("homepage_url = ?");
    params.push(input.homepageUrl);
  }
  if (input.docsUrl !== undefined) {
    sets.push("docs_url = ?");
    params.push(input.docsUrl);
  }
  if (input.iconUrl !== undefined) {
    sets.push("icon_url = ?");
    params.push(input.iconUrl);
  }
  if (input.status !== undefined) {
    sets.push("status = ?");
    params.push(input.status);
  }

  if (sets.length === 0) return findRegistryToolById(db, id);

  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  params.push(id);

  db.prepare(
    `UPDATE registry_tools SET ${sets.join(", ")} WHERE id = ?`,
  ).run(...params);

  return findRegistryToolById(db, id);
}

export function deleteRegistryTool(db: Db, id: string): boolean {
  const result = db
    .prepare<[string]>("DELETE FROM registry_tools WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

export function incrementRegistryToolCallCount(db: Db, id: string): void {
  db.prepare<[string]>(
    "UPDATE registry_tools SET call_count = call_count + 1 WHERE id = ?",
  ).run(id);
}

export function incrementRegistryToolInstallCount(db: Db, id: string): void {
  db.prepare<[string]>(
    "UPDATE registry_tools SET install_count = install_count + 1 WHERE id = ?",
  ).run(id);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
