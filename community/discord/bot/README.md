# `@zettapay/discord-bot`

Welcome + self-assignable role bot for the ZettaPay Discord server.

This package is intentionally **outside** the npm workspaces in the root
`package.json`. It ships independently, runs on a small VM (or Fly machine /
Railway service), and does not need to participate in the API/SDK build.

## What it does

| Event | Action |
| --- | --- |
| `guildMemberAdd` (new member joins) | Auto-assigns the `Member` role and posts a welcome embed in `#welcome` |
| `/role <Merchant\|Agent Builder\|Developer>` | Toggles the requested role on the invoking member, with allow-list validation |

The bot **only** assigns roles listed in `DISCORD_SELF_ASSIGNABLE_ROLES` —
even if a malicious option were sent, the allow-list check on the server
side blocks it.

## Setup

```bash
cd community/discord/bot
cp .env.example .env
# Fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID,
# DISCORD_WELCOME_CHANNEL_ID
npm install
npm run register   # publishes the /role slash command
npm run build
npm start
```

For local development with auto-reload:

```bash
npm run dev
```

## Required Discord permissions

When generating the bot invite link, request:

- **Scopes:** `bot`, `applications.commands`
- **Permissions:**
  - `View Channels`
  - `Send Messages`
  - `Embed Links`
  - `Manage Roles` (required to grant `Member` and self-assignable roles)
  - `Use Application Commands`

In the bot tab of the Discord developer portal, enable:

- `Server Members Intent` (required for `guildMemberAdd`)

## Hierarchy requirement

Discord enforces that a bot can only manage roles **below** its own role in
the role list. After inviting the bot, drag its automatic role above
`Member`, `Merchant`, `Agent Builder`, and `Developer` in **Server Settings →
Roles**. The bot logs and refuses with a friendly message if the hierarchy
is wrong.

## Operations

- **Logs:** structured JSON via pino. Pipe to your log aggregator of choice.
- **Restart on token rotation.** The bot exits if `DISCORD_TOKEN` is missing
  or invalid; supervise it with `systemd`, `pm2`, or your container runtime.
- **No persistence required.** All state lives in Discord (role membership);
  the bot is fully stateless.
