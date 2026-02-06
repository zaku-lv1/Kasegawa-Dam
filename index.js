// index.js
import express from "express";
import { Client, GatewayIntentBits } from "discord.js";

const app = express();
const PORT = process.env.PORT || 10000;
const TOKEN = process.env.DISCORD_TOKEN;

console.log("🤖 TOKEN exists:", !!TOKEN);

// --- Web ---
app.get("/", (req, res) => {
  res.send("Bot is running!");
});

app.listen(PORT, () => {
  console.log(`🌐 Webサーバー起動完了 (Port: ${PORT})`);
});

// --- Discord ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", () => {
  console.log(`✅ Discord logged in as ${client.user.tag}`);
});

client.login(TOKEN)
  .then(() => console.log("🚀 login() 実行完了"))
  .catch(err => console.error("❌ Discord login error:", err));
