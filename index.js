const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const cron = require('node-cron');
const http = require('http');

// ===== 1. Render用 Webサーバー (これが無いとRenderに落とされます) =====
const PORT = process.env.PORT || 10000; // Renderのデフォルト10000に対応
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'active' }));
}).listen(PORT, () => {
  console.log(`🌐 Webサーバー起動完了 (Port: ${PORT})`);
});

// ===== 2. 設定 =====
const CONFIG = {
  GAS_API_URL: process.env.GAS_API_URL,
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  CHANNEL_ID: process.env.CHANNEL_ID,
  ALERT_DECREASE: 4.0
};

// インテント設定 (設定した3つのスイッチに対応)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
console.log("🤖 login直前 TOKEN exists:", !!CONFIG.DISCORD_TOKEN);

console.log("🚨 ABOUT TO LOGIN DISCORD");

client.login(CONFIG.DISCORD_TOKEN)
  .then(() => {
    console.log("🚀 client.login() resolved");
  })
  .catch(err => {
    console.error('❌ ログイン失敗:', err);
  });

const COLORS = {
  PRIMARY: 0x3498DB, SUCCESS: 0x2ECC71, WARNING: 0xF39C12,
  DANGER: 0xE74C3C, INFO: 0x9B59B6, DARK: 0x2C3E50, WATER: 0x00CED1
};

// ===== 3. ユーティリティ =====
function createProgressBar(percent) {
  const total = 20;
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * total);
  const empty = total - filled;
  let bar = '';
  if (percent < 50) bar = '🟩'.repeat(filled) + '⬜'.repeat(empty);
  else if (percent < 80) bar = '🟨'.repeat(filled) + '⬜'.repeat(empty);
  else bar = '🟥'.repeat(filled) + '⬜'.repeat(empty);
  return `${bar}\n\`${percent.toFixed(1)}% / 100%\``;
}

function formatDuration(startTimeStr) {
  if (!startTimeStr) return "不明";
  const ms = Date.now() - new Date(startTimeStr).getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  return hours > 0 ? `${hours}時間 ${minutes}分` : `${minutes}分`;
}

// ===== 4. GAS API 通信 (デバッグログ強化版) =====
async function callGasApi(action, params = {}, signal = null) {
  const startTime = Date.now(); // 実行時間の計測用
  try {
    const url = new URL(CONFIG.GAS_API_URL);
    url.searchParams.append('action', action);
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
    
    // --- ログ追加 ---
    console.log(`📡 [${action}] GASリクエスト送信中...`);
    console.log(`🔗 URL: ${url.origin}${url.pathname}?action=${action}`); // セキュリティのためパラメータは最小限表示

    // Node.jsの標準fetchを使用
    const response = await fetch(url.toString(), { signal });
    
    const duration = (Date.now() - startTime) / 1000;
    console.log(`📥 [${action}] GASレスポンス受信: Status ${response.status} (${duration}秒経過)`);

    if (!response.ok) {
      throw new Error(`HTTPエラー ステータス: ${response.status}`);
    }

    const data = await response.json();
    console.log(`✅ [${action}] データ解析成功`);
    return data;
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    
    if (error.name === 'AbortError') {
      console.error(`⚠️ [${action}] タイムアウトにより中断 (${duration}秒)`);
      throw error;
    }
    
    console.error(`❌ [${action}] GAS通信エラー (${duration}秒経過):`, error.message);
    return { success: false, error: error.message };
  }
}

// ===== 5. コマンド定義 =====
const commands = [
  new SlashCommandBuilder()
    .setName('dam')
    .setDescription('嘉瀬川ダムの監視システム')
    .addSubcommand(sub => sub.setName('start').setDescription('🚣 乗艇開始！監視スタート'))
    .addSubcommand(sub => sub.setName('status').setDescription('📊 現在の監視状態を確認'))
    .addSubcommand(sub => sub.setName('now').setDescription('💧 現在の貯水率を表示'))
    .addSubcommand(sub => sub.setName('help').setDescription('❓ 使い方を表示'))
].map(cmd => cmd.toJSON());

