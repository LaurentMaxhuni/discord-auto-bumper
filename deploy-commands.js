import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder, ChannelType } from 'discord.js';

const { DISCORD_BOT_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_BOT_TOKEN || !CLIENT_ID) {
  console.error('Missing env: DISCORD_BOT_TOKEN / CLIENT_ID');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('bump')
    .setDescription('Trigger the Disboard bump command in a channel.')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Channel to trigger the Disboard bump command in.')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

(async () => {
  try {
    if (GUILD_ID) {
      const data = await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        { body: commands }
      );
      console.log(`Registered ${data.length} command(s) to guild ${GUILD_ID}`);
    } else {
      const data = await rest.put(
        Routes.applicationCommands(CLIENT_ID),
        { body: commands }
      );
      console.log(`Registered ${data.length} global command(s)`);
      console.log('Global commands may take up to 1 hour to appear.');
    }
  } catch (err) {
    console.error('Deploy failed:', err);
    process.exit(1);
  }
})();
