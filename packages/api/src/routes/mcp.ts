import { Router, type Request, type Response } from 'express';
import { parseX402Payment, X402ValidationError } from '../x402.js';
import type { MerchantRepository } from '../repository.js';
import type { PaymentLog } from '../payments.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'zettapay-mcp';
const SERVER_VERSION = '0.1.0';
const JSONRPC_VERSION = '2.0';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'pay',
    description:
      'Submit an X-402 Solana payment. Accepts a base64-encoded signed transaction and returns the parsed payment metadata once signatures are verified.',
    inputSchema: {
      type: 'object',
      properties: {
        payment: {
          type: 'string',
          description:
            'Base64-encoded signed Solana transaction (legacy or v0). Maximum 1232 bytes decoded.',
          minLength: 1,
        },
      },
      required: ['payment'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_merchant',
    description:
      'Fetch a merchant by numeric id. Returns the merchant record (name, wallet pubkey, USDC ATA, created_at) or an error if not found.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'integer',
          minimum: 1,
          description: 'Merchant primary key',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_payments',
    description:
      'List recently accepted X-402 payments in reverse chronological order. Returns payment metadata recorded by the /pay endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          default: 50,
          description: 'Maximum number of payments to return',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          default: 0,
          description: 'Number of payments to skip',
        },
      },
      additionalProperties: false,
    },
  },
];

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  const error: JsonRpcError['error'] = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

function rpcSuccess(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function textContent(payload: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function toolError(message: string, code?: string) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code: code ?? 'tool_error', message } }) }],
    isError: true,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export interface McpDependencies {
  merchants: MerchantRepository;
  payments: PaymentLog;
}

interface ToolContext {
  merchants: MerchantRepository;
  payments: PaymentLog;
}

function callPay(args: Record<string, unknown>, ctx: ToolContext) {
  const payment = args.payment;
  if (typeof payment !== 'string' || payment.length === 0) {
    return toolError('payment must be a non-empty base64 string', 'invalid_arguments');
  }
  try {
    const parsed = parseX402Payment(payment);
    const record = ctx.payments.record({
      feePayer: parsed.feePayer,
      signers: parsed.signers,
      signatures: parsed.signatures,
      recentBlockhash: parsed.recentBlockhash,
      isVersioned: parsed.isVersioned,
      version: parsed.version,
      transactionBytes: parsed.rawTransaction.length,
    });
    return textContent({
      accepted: true,
      paymentId: record.id,
      feePayer: parsed.feePayer,
      signers: parsed.signers,
      signatureCount: parsed.signatures.length,
      recentBlockhash: parsed.recentBlockhash,
      isVersioned: parsed.isVersioned,
      version: parsed.version,
      transactionBytes: parsed.rawTransaction.length,
    });
  } catch (err) {
    if (err instanceof X402ValidationError) {
      return toolError(err.message, err.code);
    }
    const message = err instanceof Error ? err.message : 'failed to parse payment';
    return toolError(message, 'pay_failed');
  }
}

function callGetMerchant(args: Record<string, unknown>, ctx: ToolContext) {
  const id = args.id;
  if (!isPositiveInteger(id)) {
    return toolError('id must be a positive integer', 'invalid_arguments');
  }
  const merchant = ctx.merchants.findById(id);
  if (!merchant) {
    return toolError(`merchant ${id} not found`, 'not_found');
  }
  return textContent(merchant);
}

function callListPayments(args: Record<string, unknown>, ctx: ToolContext) {
  const limit = args.limit;
  const offset = args.offset;
  if (limit !== undefined && (!isPositiveInteger(limit) || limit > 200)) {
    return toolError('limit must be an integer between 1 and 200', 'invalid_arguments');
  }
  if (offset !== undefined && !isNonNegativeInteger(offset)) {
    return toolError('offset must be a non-negative integer', 'invalid_arguments');
  }
  const items = ctx.payments.list({
    limit: typeof limit === 'number' ? limit : undefined,
    offset: typeof offset === 'number' ? offset : undefined,
  });
  return textContent({ items, count: items.length });
}

function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): { ok: true; result: unknown } | { ok: false; code: number; message: string } {
  switch (name) {
    case 'pay':
      return { ok: true, result: callPay(args, ctx) };
    case 'get_merchant':
      return { ok: true, result: callGetMerchant(args, ctx) };
    case 'list_payments':
      return { ok: true, result: callListPayments(args, ctx) };
    default:
      return { ok: false, code: METHOD_NOT_FOUND, message: `unknown tool: ${name}` };
  }
}

function handleRpc(req: JsonRpcRequest, ctx: ToolContext): JsonRpcResponse | null {
  const rawId = req.id;
  const id =
    typeof rawId === 'string' || typeof rawId === 'number' || rawId === null ? rawId : null;
  const isNotification = rawId === undefined;

  if (req.jsonrpc !== JSONRPC_VERSION) {
    return isNotification ? null : rpcError(id, INVALID_REQUEST, 'jsonrpc must be "2.0"');
  }
  if (typeof req.method !== 'string') {
    return isNotification ? null : rpcError(id, INVALID_REQUEST, 'method must be a string');
  }

  const params = asObject(req.params);

  switch (req.method) {
    case 'initialize': {
      const result = {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      };
      return isNotification ? null : rpcSuccess(id, result);
    }
    case 'notifications/initialized':
    case 'initialized':
      return null;
    case 'ping':
      return isNotification ? null : rpcSuccess(id, {});
    case 'tools/list': {
      const tools = MCP_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      return isNotification ? null : rpcSuccess(id, { tools });
    }
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string') {
        return isNotification
          ? null
          : rpcError(id, INVALID_PARAMS, 'params.name must be a string');
      }
      const args = asObject(params.arguments);
      const dispatched = dispatchToolCall(name, args, ctx);
      if (!dispatched.ok) {
        return isNotification ? null : rpcError(id, dispatched.code, dispatched.message);
      }
      return isNotification ? null : rpcSuccess(id, dispatched.result);
    }
    default:
      return isNotification
        ? null
        : rpcError(id, METHOD_NOT_FOUND, `method not found: ${req.method}`);
  }
}

export function buildMcpRouter(deps: McpDependencies): Router {
  const router = Router();
  const ctx: ToolContext = { merchants: deps.merchants, payments: deps.payments };

  router.get('/', (_req: Request, res: Response) => {
    res.json({
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: { listChanged: false } },
      tools: MCP_TOOLS,
    });
  });

  router.post('/', (req: Request, res: Response) => {
    const body = req.body as unknown;

    if (Array.isArray(body)) {
      if (body.length === 0) {
        res.status(200).json(rpcError(null, INVALID_REQUEST, 'batch must not be empty'));
        return;
      }
      const responses: JsonRpcResponse[] = [];
      for (const entry of body) {
        if (!entry || typeof entry !== 'object') {
          responses.push(rpcError(null, INVALID_REQUEST, 'batch entry must be an object'));
          continue;
        }
        const out = handleRpc(entry as JsonRpcRequest, ctx);
        if (out) responses.push(out);
      }
      res.status(200).json(responses);
      return;
    }

    if (!body || typeof body !== 'object') {
      res.status(200).json(rpcError(null, PARSE_ERROR, 'request body must be a JSON-RPC object'));
      return;
    }

    const out = handleRpc(body as JsonRpcRequest, ctx);
    if (out === null) {
      res.status(204).end();
      return;
    }
    res.status(200).json(out);
  });

  return router;
}
