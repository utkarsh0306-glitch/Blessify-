// Festival AI Wish Bot — Gemini wishes + Pexels images (1:00 AM IST)
// - Detects today's India festivals via Calendarific
// - Generates unique Hinglish wishes (~300–400 chars) with Gemini
// - Fetches a festival image from Pexels
// - Posts to configured channel in every server at 01:00 IST
// - Per-guild settings via slash commands: channel / religions / @mention / major-only

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import cron from 'node-cron';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials
} from 'discord.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ---- Timezone setup: treat "today" in IST ----
dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = process.env.TIMEZONE || 'Asia/Kolkata';

// ---- API keys (required) ----
const BOT_TOKEN = process.env.BOT_TOKEN;
const CAL_KEY = process.env.CALENDARIFIC_KEY;
const GEMINI_KEY = process.env.GOOGLE_API_KEY;

// ---- Image provider: Pexels (you chose this) ----
const IMAGE_PROVIDER = (process.env.IMAGE_PROVIDER || 'pexels').toLowerCase();
const PEXELS_KEY = process.env.PEXELS_API_KEY;

// ---- Create Gemini client (for wish text) ----
const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

// ---- Discord client with minimal intents ----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

// ---- Simple JSON persistence (single worker) ----
const DATA_FILE = path.join(process.cwd(), 'guildConfigs.json');
let guildConfigs = {};
try {
  if (fs.existsSync(DATA_FILE)) {
    guildConfigs = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
} catch {
  guildConfigs = {};
}

function defaultsFor() {
  return {
    channelId: null,
    lang: 'hinglish',
    religions: ['hindu', 'muslim', 'christian'], // you requested only these 3
    mention: 'everyone', // 'everyone' | 'here' | 'none'
    majorOnly: true      // filter out small observances
  };
}
function saveConfigs() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(guildConfigs, null, 2), 'utf8');
}

// ---- Cache: reuse the same AI wish/image across guilds per day ----
const CACHE_FILE = path.join(process.cwd(), 'wishCache.json');
let wishCache = {};
try {
  if (fs.existsSync(CACHE_FILE)) {
    wishCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  }
} catch {
  wishCache = {};
}
const cacheKey = (dateISO, label) => `${dateISO}|${label}`;
const cacheGet = (k) => wishCache[k];
const cacheSet = (k, v) => {
  wishCache[k] = v;
  fs.writeFileSync(CACHE_FILE, JSON.stringify(wishCache, null, 2), 'utf8');
};

// ---- Heuristic: map festival name to faith ----
function classifyFaith(name) {
  const n = name.toLowerCase();
  if (/(diwali|deepavali|navratri|holi|ram navami|krishna|janmashtami|ganesh|chaturthi|mahashivratri|dussehra|vijayadashami|pongal|makar sankranti|onam|raksha bandhan|karva|karwa)/.test(n)) return 'hindu';
  if (/(eid|fitr|adha|ramadan|ramzan|milad|mawlid|ashura|muharram|shab-e-barat)/.test(n)) return 'muslim';
  if (/(christ|christmas|easter|good friday|palm sunday|epiphany)/.test(n)) return 'christian';
  return '';
}

// ---- Filter out smaller observances; keep "major" ones ----
function isMajorFestival(item) {
  const n = item.name.toLowerCase();
  const ALLOW = [
    // Hindu
    'diwali','deepavali','navratri','holi','dussehra','vijayadashami','janmashtami','krishna janmashtami','ram navami','ganesh chaturthi','maha shivaratri','mahashivratri','pongal','makar sankranti','onam','raksha bandhan','karva chauth','karwa chauth',
    // Muslim
    'eid al-fitr','eid-ul-fitr','eid al adha','eid-ul-adha','eid al-adha','eid-e-milad','milad-un-nabi','mawlid an-nabi','ashura','muharram','shab-e-barat',
    // Christian
    'christmas','good friday','easter','palm sunday'
  ];
  if (ALLOW.some(key => n.includes(key))) return true;

  const t = (item.type || []).join(' ').toLowerCase();
  const p = (item.primary_type || '').toLowerCase();
  if (p.includes('relig') && !t.includes('observance')) return true;
  if (t.includes('national holiday')) return true;

  return false; // conservative default
}

// ---- Gemini prompt to produce 300–400 char Hinglish wish ----
function aiWishPrompt({ festivalName, faith }) {
  return `You are a friendly Indian community bot writing short festival wishes.

Constraints:
- Language: Hinglish (simple Hindi + English).
- Length target: about 300–400 characters (one short paragraph).
- Tone: warm, inclusive, natural; not robotic; no proselytizing.
- Emojis: 1–3 total (e.g., 🪔🎉🌙🎄) placed naturally.
- Theme: celebrate ${festivalName}, wish peace, health, prosperity, unity.
- Audience: gaming/creator community, multi-faith, family-friendly.
- Output: plain text only.

Write a unique wish for "${festivalName}" (${faith || 'India, multi-faith'}).`;
}

