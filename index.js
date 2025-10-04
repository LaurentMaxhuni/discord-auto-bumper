import "dotenv/config";
import express from "express";
import session from "express-session";
import {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  Routes,
} from "discord.js";
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
  BUMP_APPLICATION_ID = "302050872383242240",
  BUMP_COMMAND_NAME = "bump",
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
let resolveReady;
const readyPromise = new Promise((resolve) => {
  resolveReady = resolve;
});

let latestSessionId = null;
let resolveSessionReady;
const sessionReadyPromise = new Promise((resolve) => {
  resolveSessionReady = resolve;
});

function markSessionReady(sessionId) {
  if (!sessionId) return;
  latestSessionId = sessionId;
  resolveSessionReady?.(sessionId);
  resolveSessionReady = null;
}
function ensureClientReady() {
  if (client.isReady()) return Promise.resolve();
  return readyPromise;
}

async function ensureGatewaySession() {
  await ensureClientReady();
  if (latestSessionId) return latestSessionId;
  const immediate = client.ws.shards.first()?.sessionId ?? null;
  if (immediate) {
    markSessionReady(immediate);
    return immediate;
  }
  const awaited = await sessionReadyPromise;
  if (awaited) return awaited;
  throw new Error("Bot gateway session not ready yet");
}

// Schedule management
const intervals = new Map();
const bumpCommandCache = new Map();

function normalizeDiscordError(err, fallbackStatus = 500) {
  if (!err) {
    return { status: fallbackStatus, message: "Unknown error" };
  }

  const message =
    err?.rawError?.message || err?.message || "An unexpected Discord error occurred.";

  if (typeof err.status === "number") {
    return { status: err.status, message };
  }

  // Map common Discord API error codes to HTTP-ish responses
  switch (err.code) {
    case 50001: // Missing Access
    case 50013: // Missing Permissions
      return { status: 403, message };
    case 10003: // Unknown Channel
    case 10004: // Unknown Guild
      return { status: 404, message };
    default:
      return { status: fallbackStatus, message };
  }
}

async function resolveTextChannel(guildId, channelId) {
  let guild;
  try {
    guild = await client.guilds.fetch(guildId);
  } catch (err) {
    throw new Error("Bot is not in this guild or cannot access it.");
  }

  let channel;
  try {
    channel = await guild.channels.fetch(channelId);
  } catch (err) {
    throw new Error("Unable to access the selected channel.");
  }

  if (
    !channel ||
    !(channel.type === ChannelType.GuildText || channel.isTextBased())
  ) {
    throw new Error("Selected channel is not a text channel.");
  }

  return channel;
}

async function fetchExternalBumpCommand(guildId) {
  await ensureClientReady();
  if (!BUMP_APPLICATION_ID) {
    throw new Error("Missing BUMP_APPLICATION_ID env var");
  }

  if (bumpCommandCache.has(guildId)) {
    return bumpCommandCache.get(guildId);
  }

  let commands = [];
  async function tryGet(route, rawUrl) {
    try {
      return await client.rest.get(route);
    } catch (err) {
      // Fallback to unauthenticated fetch if the REST helper refuses the route
      try {
        const res = await fetch(rawUrl);
        if (res.ok) return await res.json();
      } catch (_) {}
      if (err?.status && err.status !== 404) throw err;
      return [];
    }
  }

  // Try guild-scoped first, then global
  commands = await tryGet(
    Routes.applicationGuildCommands(BUMP_APPLICATION_ID, guildId),
    `${API_BASE}/applications/${BUMP_APPLICATION_ID}/guilds/${guildId}/commands`
  );
  if (!commands?.length) {
    commands = await tryGet(
      Routes.applicationCommands(BUMP_APPLICATION_ID),
      `${API_BASE}/applications/${BUMP_APPLICATION_ID}/commands`
    );
  }

  const command = commands.find(
    (cmd) => cmd?.name?.toLowerCase() === BUMP_COMMAND_NAME.toLowerCase()
  );

  if (!command) {
    const error = new Error(
      `Command ${BUMP_COMMAND_NAME} not found for application ${BUMP_APPLICATION_ID}`
    );
    error.status = 404;
    throw error;
  }

  bumpCommandCache.set(guildId, command);
  return command;
}

