# ZettaPay docs (Mintlify)

This directory hosts the public documentation site published at
[docs.zettapay.io](https://docs.zettapay.io). The site is rendered by
[Mintlify](https://mintlify.com), driven by `docs.json` and the MDX files
in this folder.

## Local preview

```bash
npm install --include=dev
npm run docs:dev
```

The script runs `mintlify dev` against this folder. The first run installs
the Mintlify CLI on demand. Hot-reload is enabled — edit any `.mdx` file
and the page reloads automatically at `http://localhost:3000`.

To validate links and broken references before pushing:

```bash
npm run docs:check
```

## Deployment

Mintlify ingests the `main` branch of the GitHub repository directly. Each
push that touches files inside `docs/` triggers a rebuild on Mintlify and
republishes `docs.zettapay.io`. There is no Vercel pipeline for the docs
site — production deploys are owned by Mintlify.

## Search (Algolia DocSearch)

The site is wired to Algolia DocSearch via `integrations.algolia` in
`docs.json`. Replace the placeholder credentials below with the real keys
once the DocSearch crawler is configured for `docs.zettapay.io`:

| Key | Where it lives |
| --- | --- |
| `appId` | `docs.json` → `integrations.algolia.appId` |
| `apiKey` | `docs.json` → `integrations.algolia.apiKey` (search-only public key) |
| `indexName` | `docs.json` → `integrations.algolia.indexName` |

The `apiKey` value is the **search-only** public key — never paste an
admin key into this file.

Mintlify ships its own built-in search as a fallback if Algolia is not
configured, so the site remains usable while DocSearch propagates.

## Theme

Royal blue identity (`#4F6BFF`) with light + dark themes. Default theme
follows the visitor's system preference. The dark/light toggle lives in
the Mintlify chrome and requires no additional configuration.

## File layout

```
docs/
├── docs.json            # Mintlify config (sidebar, theme, search, footer)
├── introduction.mdx
├── quickstart.mdx
├── concepts/            # Architecture, AI agents, webhooks, onramp
├── api-reference/       # HTTP API reference grouped by resource
├── sdk/                 # @zettapay/sdk TypeScript reference
├── guides/              # End-to-end how-tos
└── logo/                # Wordmark + symbol assets
```
