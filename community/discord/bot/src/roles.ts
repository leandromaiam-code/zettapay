import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  type Client,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { env } from './env.js';
import { logger } from './logger.js';

export function buildRoleCommand(): SlashCommandBuilder {
  const choices = env.selfAssignableRoles.map((name) => ({ name, value: name }));
  const builder = new SlashCommandBuilder()
    .setName('role')
    .setDescription('Self-assign a role that describes how you use ZettaPay.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages);

  builder.addStringOption((opt) =>
    opt
      .setName('name')
      .setDescription('Role to toggle on yourself')
      .setRequired(true)
      .addChoices(...choices),
  );

  return builder;
}

export async function handleRoleCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const requested = interaction.options.getString('name', true);

  // Allow-list check — never trust the option value alone.
  if (!env.selfAssignableRoles.includes(requested)) {
    await interaction.reply({
      content: `\`${requested}\` is not self-assignable. Pick one of: ${env.selfAssignableRoles.join(', ')}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = interaction.member as GuildMember | null;
  const guild = interaction.guild;
  if (!member || !guild) {
    await interaction.reply({
      content: 'This command only works inside the ZettaPay server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const role = guild.roles.cache.find((r) => r.name === requested);
  if (!role) {
    await interaction.reply({
      content: `Role \`${requested}\` doesn't exist on this server. Ping a moderator.`,
      flags: MessageFlags.Ephemeral,
    });
    logger.warn({ requested }, 'self-assignable role missing on guild');
    return;
  }

  const me = guild.members.me;
  if (!me || me.roles.highest.comparePositionTo(role) <= 0) {
    await interaction.reply({
      content: `I can't assign \`${requested}\` — my role is below it in the hierarchy. Ping an admin to reorder roles.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const has = member.roles.cache.has(role.id);
  if (has) {
    await member.roles.remove(role, `self-removed via /role`);
    await interaction.reply({
      content: `Removed \`${role.name}\`.`,
      flags: MessageFlags.Ephemeral,
    });
    logger.info({ user: member.user.tag, role: role.name }, 'role removed');
    return;
  }

  await member.roles.add(role, `self-assigned via /role`);
  await interaction.reply({
    content: `You now have \`${role.name}\`.`,
    flags: MessageFlags.Ephemeral,
  });
  logger.info({ user: member.user.tag, role: role.name }, 'role assigned');
}

export function registerRoleHandler(client: Client): void {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'role') return;
    try {
      await handleRoleCommand(interaction);
    } catch (err) {
      logger.error({ err }, 'role command handler failed');
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({
            content: 'Something went wrong. The team has been notified.',
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => undefined);
      }
    }
  });
}