async function executeExternalBump(guildId, channelId) {
  const sessionId = await ensureGatewaySession();
  const command = await fetchExternalBumpCommand(guildId);

  // discord.js Routes has no interactions() helper; use raw path
  await client.rest.post("/interactions", {
    body: {
      type: 2,
      application_id: BUMP_APPLICATION_ID,
      guild_id: guildId,
      channel_id: channelId,
      session_id: sessionId,
      nonce: `${Date.now()}`,
      data: {
        id: command.id,
        type: command.type,
        name: command.name,
        version: command.version,
        options: [],
        attachments: [],
      },
    },
  });
}

async function sendBump(guildId) {
  try {
    const entry = config[guildId];
    if (!entry?.channelId) return;
    await executeExternalBump(guildId, entry.channelId);
    console.log(
      `[AUTO] Triggered /${BUMP_COMMAND_NAME} for guild ${guildId} channel ${
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
  markSessionReady(client.ws.shards.first()?.sessionId ?? null);
  Object.keys(config).forEach((gid) => scheduleGuild(gid));
  resolveReady?.();
});

client.on(Events.ShardReady, (shardId) => {
  markSessionReady(client.ws.shards.get(shardId)?.sessionId ?? null);
});

client.on(Events.ShardResume, (shardId) => {
  markSessionReady(client.ws.shards.get(shardId)?.sessionId ?? null);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "bump") return;

  if (!interaction.guildId) {
    await interaction.reply({
      content: "This command can only be used inside a server.",
      ephemeral: true,
    });
    return;
  }

  const requestedChannel = interaction.options.getChannel?.("channel") ?? null;
  const entry = config[interaction.guildId];
  const targetChannelId = requestedChannel?.id ?? entry?.channelId ?? null;

  if (!targetChannelId) {
    await interaction.reply({
      content:
        "No bump channel configured for this server. Set one from the dashboard or provide a channel option.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    await ensureClientReady();
    await resolveTextChannel(interaction.guildId, targetChannelId);
    await executeExternalBump(interaction.guildId, targetChannelId);

    await interaction.editReply({
      content: `Triggered /${BUMP_COMMAND_NAME} in <#${targetChannelId}>!`,
    });
  } catch (err) {
    console.error("Slash bump failed:", err);
    const rawMessage = err?.rawError?.message || err?.message || "";
    const isCooldown =
      err?.status === 429 || /cooldown|try again/i.test(rawMessage);
    const { message } = normalizeDiscordError(err);
    const description = isCooldown
      ? "Failed to execute bump command: Cooldown in effect."
      : message || "Failed to execute bump command.";

    await interaction.editReply({
      content: description,
    });
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
  res.render("landing", {
    user: req.session.user || null,
  });
});

app.get("/terms", (req, res) => {
  res.render("terms", {
    user: req.session.user || null,
  });
});

