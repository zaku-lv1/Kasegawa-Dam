import express from "express";
import { Client, GatewayIntentBits } from "discord.js";

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("Bot is running");
});

app.listen(PORT, () => {
  console.log(`🌐 Webサーバー起動完了 (Port: ${PORT})`);
});

// ===== Discord Bot =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

console.log("🤖 TOKEN exists:", !!process.env.DISCORD_TOKEN);

client.once("ready", () => {
  console.log(`✅ Discord logged in as ${client.user.tag}`);
});

console.log("🚨 ABOUT TO LOGIN DISCORD");

client.login(CONFIG.DISCORD_TOKEN)
  .then(() => console.log("🚀 login() resolved"))
  .catch(e => console.error("❌ login() rejected", e));

