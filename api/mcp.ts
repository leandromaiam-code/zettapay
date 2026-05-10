import type { VercelRequest, VercelResponse } from '@vercel/node';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'zettapay-mcp';
const SERVER_VERSION = '0.1.0';
const JSONRPC_VERSION = '2.0';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;

const TOOLS = [
  {
    name: 'pay',
    description:
      'Submit an X-402 Solana payment. Accepts a base64-encoded signed transaction and returns the parsed payment metadata once signatures are verified.',
    inputSchema: {
      type: 'object',
      properties: {
        payment: {
          type: 'string',
          description: 'Base64-encoded signed Solana transaction (legacy or v0). Max 1232 bytes decoded.',
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
      'Fetch a merchant by id. Returns the merchant record (name, wallet pubkey, USDC ATA, created_at).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1, description: 'Merchant primary key' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_payments',
    description: 'List recently accepted X-402 payments in reverse chronological order.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_onramp_url',
    description:
      'Build a MoonPay onramp URL for a merchant. The destination wallet is the merchant USDC ATA recorded at onboarding.',
    inputSchema: {
      type: 'object',
      properties: {
        merchantId: { type: 'integer', minimum: 1 },
        currencyCode: { type: 'string' },
        baseCurrencyCode: { type: 'string' },
        baseCurrencyAmount: { type: 'number', exclusiveMinimum: 0 },
        redirectURL: { type: 'string' },
        externalCustomerId: { type: 'string' },
        externalTransactionId: { type: 'string' },
      },
      required: ['merchantId'],
      additionalProperties: false,
    },
  },
];

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

function rpcSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcError {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

function handleRpc(req: JsonRpcRequest): JsonRpcResponse | null {
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

  switch (req.method) {
    case 'initialize':
      return isNotification
        ? null
        : rpcSuccess(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          });
    case 'notifications/initialized':
    case 'initialized':
      return null;
    case 'ping':
      return isNotification ? null : rpcSuccess(id, {});
    case 'tools/list':
      return isNotification ? null : rpcSuccess(id, { tools: TOOLS });
    case 'tools/call':
      return isNotification
        ? null
        : rpcError(
            id,
            METHOD_NOT_FOUND,
            'tools/call requires the stateful MCP backend. Configure ZETTAPAY_API_BASE_URL or use @zettapay/sdk directly.',
          );
    default:
      return isNotification
        ? null
        : rpcError(id, METHOD_NOT_FOUND, `method not found: ${req.method}`);
  }
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json({
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: { listChanged: false } },
      tools: TOOLS,
      transport: 'http+json-rpc',
      runtime: 'vercel-serverless',
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'POST or GET only' } });
    return;
  }

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
      const out = handleRpc(entry as JsonRpcRequest);
      if (out) responses.push(out);
    }
    res.status(200).json(responses);
    return;
  }

  if (!body || typeof body !== 'object') {
    res.status(200).json(rpcError(null, PARSE_ERROR, 'request body must be a JSON-RPC object'));
    return;
  }

  const out = handleRpc(body as JsonRpcRequest);
  if (out === null) {
    res.status(204).end();
    return;
  }
  res.status(200).json(out);
}
