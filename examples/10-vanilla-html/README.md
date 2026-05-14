# 10 · Vanilla HTML drop-in

Zero build, zero framework. One static HTML file with a "Pay with USDC" button. Drop it on any static host (Cloudflare Pages, GitHub Pages, S3) and you're done.

Use this when you want to A/B test crypto checkout on a landing page without touching your stack.

## Run locally

```bash
npx serve .
```

Or just open `index.html` directly.

## File

- `index.html` — 40 lines total. Reads merchant id from a `<meta>` tag.
