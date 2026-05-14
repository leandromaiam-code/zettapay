/**
 * MCP server exposing zettapay.pay and zettapay.status tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ZettaPay } from "@zettapay/sdk";

const zp = new ZettaPay({ apiKey: process.env.ZETTAPAY_API_KEY ?? "" });

const server = new Server(
  { name: "zettapay", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "zettapay.pay",
      description: "Create a USDC payment intent and return the payment URL.",
      inputSchema: {
        type: "object",
        required: ["amount", "recipient"],
        properties: {
          amount: { type: "string", description: "Amount in USDC, decimal string." },
          recipient: { type: "string", description: "Recipient public key (base58)." },
          memo: { type: "string" },
        },
      },
    },
    {
      name: "zettapay.status",
      description: "Check the status of a previously created payment.",
      inputSchema: {
        type: "object",
        required: ["reference"],
        properties: { reference: { type: "string" } },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  if (request.params.name === "zettapay.pay") {
    const intent = await zp.payments.create({
      amount: String(args.amount),
      currency: "USDC",
      recipient: String(args.recipient),
      metadata: args.memo ? { memo: String(args.memo) } : {},
      idempotencyKey: `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    return {
      content: [
        { type: "text", text: `Payment created. URL: ${intent.paymentUrl}\nReference: ${intent.reference}` },
      ],
    };
  }
  if (request.params.name === "zettapay.status") {
    const payment = await zp.payments.retrieve(String(args.reference));
    return {
      content: [{ type: "text", text: `Status: ${payment.status}` }],
    };
  }
  throw new Error(`unknown tool: ${request.params.name}`);
});

await server.connect(new StdioServerTransport());
