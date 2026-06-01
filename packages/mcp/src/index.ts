#!/usr/bin/env node
// @zettapay/mcp — a Model Context Protocol server that lets an AI agent accept
// crypto through the user's OWN self-hosted ZettaPay listener. It is fully
// non-custodial: every tool call is just an HTTP request to the local listener
// (default http://localhost:8787). This process never holds a key or any funds.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

const LISTENER_URL = (process.env.LISTENER_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const API_KEY = process.env.ZETTAPAY_API_KEY;

const SUPPORTED_ASSETS = [
  { id: 'btc', chain: 'btc', label: 'Bitcoin (on-chain, BIP-84)', amount_field: 'amount_sats' },
  { id: 'usdc-base', chain: 'base', asset: 'usdc', label: 'USDC on Base', amount_field: 'amount_usd' },
  { id: 'usdt-base', chain: 'base', asset: 'usdt', label: 'USDT on Base', amount_field: 'amount_usd' },
] as const;

const TOOLS: Tool[] = [
  {
    name: 'create_invoice',
    description:
      'Create a payment invoice on the local ZettaPay listener and return the receive address plus a payment/QR URI. ' +
      'For Bitcoin pass amount_sats. For USDC/USDT on Base pass chain="base" and amount_usd (asset defaults to usdc, pass "usdt" for USDT). ' +
      'Funds settle straight to the merchant wallet — non-custodial.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', enum: ['btc', 'base'], default: 'btc', description: 'Settlement chain. Defaults to btc.' },
        amount_sats: { type: 'integer', minimum: 1, description: 'Bitcoin amount in satoshis (required when chain is btc).' },
        amount_usd: { type: 'number', exclusiveMinimum: 0, description: 'USD amount (required when chain is base).' },
        asset: { type: 'string', enum: ['usdc', 'usdt'], description: 'Base stablecoin. Defaults to usdc.' },
        memo: { type: 'string', description: 'Optional label (Bitcoin only).' },
        expires_in: { type: 'integer', minimum: 1, description: 'Optional invoice TTL in seconds.' },
      },
    },
  },
  {
    name: 'get_invoice_status',
    description:
      'Look up an invoice on the local ZettaPay listener and return its status (pending | partial | confirmed | expired | failed), tx hash, and timestamps.',
    inputSchema: {
      type: 'object',
      required: ['invoice_id'],
      properties: {
        invoice_id: { type: 'string', description: 'The invoice id returned by create_invoice.' },
      },
    },
  },
  {
    name: 'list_supported_assets',
    description: 'List the assets the ZettaPay listener can accept: Bitcoin, USDC on Base, USDT on Base.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function listenerFetch(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (API_KEY) headers['x-zettapay-api-key'] = API_KEY;
  const res = await fetch(`${LISTENER_URL}${path}`, {
    method: init.method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* listener always replies JSON; tolerate an empty/garbled body */
  }
  return { status: res.status, json };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

async function createInvoice(args: Record<string, unknown>): Promise<CallToolResult> {
  const chain = typeof args.chain === 'string' ? args.chain.toLowerCase() : 'btc';
  const body: Record<string, unknown> = { chain };
  if (chain === 'btc') {
    if (!Number.isInteger(args.amount_sats) || (args.amount_sats as number) <= 0) {
      return fail('create_invoice: amount_sats (positive integer) is required for chain "btc".');
    }
    body.amount_sats = args.amount_sats;
    if (typeof args.memo === 'string') body.memo = args.memo;
  } else if (chain === 'base') {
    if (typeof args.amount_usd !== 'number' || !(args.amount_usd > 0)) {
      return fail('create_invoice: amount_usd (positive number) is required for chain "base".');
    }
    body.amount_usd = args.amount_usd;
    if (typeof args.asset === 'string') body.asset = args.asset.toLowerCase();
  } else {
    return fail(`create_invoice: unsupported chain "${chain}". Use "btc" or "base".`);
  }
  if (Number.isInteger(args.expires_in) && (args.expires_in as number) > 0) {
    body.expires_in = args.expires_in;
  }
  const { status, json } = await listenerFetch('/invoice', { method: 'POST', body });
  if (status !== 201) {
    const err = asRecord(asRecord(json).error);
    return fail(`Listener returned ${status}: ${String(err.message ?? err.code ?? 'create failed')}`);
  }
  return ok(json);
}

async function getInvoiceStatus(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = typeof args.invoice_id === 'string' ? args.invoice_id.trim() : '';
  if (!id) return fail('get_invoice_status: invoice_id is required.');
  const { status, json } = await listenerFetch(`/invoice/${encodeURIComponent(id)}`, { method: 'GET' });
  if (status === 404) return fail(`No invoice with id "${id}".`);
  if (status !== 200) {
    const err = asRecord(asRecord(json).error);
    return fail(`Listener returned ${status}: ${String(err.message ?? err.code ?? 'lookup failed')}`);
  }
  return ok(json);
}

const server = new Server(
  { name: '@zettapay/mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = asRecord(req.params.arguments);
  try {
    switch (req.params.name) {
      case 'create_invoice':
        return await createInvoice(args);
      case 'get_invoice_status':
        return await getInvoiceStatus(args);
      case 'list_supported_assets':
        return ok({ assets: SUPPORTED_ASSETS, listener_url: LISTENER_URL });
      default:
        return fail(`Unknown tool: ${req.params.name}`);
    }
  } catch (e) {
    return fail(`Could not reach the ZettaPay listener at ${LISTENER_URL}: ${(e as Error).message}`);
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Logs go to stderr so they never corrupt the stdio JSON-RPC stream.
  console.error(`zettapay-mcp connected — listener ${LISTENER_URL}`);
}

main().catch((e) => {
  console.error('zettapay-mcp failed to start:', e);
  process.exit(1);
});
