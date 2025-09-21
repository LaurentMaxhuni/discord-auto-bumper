# Discord Bump Bot

Minimal Discord.js bot with:
- `/bump` slash command proxy that relays to a partner bot (e.g. DISBOARD)
- automatic triggering every few hours in a chosen channel
- OAuth-powered dashboard to configure schedules and fire bumps instantly

## Setup

1. **Create bot** at https://discord.com/developers/applications
   - Add a Bot user, copy the token.
   - Invite with scopes: `bot applications.commands`
   - Give the bot permission to send messages in your target channel.

2. **Create `.env`**
```
DISCORD_BOT_TOKEN=YOUR_BOT_TOKEN
CLIENT_ID=YOUR_APPLICATION_ID
CLIENT_SECRET=YOUR_OAUTH_SECRET
REDIRECT_URI=http://localhost:3000/callback
SESSION_SECRET=super-secret-session-key
# Optional overrides:
# BUMP_APPLICATION_ID=302050872383242240 (DISBOARD default)
# BUMP_COMMAND_NAME=bump
```

3. **Install**
```
npm i
```

4. **Run**
```
npm start
```

5. **Use**
- Visit http://localhost:3000/login and sign in with Discord.
- Pick a guild, select the bump channel and cadence, then hit **Trigger /bump** to relay the partner bot's command.
- Automatic bumps reuse the same channel and interval you configure in the dashboard.

## Notes
- Node 18+ recommended.
- You do **not** need Message Content intent.
- If commands don't appear, ensure you invited the **same application** you're registering for and used `applications.commands` scope.
