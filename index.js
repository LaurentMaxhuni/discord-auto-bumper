import "dotenv/config";
import express from "express";
import session from "express-session";
import { Client, GatewayIntentBits, Events, ChannelType } from "discord.js";
import path from "node:path";
import fs from "node:fs";

const {
  DISCORD_BOT_TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI = "http://localhost:3000/callback",
  PORT = 3000,
  SESSION_SECRET = "changeme",
  DEFAULT_INTERVAL_MINUTES = "120",
} = process.env;

if (!DISCORD_BOT_TOKEN || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing required env vars. Check .env");
  process.exit(1);
}

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "views"));
app.use(express.static(path.join(process.cwd(), "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  })
);

// Simple file-backed config
const CONFIG_PATH = path.join(process.cwd(), "configs.json");
let config = {};
try {
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  }
} catch (e) {
  console.error("Failed to load configs.json", e);
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Discord bot
const client = new Client({
  intents: [GatewayIntentBits.Guilds], // no message content needed
});

// Schedule management
const intervals = new Map();

async function sendBump(guildId) {
  try {
    const entry = config[guildId];
    if (!entry?.channelId) return;
    const channel = await client.channels.fetch(entry.channelId);
    if (!channel || !channel.isTextBased()) return;
    await channel.send(entry.message || "Bumped! 🚀");
    console.log(
      `[AUTO] Bumped in guild ${guildId} channel ${
        entry.channelId
      } at ${new Date().toISOString()}`
    );
  } catch (err) {
    console.error("Auto-bump error:", err);
  }
}

function scheduleGuild(guildId) {
  const existing = intervals.get(guildId);
  if (existing) clearInterval(existing);
  const minutes = Number(
    config[guildId]?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES
  );
  const ms = Math.max(1, minutes) * 60 * 1000;
  const iv = setInterval(() => sendBump(guildId), ms);
  intervals.set(guildId, iv);
  console.log(`[SCHEDULE] guild ${guildId} every ${minutes} min`);
}

// Bring up schedules on ready
client.once(Events.ClientReady, () => {
  console.log(`Ready as ${client.user.tag}`);
  Object.keys(config).forEach((gid) => scheduleGuild(gid));
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "bump") {
    await interaction.reply("Bumped! 🚀");
  }
});

client.login(DISCORD_BOT_TOKEN).catch((e) => {
  console.error("Bot login failed:", e);
  process.exit(1);
});

// OAuth helpers
const OAUTH_AUTHORIZE = "https://discord.com/api/oauth2/authorize";
const OAUTH_TOKEN = "https://discord.com/api/oauth2/token";
const API_BASE = "https://discord.com/api/v10";

function loginRequired(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

// Routes
app.get("/", (req, res) => {
  res.redirect("/dashboard");
});

app.get("/login", (req, res) => {
  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", process.env.CLIENT_ID); // must be your Application ID
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", process.env.REDIRECT_URI); // must match portal exactly
  url.searchParams.set("scope", "identify guilds");
  url.searchParams.set("prompt", "consent");
  res.redirect(url.toString());
});

app.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");

  try {
    const form = new URLSearchParams();
    form.set("client_id", process.env.CLIENT_ID);
    form.set("client_secret", process.env.CLIENT_SECRET); // NOT the bot token
    form.set("grant_type", "authorization_code");
    form.set("code", code);
    form.set("redirect_uri", process.env.REDIRECT_URI);
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(JSON.stringify(tokens));

    // Get user and guilds
    const uRes = await fetch(`${API_BASE}/users/@me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const user = await uRes.json();
    const gRes = await fetch(`${API_BASE}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const guilds = await gRes.json();

    req.session.user = { id: user.id, username: user.username };
    req.session.tokens = tokens;
    req.session.guilds = guilds;
    res.redirect("/dashboard");
  } catch (e) {
    console.error("OAuth failed:", e);
    res.status(500).send("OAuth error");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

app.get("/dashboard", loginRequired, (req, res) => {
  res.render("dashboard", {
    user: req.session.user,
  });
});

// API: list manageable guilds where the bot is present
app.get("/api/guilds", loginRequired, async (req, res) => {
  try {
    // user guilds from session (has owner/permissions info)
    const userGuilds = req.session.guilds || [];
    // bot guilds
    await client.guilds.fetch();
    const botGuildIds = new Set(client.guilds.cache.map((g) => g.id));
    // require MANAGE_GUILD bit (0x20) or ownership
    const MANAGE_GUILD = 0x20;
    const manageable = userGuilds
      .filter(
        (g) =>
          botGuildIds.has(g.id) &&
          (g.owner || (g.permissions & MANAGE_GUILD) === MANAGE_GUILD)
      )
      .map((g) => ({
        id: g.id,
        name: g.name,
        icon: g.icon,
      }));
    res.json({ guilds: manageable, config });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed" });
  }
});

// API: list text channels for a guild (via bot)
app.get("/api/channels", loginRequired, async (req, res) => {
  const guildId = req.query.guild_id;
  if (!guildId) return res.status(400).json({ error: "guild_id required" });
  try {
    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    const textChannels = channels
      .filter(
        (ch) => ch && (ch.type === ChannelType.GuildText || ch.isTextBased())
      )
      .map((ch) => ({ id: ch.id, name: ch.name ?? `#${ch.id}` }));
    res.json({ channels: textChannels });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed" });
  }
});

// API: save config
app.post("/api/save", loginRequired, async (req, res) => {
  const { guildId, channelId, intervalMinutes, message } = req.body || {};
  if (!guildId || !channelId)
    return res.status(400).json({ error: "guildId and channelId required" });
  config[guildId] = {
    channelId,
    intervalMinutes:
      Number(intervalMinutes) || Number(DEFAULT_INTERVAL_MINUTES),
    message: (message && String(message).slice(0, 2000)) || "Bumped! 🚀",
  };
  saveConfig();
  scheduleGuild(guildId);
  res.json({ ok: true, config: config[guildId] });
});

// API: remove config
app.post("/api/remove", loginRequired, async (req, res) => {
  const { guildId } = req.body || {};
  if (!guildId) return res.status(400).json({ error: "guildId required" });
  delete config[guildId];
  saveConfig();
  const iv = intervals.get(guildId);
  if (iv) clearInterval(iv);
  intervals.delete(guildId);
  res.json({ ok: true });
});

app.listen(Number(PORT), () => {
  console.log(`Web dashboard on http://localhost:${PORT}`);
});
