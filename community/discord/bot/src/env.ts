import { exit } from 'node:process';

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(`[zettapay-discord] Missing required env var: ${name}`);
    exit(1);
  }
  return value.trim();
}

function optional(name: string, fallback = ''): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

function csv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const env = {
  token: required('DISCORD_TOKEN'),
  clientId: required('DISCORD_CLIENT_ID'),
  guildId: required('DISCORD_GUILD_ID'),
  welcomeChannelId: optional('DISCORD_WELCOME_CHANNEL_ID'),
  defaultRole: optional('DISCORD_DEFAULT_ROLE', 'Member'),
  selfAssignableRoles: csv(
    optional('DISCORD_SELF_ASSIGNABLE_ROLES', 'Merchant,Agent Builder,Developer'),
  ),
  logLevel: optional('LOG_LEVEL', 'info'),
} as const;