// ---- Generate wish (AI first, else fallback), with per-day cache ----
async function makeAIWish(dateISO, name, faith) {
  const key = cacheKey(dateISO, `wish:${name}`);
  const cached = cacheGet(key);
  if (cached) return cached;

  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const result = await model.generateContent(aiWishPrompt({ festivalName: name, faith }));
      const text = result?.response?.text()?.trim();
      if (text && text.length >= 220) { // crude guard to avoid super-short lines
        cacheSet(key, text);
        return text;
      }
    } catch (e) {
      console.warn('Gemini failed; using template:', e.message);
    }
  }

  // Safe fallback (shorter than 300–400, but guarantees output)
  const fallback = `✨ ${name} ki hardik shubhkamnayein! Dil mein khushi, ghar mein barkat aur sabke liye sehat-sukoon bane rahe. Aaj ke din hum sab milkar positivity, pyaar aur unity ko celebrate karein. 🌟`;
  cacheSet(key, fallback);
  return fallback;
}

// ---- Calendarific: ask "what holidays are today in India?" ----
async function fetchCalendarific({ country = 'IN', year, month, day }) {
  if (!CAL_KEY) return [];
  const url = new URL('https://calendarific.com/api/v2/holidays');
  url.searchParams.set('api_key', CAL_KEY);
  url.searchParams.set('country', country);
  url.searchParams.set('year', String(year));
  url.searchParams.set('month', String(month));
  url.searchParams.set('day', String(day));

  const res = await fetch(url, { timeout: 20000 }).then(r => r.json()).catch(() => null);
  if (!res || !res.response || !Array.isArray(res.response.holidays)) return [];

  // Normalize a little for easier downstream handling
  return res.response.holidays.map(h => ({
    name: h.name,
    description: h.description || '',
    type: (h.type || []).map(String),
    primary_type: String(h.primary_type || '')
  }));
}

// ---- Pexels search: pick a nice horizontal image for embeds ----
function queryForImage(name, faith) {
  const base = {
    hindu: [`${name} celebration India`, `diya lamps festival lights bokeh`, `rangoli festive decor`],
    muslim: [`${name} celebration crescent moon mosque lights`, `eid lanterns (fanous) night sky`, `henna hands festive lights`],
    christian: [`${name} celebration church lights`, `christmas tree warm lights ornaments`, `candles star nativity festive`]
  };
  const arr = base[faith] || [`${name} festival India celebration`];
  return arr[Math.floor(Math.random() * arr.length)];
}

async function fetchPexelsImage(query) {
  if (!PEXELS_KEY) return '';
  try {
    const url = new URL('https://api.pexels.com/v1/search');
    url.searchParams.set('query', query);
    url.searchParams.set('per_page', '10');
    const res = await fetch(url, { headers: { Authorization: PEXELS_KEY } }).then(r => r.json());
    const photos = Array.isArray(res?.photos) ? res.photos : [];
    if (!photos.length) return '';
    const pick = photos.find(p => p.width >= p.height) || photos[0]; // prefer landscape
    return pick?.src?.landscape || pick?.src?.large || '';
  } catch {
    return '';
  }
}

async function getFestivalImage(dateISO, name, faith) {
  const key = cacheKey(dateISO, `img:${name}`);
  const cached = cacheGet(key);
  if (cached) return cached;

  let url = '';
  if (IMAGE_PROVIDER === 'pexels') {
    const query = queryForImage(name, faith);
    url = await fetchPexelsImage(query);
  }

  if (url) cacheSet(key, url);
  return url; // may be empty; embed will simply have no image
}

// ---- Build a pretty embed with optional image ----
function buildEmbed({ festivalName, faith, wishText, imageUrl, now }) {
  const color =
    faith === 'hindu' ? 0xF59E0B : // amber
    faith === 'muslim' ? 0x10B981 : // emerald
    faith === 'christian' ? 0x60A5FA : // blue
    0xA78BFA; // violet

  const title = `${festivalName} — Wishes`;
  const dateStr = now.format('dddd, DD MMM YYYY');

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(wishText)
    .setColor(color)
    .setFooter({ text: `Auto-generated • ${dateStr} • IST` });

  if (imageUrl) embed.setImage(imageUrl);
  return embed;
}

// ---- Resolve a usable text channel ----
async function resolveChannel(guild, channelId) {
  if (!channelId) return null;
  try {
    const ch = await guild.channels.fetch(channelId);
    if (!ch || ch.type !== ChannelType.GuildText) return null;
    return ch;
  } catch { return null; }
}

