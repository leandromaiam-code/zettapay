import { REST, Routes } from 'discord.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { buildRoleCommand } from './roles.js';

async function main(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(env.token);
  const body = [buildRoleCommand().toJSON()];

  logger.info(
    { guild: env.guildId, count: body.length },
    'registering guild slash commands',
  );

  await rest.put(
    Routes.applicationGuildCommands(env.clientId, env.guildId),
    { body },
  );

  logger.info('slash commands registered');
}

main().catch((err: unknown) => {
  logger.error({ err }, 'failed to register slash commands');
  process.exit(1);
});
