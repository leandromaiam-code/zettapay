# 06 · Discord Tip Bot

A Discord bot that lets community members tip each other in USDC. The bot
never holds funds — each tip creates a ZettaPay payment intent and DMs the
tipper a payment link. On confirmation, the bot posts a public ack in the
channel.

## Flow

```
user: /tip @alice 5 great talk!
bot ──sdk.payments.create──▶ zettapay api
bot DMs tipper the payment URL (open in browser, scan QR, pay)
zettapay webhook ──▶ bot
bot posts "@user tipped @alice 5 USDC — gm"
```

## Run

```bash
npm i discord.js @zettapay/sdk express
DISCORD_TOKEN=... ZETTAPAY_API_KEY=zp_live_... npx tsx bot.ts
```

Register the `/tip` slash command via the Discord Developer Portal.

## Why this matters

Community + creator tipping is the wedge that gets normies their first
on-chain transfer. The whole flow is two messages and zero wallet
installs (recipient supplies pubkey once via `/setpaymentaddress`).
