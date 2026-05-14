# 08 · React Widget

A single-page React app that mounts the `@zettapay/embed` widget into a
container. The widget renders a Solana Pay QR + copyable address and polls
for confirmation. No wallet adapter, no `useWallet`, no connect modal.

## Flow

```
react app loads → <ZettaPayEmbed amount="9.99" reference="..." />
embed widget renders QR + address
embed widget polls /payments/<reference>/status
embed widget fires onPaid({ signature }) on confirmation
```

## Run

```bash
npm create vite@latest my-app -- --template react-ts
cp App.tsx my-app/src/App.tsx
cd my-app
npm i @zettapay/embed
npm run dev
```

## Why this matters

Drop a `<script>` tag or a single React component on any existing page and
ship USDC checkout. This is what most merchants will actually integrate.
