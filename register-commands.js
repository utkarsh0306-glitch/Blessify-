// Registers slash commands globally.
// Run automatically by Render build step (npm run deploy:cmds).

import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('setwisheschannel')
    .setDescription('Select the channel where daily festival wishes should be posted')
    .addChannelOption(o =>
      o.setName('channel')
       .setDescription('Target text channel')
       .setRequired(true)
    ).toJSON(),

  new SlashCommandBuilder()
    .setName('setreligions')
    .setDescription('Restrict posts to religions (comma-separated)')
    .addStringOption(o =>
      o.setName('list')
       .setDescription('hindu,muslim,christian')
       .setRequired(true)
    ).toJSON(),

  new SlashCommandBuilder()
    .setName('setmention')
    .setDescription('Mention style to prepend to the post')
    .addStringOption(o =>
      o.setName('mention')
       .setDescription('everyone | here | none')
       .setRequired(true)
    ).toJSON(),

  new SlashCommandBuilder()
    .setName('setmajor')
    .setDescription('Toggle major-festivals-only filter')
    .addBooleanOption(o =>
      o.setName('major_only')
       .setDescription('true = only major festivals; false = include all')
       .setRequired(true)
    ).toJSON()
];

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

(async () => {
  try {
    const app = await rest.get(Routes.oauth2CurrentApplication());
    await rest.put(Routes.applicationCommands(app.id), { body: commands });
    console.log('✅ Slash commands registered globally.');
  } catch (e) {
    console.error('❌ Command registration failed:', e);
  }
})();