app.get("/privacy", (req, res) => {
  res.render("privacy", {
    user: req.session.user || null,
  });
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

// API: list manageable guilds; include whether bot is present and an invite URL
app.get("/api/guilds", loginRequired, async (req, res) => {
  try {
    await ensureClientReady();
    // user guilds from session (has owner/permissions info)
    const userGuilds = req.session.guilds || [];
    // bot guilds
    await client.guilds.fetch();
    const botGuildIds = new Set(client.guilds.cache.map((g) => g.id));
    // require MANAGE_GUILD bit (0x20) or ownership
    const MANAGE_GUILD = 0x20;
    const manageable = userGuilds
      .filter(
        (g) => g.owner || (g.permissions & MANAGE_GUILD) === MANAGE_GUILD
      )
      .map((g) => {
        const hasBot = botGuildIds.has(g.id);
        // Minimal permissions: View Channels (1024), Send Messages (2048), Read Message History (65536), Use Application Commands (2147483648)
        const perms = 1024 + 2048 + 65536 + 2147483648;
        const url = new URL(OAUTH_AUTHORIZE);
        url.searchParams.set("client_id", CLIENT_ID);
        url.searchParams.set("scope", "bot applications.commands");
        url.searchParams.set("permissions", String(perms));
        url.searchParams.set("guild_id", g.id);
        url.searchParams.set("disable_guild_select", "true");
        return {
          id: g.id,
          name: g.name,
          icon: g.icon,
          hasBot,
          inviteUrl: url.toString(),
        };
      });
    res.json({ guilds: manageable, config });
  } catch (e) {
    console.error(e);
    const { status, message } = normalizeDiscordError(e);
    res.status(status).json({ error: message });
  }
});

// API: list text channels for a guild (via bot)
app.get("/api/channels", loginRequired, async (req, res) => {
  const guildId = req.query.guild_id;
  if (!guildId) return res.status(400).json({ error: "guild_id required" });
  try {
    await ensureClientReady();
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
    const { status, message } = normalizeDiscordError(e);
    res.status(status).json({ error: message });
  }
});

// API: save config
app.post("/api/save", loginRequired, async (req, res) => {
  const { guildId, channelId, intervalMinutes, message } = req.body || {};
  if (!guildId || !channelId)
    return res.status(400).json({ error: "guildId and channelId required" });

  try {
    await ensureClientReady();
    await resolveTextChannel(guildId, channelId);
  } catch (err) {
    const { status, message } = normalizeDiscordError(err, 400);
    return res.status(status).json({ error: message });
  }

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
  await ensureClientReady();
  delete config[guildId];
  saveConfig();
  const iv = intervals.get(guildId);
  if (iv) clearInterval(iv);
  intervals.delete(guildId);
  res.json({ ok: true });
});

// API: trigger bump command immediately
app.post("/api/bump", loginRequired, async (req, res) => {
  const { guildId, channelId } = req.body || {};
  if (!guildId) return res.status(400).json({ error: "guildId required" });

  const effectiveChannelId = channelId || config[guildId]?.channelId;
  if (!effectiveChannelId) {
    return res
      .status(400)
      .json({ error: "No channel provided or configured for this guild." });
  }

  try {
    await executeExternalBump(guildId, effectiveChannelId);
    res.json({ ok: true, message: "Bump command executed successfully!" });
  } catch (err) {
    console.error("Manual bump failed:", err);
    const rawMessage = err?.rawError?.message || err?.message || "";
    const isCooldown = /cooldown|please wait/i.test(rawMessage);
    const errorMessage = isCooldown
      ? "Failed to execute bump command: Cooldown in effect."
      : `Failed to execute bump command.${rawMessage ? ` ${rawMessage}` : ""}`;
    res.status(isCooldown ? 200 : 500).json({
      ok: false,
      cooldown: isCooldown,
      error: errorMessage,
      embed: {
        title: isCooldown ? "Cooldown Active" : "Bump command failed",
        description: errorMessage,
      },
    });
  }
});

// Optional helper to redirect to a crafted bot invite URL
app.get("/invite", loginRequired, (req, res) => {
  const { guild_id } = req.query;
  const perms = 1024 + 2048 + 65536 + 2147483648;
  const url = new URL(OAUTH_AUTHORIZE);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("scope", "bot applications.commands");
  url.searchParams.set("permissions", String(perms));
  if (guild_id) {
    url.searchParams.set("guild_id", String(guild_id));
    url.searchParams.set("disable_guild_select", "true");
  }
  res.redirect(url.toString());
});

app.listen(Number(PORT), () => {
  console.log(`Web dashboard on http://localhost:${PORT}`);
});
