import { Router, type Request, type Response } from "express";
import type { Database as Db } from "better-sqlite3";
import {
  findRegistryToolBySlug,
  incrementRegistryToolInstallCount,
  listRegistryTools,
  type RegistryTool,
} from "../db/registry_tools.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "zettapay-mcp-marketplace";
const SERVER_VERSION = "0.1.0";
const JSONRPC_VERSION = "2.0";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

interface DiscoveryTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const DISCOVERY_TOOLS: DiscoveryTool[] = [
  {
    name: "discover_tools",
    description:
      "Search the ZettaPay MCP marketplace for paid tools. Returns x402-priced MCP tools published by third parties — filter by category, max price (USDC), or free-text query.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text search across tool name/description/slug",
          maxLength: 200,
        },
        category: {
          type: "string",
          description: "Restrict to a single category (e.g. data, llm, vision)",
          maxLength: 64,
        },
        maxPriceUsdc: {
          type: "number",
          description: "Maximum price per call in USDC",
          minimum: 0,
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 25,
        },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_tool",
    description:
      "Fetch the full marketplace listing for a tool by slug — includes endpoint URL, x402 price, input schema, and publisher metadata required to call it.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "Marketplace slug",
          maxLength: 64,
        },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "install_tool",
    description:
      "Record an install for a published marketplace tool (used for ranking/popularity). Returns the tool listing so the agent can immediately wire the endpoint into its toolbelt.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", maxLength: 64 },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
];

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcError {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

function rpcSuccess(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textContent(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function toolError(message: string, code: string) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: { code, message } }),
      },
    ],
    isError: true,
  };
}

function publicListing(tool: RegistryTool) {
  return {
    slug: tool.slug,
    name: tool.name,
    description: tool.description,
    category: tool.category,
    endpointUrl: tool.endpointUrl,
    priceUsdc: tool.priceUsdc,
    currency: tool.currency,
    inputSchema: tool.inputSchema,
    tags: tool.tags,
    homepageUrl: tool.homepageUrl,
    docsUrl: tool.docsUrl,
    iconUrl: tool.iconUrl,
    paymentProtocol: "x402",
    installCount: tool.installCount,
    callCount: tool.callCount,
    publishedAt: tool.createdAt,
  };
}

function callDiscoverTools(args: Record<string, unknown>, db: Db) {
  const filter: Parameters<typeof listRegistryTools>[1] = {
    status: "published",
  };
  if (typeof args.query === "string" && args.query.trim().length > 0) {
    filter.query = args.query.trim();
  }
  if (typeof args.category === "string" && args.category.trim().length > 0) {
    filter.category = args.category.trim().toLowerCase();
  }
  if (typeof args.maxPriceUsdc === "number" && Number.isFinite(args.maxPriceUsdc)) {
    if (args.maxPriceUsdc < 0) {
      return toolError("maxPriceUsdc must be ≥ 0", "invalid_arguments");
    }
    filter.maxPriceUsdc = args.maxPriceUsdc;
  }
  if (typeof args.limit === "number" && Number.isInteger(args.limit)) {
    if (args.limit < 1 || args.limit > 100) {
      return toolError("limit must be between 1 and 100", "invalid_arguments");
    }
    filter.limit = args.limit;
  } else {
    filter.limit = 25;
  }
  if (typeof args.offset === "number" && Number.isInteger(args.offset)) {
    if (args.offset < 0) {
      return toolError("offset must be ≥ 0", "invalid_arguments");
    }
    filter.offset = args.offset;
  }
  const tools = listRegistryTools(db, filter).map(publicListing);
  return textContent({ tools, count: tools.length });
}

function callGetTool(args: Record<string, unknown>, db: Db) {
  if (typeof args.slug !== "string" || args.slug.trim().length === 0) {
    return toolError("slug must be a non-empty string", "invalid_arguments");
  }
  const tool = findRegistryToolBySlug(db, args.slug.trim());
  if (!tool || tool.status !== "published") {
    return toolError(`tool "${args.slug}" not found`, "not_found");
  }
  return textContent({ tool: publicListing(tool) });
}

