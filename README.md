# Discord Bump Bot

Minimal Discord.js bot with:
- `/bump` slash command
- automatic message every 2 hours in a chosen channel

## Setup

1. **Create bot** at https://discord.com/developers/applications
   - Add a Bot user, copy the token.
   - Invite with scopes: `bot applications.commands`
   - Give the bot permission to send messages in your target channel.

2. **Create `.env`**
```
DISCORD_BOT_TOKEN=YOUR_BOT_TOKEN
CLIENT_ID=YOUR_APPLICATION_ID
GUILD_ID=YOUR_TEST_GUILD_ID
CHANNEL_ID=YOUR_TARGET_CHANNEL_ID
```

3. **Install**
```
npm i
```

4. **Register commands** (guild-scoped for instant availability)
```
npm run deploy
```

5. **Run**
```
npm start
```

6. **Use**
- Type `/bump` in your test guild.
- The bot will also send "Bumped! 🚀" to `CHANNEL_ID` every 2 hours.

## Notes
- Node 18+ recommended.
- You do **not** need Message Content intent.
- If commands don't appear, ensure you invited the **same application** you're registering for and used `applications.commands` scope.
