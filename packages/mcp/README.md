# @zettapay/mcp

> **Accept crypto from an AI agent in one tool call — non-custodial, self-hosted.**

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an
AI agent (Claude Desktop, Claude Code, or any MCP client) create and track
crypto invoices through **your own** [ZettaPay listener](https://www.npmjs.com/package/@zettapay/listener).

It runs on your machine and talks only to your local listener
(`http://localhost:8787` by default). It never holds a key, never holds funds,
and never phones home. Payments settle straight to your wallet on-chain.

## What it does

Three tools, mapped 1:1 onto the listener's HTTP API:

| Tool | Does |
| --- | --- |
| `create_invoice` | Create a BTC or USDC/USDT-on-Base invoice; returns the receive address + payment/QR URI. |
| `get_invoice_status` | Poll an invoice: `pending \| partial \| confirmed \| expired \| failed`. |
| `list_supported_assets` | List what the listener accepts: `btc`, `usdc-base`, `usdt-base`. |

## Prerequisites

1. A running ZettaPay listener you control:
   ```bash
   npm i -g @zettapay/listener
   zettapay-listener start
   ```
2. Node.js >= 18.18.

## Configure

The server reads two environment variables:

| Var | Default | Notes |
| --- | --- | --- |
| `LISTENER_URL` | `http://localhost:8787` | Your local listener's base URL. |
| `ZETTAPAY_API_KEY` | _(none)_ | Sent as `X-ZettaPay-Api-Key` when your listener requires auth. |

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zettapay": {
      "command": "npx",
      "args": ["-y", "@zettapay/mcp"],
      "env": {
        "LISTENER_URL": "http://localhost:8787",
        "ZETTAPAY_API_KEY": "sk_live_..."
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add zettapay -- npx -y @zettapay/mcp
```

(Set `LISTENER_URL` / `ZETTAPAY_API_KEY` in the environment, or via your client's
MCP env config.)

### Any MCP client (stdio)

```bash
LISTENER_URL=http://localhost:8787 ZETTAPAY_API_KEY=sk_live_... npx -y @zettapay/mcp
```

The server speaks MCP over stdio. Diagnostic logs go to stderr so they never
corrupt the JSON-RPC stream.

## Example agent flow

> "Create a $42 USDC invoice on Base and give me the address."

The agent calls `create_invoice({ chain: "base", amount_usd: 42 })` and gets back
the receive address, the exact amount, and an EIP-681 payment URI — then it can
poll `get_invoice_status({ invoice_id })` until the status flips to `confirmed`.

## Non-custodial by construction

This package is a thin client for **your** listener. The agent never sees a
private key or an xpub; it only ever receives a public receive address. All
custody guarantees of the listener hold unchanged — ZettaPay never touches your
money. No identity checks, no telemetry, no third party.

## License

MIT
