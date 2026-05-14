# 07 · MCP Server

A Model Context Protocol server that exposes `zettapay.pay` as a tool to any
MCP-compatible LLM client. The LLM calls the tool with `{ amount, recipient,
currency }`; the server returns a payment URL and reference. Tool result
includes a polling token so the agent knows when settlement happens.

## Flow

```
llm host ──tool call zettapay.pay──▶ this mcp server
this mcp server ──sdk.payments.create──▶ zettapay api
this mcp server ◀── { paymentUrl, reference }
this mcp server returns tool result with reference
llm host ──tool call zettapay.status(reference)──▶ this mcp server
this mcp server ──sdk.payments.retrieve──▶ zettapay api
```

## Run

```bash
npm i @modelcontextprotocol/sdk @zettapay/sdk
ZETTAPAY_API_KEY=zp_live_... npx tsx server.ts
```

Add to your MCP client config (e.g. Claude Code):

```json
{
  "mcpServers": {
    "zettapay": {
      "command": "npx",
      "args": ["tsx", "/abs/path/to/server.ts"],
      "env": { "ZETTAPAY_API_KEY": "zp_live_..." }
    }
  }
}
```

## Why this matters

MCP is the de-facto tool protocol for serious agent frameworks. Exposing
`zettapay.pay` as a tool means any host that speaks MCP gets payment
capability with no per-host integration code.
