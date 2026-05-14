/**
 * Discord tip bot — wallet-less USDC tipping between community members.
 */

import { Client, Events, GatewayIntentBits } from "discord.js";
import { ZettaPay } from "@zettapay/sdk";
import express from "express";

const zp = new ZettaPay({ apiKey: process.env.ZETTAPAY_API_KEY ?? "" });
const recipientAddresses = new Map<string, string>();
const intentToTip = new Map<string, { tipper: string; recipient: string; channel: string; amount: string; note: string }>();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMessages],
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "setpaymentaddress") {
    const pubkey = interaction.options.getString("pubkey", true);
    recipientAddresses.set(interaction.user.id, pubkey);
    await interaction.reply({ content: `payment address saved`, ephemeral: true });
    return;
  }

  if (interaction.commandName === "tip") {
    const target = interaction.options.getUser("user", true);
    const amount = interaction.options.getNumber("amount", true);
    const note = interaction.options.getString("note") ?? "";
    const targetPubkey = recipientAddresses.get(target.id);
    if (!targetPubkey) {
      await interaction.reply({ content: `${target.username} hasn't set a payment address. Ask them to run /setpaymentaddress.`, ephemeral: true });
      return;
    }
    const intent = await zp.payments.create({
      amount: amount.toString(),
      currency: "USDC",
      recipient: targetPubkey,
      metadata: { tipper: interaction.user.id, recipient: target.id },
      idempotencyKey: `tip-${interaction.id}`,
    });
    intentToTip.set(intent.reference, {
      tipper: interaction.user.id,
      recipient: target.id,
      channel: interaction.channelId,
      amount: amount.toString(),
      note,
    });
    const dm = await interaction.user.createDM();
    await dm.send(`Open to complete your tip: ${intent.paymentUrl}`);
    await interaction.reply({ content: `Check your DMs to finish the tip`, ephemeral: true });
  }
});

const app = express();
app.use(express.json());
app.post("/webhook", async (req, res) => {
  const event = req.body as { type: string; data: { reference: string } };
  if (event.type === "payment.confirmed") {
    const tip = intentToTip.get(event.data.reference);
    if (tip) {
      const channel = await client.channels.fetch(tip.channel);
      if (channel?.isTextBased() && "send" in channel) {
        await channel.send(`<@${tip.tipper}> tipped <@${tip.recipient}> ${tip.amount} USDC ${tip.note ? `— ${tip.note}` : ""}`);
      }
      intentToTip.delete(event.data.reference);
    }
  }
  res.json({ ok: true });
});
app.listen(Number(process.env.PORT ?? 4001));

client.login(process.env.DISCORD_TOKEN);