// ---- Main daily flow: detect → generate → image → post ----
async function runDaily(preview = false) {
  try {
    const now = dayjs().tz(TZ);
    const y = now.year();
    const m = now.month() + 1;  // JS months are 0-based
    const d = now.date();
    const dateISO = now.format('YYYY-MM-DD');

    const rawFestivals = await fetchCalendarific({ country: 'IN', year: y, month: m, day: d });

    for (const g of client.guilds.cache.values()) {
      const cfg = { ...defaultsFor(), ...(guildConfigs[g.id] || {}) };

      // Religion & major-only filters
      const festivals = rawFestivals.filter(f => {
        const faith = classifyFaith(f.name);
        const faithOk = faith ? cfg.religions.includes(faith) : false;
        const majorOk = cfg.majorOnly ? isMajorFestival(f) : true;
        return faithOk && majorOk;
      });

      if (preview) console.log(`[${g.name}] festivals today:`, festivals.map(f => f.name));
      if (!festivals.length) continue;

      // Find channel: configured → fall back to #announcements/#general → skip
      let chan = await resolveChannel(g, cfg.channelId);
      if (!chan) chan = g.channels.cache.find(c => c.type === ChannelType.GuildText && ['announcements', 'general'].includes(c.name.toLowerCase()));
      if (!chan) continue;

      const mention =
        cfg.mention === 'everyone' ? '@everyone' :
        cfg.mention === 'here' ? '@here' : '';

      for (const fest of festivals) {
        const faith = classifyFaith(fest.name);
        const wishText = await makeAIWish(dateISO, fest.name, faith);
        const imageUrl = await getFestivalImage(dateISO, fest.name, faith);
        const embed = buildEmbed({ festivalName: fest.name, faith, wishText, imageUrl, now });

        const payload = { embeds: [embed] };
        await chan.send(mention ? { content: mention, ...payload } : payload)
          .catch(err => console.error(`Send failed in ${g.name}:`, err.message));
      }

      guildConfigs[g.id] = cfg;
      saveConfigs();
    }
  } catch (e) {
    console.error('runDaily error:', e);
  }
}

// ---- Bot lifecycle ----
client.once(Events.ClientReady, () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  // 1:00 AM every day (IST)
  cron.schedule('0 1 * * *', () => runDaily(), { timezone: TZ });

  // Optional: preview run at boot (logs festivals found)
  runDaily(true);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    const gid = interaction.guildId; if (!gid) return;

    guildConfigs[gid] = { ...defaultsFor(), ...(guildConfigs[gid] || {}) };

    if (interaction.commandName === 'setwisheschannel') {
      const channel = interaction.options.getChannel('channel', true);
      if (![ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread].includes(channel.type)) {
        return interaction.reply({ content: 'Please choose a text channel.', ephemeral: true });
      }
      guildConfigs[gid].channelId = channel.id; saveConfigs();
      return interaction.reply({ content: `✅ Will post in <#${channel.id}> daily at **01:00 ${TZ}**.`, ephemeral: true });
    }

    if (interaction.commandName === 'setreligions') {
      const raw = interaction.options.getString('list', true).toLowerCase();
      const allowed = ['hindu', 'muslim', 'christian'];
      const parsed = raw.split(/[\s,]+/).map(s => s.trim()).filter(s => allowed.includes(s));
      if (!parsed.length) return interaction.reply({ content: 'Use any of: hindu, muslim, christian', ephemeral: true });
      guildConfigs[gid].religions = [...new Set(parsed)]; saveConfigs();
      return interaction.reply({ content: `✅ Religions: ${guildConfigs[gid].religions.join(', ')}`, ephemeral: true });
    }

    if (interaction.commandName === 'setmention') {
      const m = interaction.options.getString('mention', true).toLowerCase();
      if (!['everyone', 'here', 'none'].includes(m)) {
        return interaction.reply({ content: 'Choose: everyone | here | none', ephemeral: true });
      }
      guildConfigs[gid].mention = m; saveConfigs();
      return interaction.reply({ content: `✅ Mention: ${m}`, ephemeral: true });
    }

    if (interaction.commandName === 'setmajor') {
      const majorOnly = interaction.options.getBoolean('major_only', true);
      guildConfigs[gid].majorOnly = !!majorOnly; saveConfigs();
      return interaction.reply({ content: `✅ Major-only filter: ${majorOnly ? 'ON' : 'OFF'}`, ephemeral: true });
    }
  } catch (e) {
    console.error('Interaction error:', e);
    if (interaction.isRepliable()) {
      interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
});

client.login(BOT_TOKEN);