function callInstallTool(args: Record<string, unknown>, db: Db) {
  if (typeof args.slug !== "string" || args.slug.trim().length === 0) {
    return toolError("slug must be a non-empty string", "invalid_arguments");
  }
  const tool = findRegistryToolBySlug(db, args.slug.trim());
  if (!tool || tool.status !== "published") {
    return toolError(`tool "${args.slug}" not found`, "not_found");
  }
  incrementRegistryToolInstallCount(db, tool.id);
  const refreshed = findRegistryToolBySlug(db, args.slug.trim()) ?? tool;
  return textContent({ tool: publicListing(refreshed) });
}

function dispatchToolCall(name: string, args: Record<string, unknown>, db: Db) {
  switch (name) {
    case "discover_tools":
      return { ok: true as const, result: callDiscoverTools(args, db) };
    case "get_tool":
      return { ok: true as const, result: callGetTool(args, db) };
    case "install_tool":
      return { ok: true as const, result: callInstallTool(args, db) };
    default:
      return {
        ok: false as const,
        code: METHOD_NOT_FOUND,
        message: `unknown tool: ${name}`,
      };
  }
}

function handleRpc(req: JsonRpcRequest, db: Db): JsonRpcResponse | null {
  const rawId = req.id;
  const id =
    typeof rawId === "string" || typeof rawId === "number" || rawId === null
      ? rawId
      : null;
  const isNotification = rawId === undefined;

  if (req.jsonrpc !== JSONRPC_VERSION) {
    return isNotification
      ? null
      : rpcError(id, INVALID_REQUEST, 'jsonrpc must be "2.0"');
  }
  if (typeof req.method !== "string") {
    return isNotification
      ? null
      : rpcError(id, INVALID_REQUEST, "method must be a string");
  }

  const params = asObject(req.params);

  switch (req.method) {
    case "initialize":
      return isNotification
        ? null
        : rpcSuccess(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          });
    case "notifications/initialized":
    case "initialized":
      return null;
    case "ping":
      return isNotification ? null : rpcSuccess(id, {});
    case "tools/list":
      return isNotification
        ? null
        : rpcSuccess(id, { tools: DISCOVERY_TOOLS });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") {
        return isNotification
          ? null
          : rpcError(id, INVALID_PARAMS, "params.name must be a string");
      }
      const args = asObject(params.arguments);
      const dispatched = dispatchToolCall(name, args, db);
      if (!dispatched.ok) {
        return isNotification
          ? null
          : rpcError(id, dispatched.code, dispatched.message);
      }
      return isNotification ? null : rpcSuccess(id, dispatched.result);
    }
    default:
      return isNotification
        ? null
        : rpcError(id, METHOD_NOT_FOUND, `method not found: ${req.method}`);
  }
}

/**
 * MCP marketplace router. Exposes the registry over JSON-RPC so AI agents
 * can `tools/list` to find paid x402 tools and `tools/call` to discover,
 * inspect, and bookmark them. The actual paid endpoints live under each
 * tool's `endpointUrl` and are settled out-of-band via x402.
 */
export function mcpRegistryRouter(db: Db): Router {
  const router = Router();

  router.get("/mcp/marketplace", (_req: Request, res: Response) => {
    res.json({
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: { listChanged: false } },
      tools: DISCOVERY_TOOLS,
    });
  });

  router.post("/mcp/marketplace", (req: Request, res: Response) => {
    const body = req.body as unknown;

    if (Array.isArray(body)) {
      if (body.length === 0) {
        res
          .status(200)
          .json(rpcError(null, INVALID_REQUEST, "batch must not be empty"));
        return;
      }
      const responses: JsonRpcResponse[] = [];
      for (const entry of body) {
        if (!entry || typeof entry !== "object") {
          responses.push(
            rpcError(null, INVALID_REQUEST, "batch entry must be an object"),
          );
          continue;
        }
        const out = handleRpc(entry as JsonRpcRequest, db);
        if (out) responses.push(out);
      }
      res.status(200).json(responses);
      return;
    }

    if (!body || typeof body !== "object") {
      res
        .status(200)
        .json(rpcError(null, PARSE_ERROR, "request body must be a JSON-RPC object"));
      return;
    }

    const out = handleRpc(body as JsonRpcRequest, db);
    if (out === null) {
      res.status(204).end();
      return;
    }
    res.status(200).json(out);
  });

  return router;
}