// ===== 6. インタラクション処理 =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'dam') return;

  try {
    await interaction.deferReply(); // ここで3秒タイムアウトを回避
  } catch (e) { return; }

  const subcommand = interaction.options.getSubcommand();

  try {
    if (subcommand === 'start') {
      const data = await callGasApi('start', { username: interaction.user.username });
      if (!data.success) return await interaction.editReply('❌ GAS通信に失敗しました。');

      const cur = data.current;
      const targetRate = (cur.rate - CONFIG.ALERT_DECREASE).toFixed(1);
      const embed = new EmbedBuilder()
        .setColor(data.isReset ? COLORS.WARNING : COLORS.WATER)
        .setAuthor({ name: data.isReset ? '🔄 監視リセット' : '🚣 乗艇開始', iconURL: interaction.user.displayAvatarURL() })
        .setTitle('嘉瀬川ダム監視システム')
        .addFields(
          { name: '現在の貯水率', value: `\`\`\`css\n${cur.rate}%\n\`\`\``, inline: true },
          { name: '通知ライン', value: `\`\`\`fix\n${targetRate}%\n\`\`\``, inline: true },
          { name: '━━━━━━━━━━ 📊 進捗 ━━━━━━━━━━', value: createProgressBar(0) }
        ).setFooter({ text: `実行者: ${interaction.user.username}` }).setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    } else if (subcommand === 'status') {
      const [sData, stData] = await Promise.all([callGasApi('session'), callGasApi('status')]);
      if (!sData.success || !sData.session) return await interaction.editReply('📊 監視が開始されていません。');
      
      const session = sData.session;
      const cur = stData.current;
      const change = cur.rate - session.startRate;
      const remaining = cur.rate - (session.startRate - CONFIG.ALERT_DECREASE);
      const progress = Math.min(100, Math.max(0, (Math.abs(change) / CONFIG.ALERT_DECREASE) * 100));

      const embed = new EmbedBuilder()
        .setColor(remaining <= 0 ? COLORS.DANGER : COLORS.SUCCESS)
        .setTitle('📊 監視ステータス')
        .addFields(
          { name: '開始時', value: `\`${session.startRate}%\``, inline: true },
          { name: '現在', value: `\`${cur.rate}%\``, inline: true },
          { name: '経過時間', value: `\`${formatDuration(session.startTime)}\``, inline: true },
          { name: '進捗', value: createProgressBar(progress) }
        ).setFooter({ text: `開始者: ${session.startedBy}` });
      await interaction.editReply({ embeds: [embed] });

    } else if (subcommand === 'now') {
      const data = await callGasApi('status');
      if (!data.success) return await interaction.editReply('❌ 取得失敗');
      const cur = data.current;
      const embed = new EmbedBuilder()
        .setColor(COLORS.PRIMARY).setTitle('🌊 現在の嘉瀬川ダム状況')
        .addFields(
          { name: '貯水率', value: `\`${cur.rate}%\``, inline: true },
          { name: '流入量', value: `\`${cur.inflow} m³/s\``, inline: true },
          { name: '放流量', value: `\`${cur.outflow} m³/s\``, inline: true }
        ).setFooter({ text: `観測: ${cur.datetime}` });
      await interaction.editReply({ embeds: [embed] });

    } else if (subcommand === 'help') {
      const embed = new EmbedBuilder().setColor(COLORS.DARK).setTitle('❓ 使い方')
        .setDescription('`/dam start`: 監視開始\n`/dam status`: 状況確認\n`/dam now`: 現況表示');
      await interaction.editReply({ embeds: [embed] });
    }
  } catch (error) {
    console.error(error);
  }
});

// ===== 7. 定期監視 (30分毎) =====
cron.schedule('*/30 * * * *', async () => {
  if (!CONFIG.CHANNEL_ID) return;
  const sData = await callGasApi('session');
  if (!sData.success || !sData.session || sData.session.notified) return;

  const stData = await callGasApi('status');
  if (sData.session.startRate - stData.current.rate >= CONFIG.ALERT_DECREASE) {
    const channel = await client.channels.fetch(CONFIG.CHANNEL_ID).catch(() => null);
    if (channel) {
      const embed = new EmbedBuilder().setColor(COLORS.DANGER).setTitle('🚨 貯水率低下！')
        .setDescription(`基準から ${CONFIG.ALERT_DECREASE}% 以上低下しました。\n現在: ${stData.current.rate}%`);
      await channel.send({ content: '@everyone', embeds: [embed] });
      await callGasApi('notify');
    }
  }
}, { timezone: 'Asia/Tokyo' });

// ===== 8. 起動 =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: commands });
    console.log('✅ コマンド登録完了');
  } catch (e) { console.error('❌ コマンド登録失敗:', e); }
});
