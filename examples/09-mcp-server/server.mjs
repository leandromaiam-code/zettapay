#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const apiKey = process.env.ZETTAPAY_API_KEY;
const apiBase = process.env.ZETTAPAY_API_BASE ?? "https://api.zettapay.dev";
if (!apiKey) {
  console.error("Missing ZETTAPAY_API_KEY.");
  process.exit(1);
}

const server = new Server(
  { name: "zettapay-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const tools = [
  {
    name: "zettapay.create_intent",
    description: "Create a payment intent. Returns id, solana: URI, recipient address.",
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "string" },
        currency: { type: "string", default: "USDC" },
        reference: { type: "string" },
      },
      required: ["amount"],
    },
  },
  {
    name: "zettapay.check_intent",
    description: "Look up the current status of a payment intent.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "zettapay.list_payments",
    description: "List the merchant's recent payments.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", default: 10 } },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

async function call(method, path, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(method === "POST" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  let result;
  if (name === "zettapay.create_intent") {
    result = await call("POST", "/v1/pay/create", {
      amount: args.amount,
      currency: args.currency ?? "USDC",
      chain: "solana",
      reference: args.reference ?? `mcp-${Date.now()}`,
    });
  } else if (name === "zettapay.check_intent") {
    result = await call("GET", `/v1/pay/${args.id}`);
  } else if (name === "zettapay.list_payments") {
    result = await call("GET", `/v1/payments?limit=${args.limit ?? 10}`);
  } else {
    throw new Error(`unknown tool: ${name}`);
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

await server.connect(new StdioServerTransport());
