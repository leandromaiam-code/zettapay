import {
  EmbedBuilder,
  type GuildMember,
  type Client,
  type TextChannel,
} from 'discord.js';
import { env } from './env.js';
import { logger } from './logger.js';

const BRAND_BRASS = 0xd4a961;

export function buildWelcomeEmbed(member: GuildMember): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(BRAND_BRASS)
    .setTitle(`Welcome to ZettaPay, ${member.displayName}`)
    .setDescription(
      [
        'Solana USDC payments for humans and AI agents — 0.30% fees, instant settlement.',
        '',
        '**Get started**',
        '• Read the rules in <#rules>',
        '• Use `/role` to pick what describes you (Merchant / Agent Builder / Developer)',
        '• Ask in <#help> if you get stuck integrating',
        '• Show your build in <#showcase>',
        '',
        '[Docs](https://docs.zettapay.io) · [GitHub](https://github.com/leandromaiam-code/zettapay)',
      ].join('\n'),
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
    .setFooter({ text: 'ZettaPay · payments for the agentic economy' })
    .setTimestamp(new Date());
}

async function assignDefaultRole(member: GuildMember): Promise<void> {
  if (!env.defaultRole) return;
  const role = member.guild.roles.cache.find((r) => r.name === env.defaultRole);
  if (!role) {
    logger.warn(
      { roleName: env.defaultRole, guild: member.guild.id },
      'default role not found — skipping assignment',
    );
    return;
  }
  // Bot must have a higher role than the target role in the hierarchy.
  const me = member.guild.members.me;
  if (me && me.roles.highest.comparePositionTo(role) <= 0) {
    logger.error(
      { roleName: role.name },
      'bot role is not above target role — refusing to assign',
    );
    return;
  }
  if (member.roles.cache.has(role.id)) return;
  await member.roles.add(role, 'auto-assigned by welcome bot on join');
  logger.info({ user: member.user.tag, role: role.name }, 'assigned default role');
}

async function postWelcomeEmbed(
  client: Client,
  member: GuildMember,
): Promise<void> {
  const embed = buildWelcomeEmbed(member);
  if (env.welcomeChannelId) {
    const channel = await client.channels.fetch(env.welcomeChannelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      await (channel as TextChannel).send({ content: `<@${member.id}>`, embeds: [embed] });
      return;
    }
    logger.warn(
      { channelId: env.welcomeChannelId },
      'welcome channel not found or not text-based — falling back to DM',
    );
  }
  // Fallback: DM the member. Some users disable DMs from server members; swallow that.
  await member.send({ embeds: [embed] }).catch((err: unknown) => {
    logger.warn({ err, user: member.user.tag }, 'failed to DM welcome embed');
  });
}

export function registerWelcomeHandler(client: Client): void {
  client.on('guildMemberAdd', async (member) => {
    if (member.user.bot) return;
    if (member.guild.id !== env.guildId) return;
    try {
      await assignDefaultRole(member);
      await postWelcomeEmbed(client, member);
    } catch (err) {
      logger.error({ err, user: member.user.tag }, 'welcome handler failed');
    }
  });
}
