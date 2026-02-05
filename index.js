const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const cron = require('node-cron');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// ===== 設定 =====
const CONFIG = {
  GAS_API_URL: process.env.GAS_API_URL,
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  CHANNEL_ID: process.env.CHANNEL_ID,
  ALERT_DECREASE: 4.0
};

const COLORS = {
  WATER: 0x00CED1,
  WARNING: 0xF39C12,
  DANGER: 0xE74C3C,
  PRIMARY: 0x3498DB
};

// ====== クライアント ======
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ===== コマンド定義 =====
const commands = [
  new SlashCommandBuilder()
    .setName('dam')
    .setDescription('嘉瀬川ダムの情報')
    .addSubcommand(sub => sub.setName('start').setDescription('監視スタート（再実行でリセット）'))
].map(cmd => cmd.toJSON());

// ===== コマンド登録 =====
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: commands });
}

// ====== GAS API呼び出し ======
async function callGasApi(action) {
  const url = `${CONFIG.GAS_API_URL}?action=${action}`;
  const res = await fetch(url);
  return await res.json();
}
function createProgressBar(percent) {
  const total = 20;
  const filled = Math.round((percent / 100) * total);
  const empty = total - filled;
  return '🟩'.repeat(filled) + '⬜'.repeat(empty) + `\n\`${percent.toFixed(0)}% / 100%\``;
}

// ===== スラッシュコマンド応答 =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'dam') return;
  const sub = interaction.options.getSubcommand();
  if(sub === 'start') await handleStartCommand(interaction);
});

// ===== /dam startコマンド =====
async function handleStartCommand(interaction) {
  await interaction.deferReply();
  const username = interaction.user.username;
  const userAvatar = interaction.user.displayAvatarURL();
  // GASでセッション開始
  const data = await callGasApi(`start&username=${encodeURIComponent(username)}`);
  if (!data.success) {
    const errorEmbed = new EmbedBuilder()
      .setColor(COLORS.DANGER)
      .setTitle('❌ エラー')
      .setDescription('データの取得に失敗しました。')
      .setTimestamp();
    await interaction.editReply({ embeds: [errorEmbed] });
    return;
  }
  const currentRate = data.current.rate;
  const isReset = data.isReset;
  const targetRate = (currentRate - CONFIG.ALERT_DECREASE).toFixed(1);

  const embed = new EmbedBuilder()
    .setColor(isReset ? COLORS.WARNING : COLORS.WATER)
    .setAuthor({ 
      name: isReset ? '🔄 監視リセット' : '🚣 乗艇開始',
      iconURL: userAvatar
    })
    .setTitle('嘉瀬川ダム監視システム')
    .setDescription(isReset ? '```監視をリセットしました```' : '```監視を開始しました```')
    .addFields(
      { name: '━━━━━━━━━━ 📍 基準値 ━━━━━━━━━━', value: '\u200B', inline: false },
      { name: '現在の貯水率', value: `\`\`\`css\n${currentRate}%\n\`\`\``, inline: true },
      { name: '通知ライン', value: `\`\`\`fix\n${targetRate}%\n\`\`\``, inline: true },
      { name: '減少許容', value: `\`\`\`diff\n- ${CONFIG.ALERT_DECREASE}%\n\`\`\``, inline: true },
      { name: '━━━━━━━━━━ 📊 進捗 ━━━━━━━━━━', value: createProgressBar(0), inline: false }
    )
    .setFooter({ text: `実行者: ${username} • 再度 /dam start でリセット`, iconURL: userAvatar })
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}

// ===== 定期監視 =====
cron.schedule('*/30 * * * *', async () => {
  const sessionData = await callGasApi('session');
  if (!sessionData.success || !sessionData.session || sessionData.session.notified) return;
  const session = sessionData.session;
  const statusData = await callGasApi('status');
  if (!statusData.success) return;
  const currentRate = statusData.current.rate;
  const decrease = session.startRate - currentRate;
  if (decrease >= CONFIG.ALERT_DECREASE) {
    // Discord通知
    const channel = client.channels.cache.get(CONFIG.CHANNEL_ID);
    if (channel) {
      await channel.send('@everyone 🚨 貯水率が4%以上減少しました！');
    }
    // 通知済みフラグをGAS更新
    await callGasApi('notify');
  }
}, { timezone: 'Asia/Tokyo' });

// ===== 起動 =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.login(CONFIG.DISCORD_TOKEN);
