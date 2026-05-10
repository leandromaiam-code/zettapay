import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { registerWelcomeHandler } from './welcome.js';
import { registerRoleHandler } from './roles.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.GuildMember, Partials.User],
});

client.once('ready', (c) => {
  logger.info(
    { user: c.user.tag, guilds: c.guilds.cache.size, watching: env.guildId },
    'discord bot online',
  );
});

client.on('error', (err) => {
  logger.error({ err }, 'discord client error');
});

registerWelcomeHandler(client);
registerRoleHandler(client);

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  client
    .destroy()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(env.token).catch((err: unknown) => {
  logger.error({ err }, 'discord login failed');
  process.exit(1);
});
