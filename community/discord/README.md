# ZettaPay Discord — Server Setup

Canonical layout for the **ZettaPay community Discord server**. The structure
below is declared in [`server-config.json`](./server-config.json) so it can be
recreated, audited, or migrated mechanically.

## Why this exists

DevRel + open SDK is canon (see `VISION.md` premissa 25). The Discord server
is one of the primary surfaces where merchants, agent builders, and SDK users
get unblocked. This directory ships:

1. The declarative server layout (`server-config.json`)
2. A bot that handles **welcome messages** and **self-assignable roles**
   (`bot/`)
3. Operator runbook for re-creating the server from scratch

## Channel layout

| Category | Channel | Purpose |
| --- | --- | --- |
| Information | `#welcome` | Landing channel — `/role` picker lives here |
| Information | `#announcements` | Releases, mainnet milestones, audits |
| Information | `#rules` | Server rules (read-only) |
| Information | `#status` | Mirror of `status.zettapay.io` incidents |
| Community | `#general` | Open chat |
| Community | `#help` | Integration support — RPC, USDC mint, x402, webhooks |
| Community | `#showcase` | Builds powered by `@zettapay/sdk` or x402 |
| Community | `#feedback` | Product feedback + DX papercuts |
| Developers | `#api` | REST + SDK questions |
| Developers | `#x402` | x402 agent payment protocol |
| Developers | `#mcp` | MCP tool exposure for AI agents |
| Developers | `#webhooks` | Webhook signing, retries, idempotency |
| Developers | `#on-chain` | Solana program, Anchor, IDL |
| Developers | `#github` | GitHub PR/issue mirror (read-only) |
| Agent Builders | `#agents-general` | Agent-economy chatter |
| Agent Builders | `#marketplace` | Z20 AI Agent Marketplace listings |
| Voice | `Office Hours` | Weekly core-team voice |
| Voice | `Pair Programming` | Ad-hoc pairing |

## Roles

| Role | Source | Notes |
| --- | --- | --- |
| Founder | manual | `ADMINISTRATOR` |
| Core Team | manual | Mods + repo maintainers |
| Moderator | manual | Trusted community mods |
| Contributor | github-link bot (future) | Awarded on merged PR |
| Merchant | self-assign via `/role` | Businesses accepting USDC |
| Agent Builder | self-assign via `/role` | Building x402/MCP agents |
| Developer | self-assign via `/role` | SDK / REST API users |
| Member | auto-assigned by welcome bot | Default for all joiners |

Self-assignable roles are limited to `Merchant`, `Agent Builder`, `Developer`
— see `selfAssignableRoles` in `server-config.json`.

## Operator runbook

Creating the server:

1. **Create the Discord server** (manually, in the Discord client) named
   `ZettaPay`. Use `docs/logo/symbol-light.png` as the icon.
2. **Create the categories and channels** matching `server-config.json`.
   We deliberately do not automate this step — Discord requires elevated
   permissions and the layout rarely changes. Use the JSON as a checklist.
3. **Create the roles** in the order listed (highest-priority first).
   `Member` should sit *below* the bot's role so the bot can grant it.
4. **Create a bot application** at <https://discord.com/developers/applications>
   with these intents:
   - `Server Members Intent` (required for `guildMemberAdd`)
   - `Message Content Intent` (only if you later add a moderation bot)
5. **Invite the bot** with the permissions calculator URL — minimum scopes:
   `bot` + `applications.commands`, permissions: `Manage Roles`, `Send Messages`,
   `View Channels`, `Use Slash Commands`.
6. **Configure `.env`** in `bot/.env` (see `bot/.env.example`).
7. **Start the bot**: `cd bot && npm install && npm run register && npm start`.

The bot will:

- Send the welcome embed in `#welcome` for every new member
- Auto-assign the `Member` role on join
- Expose the `/role` slash command for self-assignment of `Merchant`,
  `Agent Builder`, and `Developer`

## Security

- **No bot token in code.** Always via `DISCORD_TOKEN` env var.
- **Bot operates under least privilege.** It has `MANAGE_ROLES` only because
  it needs to grant `Member` and the self-assignable roles. It does not have
  `MANAGE_CHANNELS` or `ADMINISTRATOR`.
- **Self-assignable roles are explicitly listed.** The bot refuses any role
  not in `selfAssignableRoles`, even if it's lower than the bot's role.
- **Mods will never DM first.** Stated in the rules and pinned in `#welcome`.

## Future bots (out of scope for Z19.1)

- GitHub-Discord link bot → posts PRs/issues to `#github`, awards `Contributor`
  on merged PR
- Status mirror → posts `status.zettapay.io` incidents to `#status`
- Help triage → routes `#help` threads with no reply for 24h to Core Team
