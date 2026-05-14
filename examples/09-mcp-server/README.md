# 09 · MCP server — ZettaPay as agent tools

Exposes ZettaPay operations as MCP tools so any MCP-aware agent (Claude Desktop, Cursor, custom clients) can take payment actions.

Tools registered:

- `zettapay.create_intent` · creates a payment intent.
- `zettapay.check_intent` · returns intent status.
- `zettapay.list_payments` · lists recent payments for the merchant.

## Run

```bash
cp .env.example .env
npm install
npm start
```

Then point your MCP client at this server (`stdio` transport).

Example `claude_desktop_config.json` entry:

```json
{
  "mcpServers": {
    "zettapay": {
      "command": "node",
      "args": ["/absolute/path/to/examples/09-mcp-server/server.mjs"],
      "env": { "ZETTAPAY_API_KEY": "zk_devnet_..." }
    }
  }
}
```

## Files

- `server.mjs` — MCP stdio server with three tools.
