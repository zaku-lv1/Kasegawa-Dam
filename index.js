const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const cron = require('node-cron');
const http = require('http');

// ===== 1. HTTPサーバー (Renderのスリープ・タイムアウト防止) =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', bot: 'Kasegawa-Dam-Bot' }));
}).listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Webサーバー起動中: Port ${PORT}`);
});

// ===== 2. 設定確認 =====
const CONFIG = {
  GAS_API_URL: process.env.GAS_API_URL,
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  CHANNEL_ID: process.env.CHANNEL_ID,
  ALERT_DECREASE: 4.0
};

// 権限設定 (オンラインにならない問題を避けるため全開放)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ===== 3. カラーパレット & ユーティリティ =====
const COLORS = {
  PRIMARY: 0x3498DB, SUCCESS: 0x2ECC71, WARNING: 0xF39C12,
  DANGER: 0xE74C3C, INFO: 0x9B59B6, DARK: 0x2C3E50, WATER: 0x00CED1
};

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

// ===== 4. GAS API 通信 (タイムアウト対策) =====
async function callGasApi(action, params = {}) {
  try {
    const url = new URL(CONFIG.GAS_API_URL);
    url.searchParams.append('action', action);
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
    
    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`❌ GAS API Error (${action}):`, error);
    return { success: false, error: error.message };
  }
}

// ===== 5. スラッシュコマンド定義 =====
const commands = [
  new SlashCommandBuilder()
    .setName('dam')
    .setDescription('嘉瀬川ダムの監視システム')
    .addSubcommand(sub => sub.setName('start').setDescription('🚣 乗艇開始！監視スタート（基準値を保存）'))
    .addSubcommand(sub => sub.setName('status').setDescription('📊 現在の監視状態を確認'))
    .addSubcommand(sub => sub.setName('now').setDescription('💧 現在の貯水率を表示'))
    .addSubcommand(sub => sub.setName('help').setDescription('❓ 使い方を表示'))
].map(cmd => cmd.toJSON());

// ===== 6. インタラクション処理 =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'dam') return;

  // 3秒ルール対策：即座に応答を予約
  try {
    await interaction.deferReply();
  } catch (e) { return; }

  const subcommand = interaction.options.getSubcommand();

  try {
    if (subcommand === 'start') await handleStartCommand(interaction);
    else if (subcommand === 'status') await handleStatusCommand(interaction);
    else if (subcommand === 'now') await handleNowCommand(interaction);
    else if (subcommand === 'help') await handleHelpCommand(interaction);
  } catch (error) {
    console.error(error);
    await interaction.editReply('⚠️ システムエラーが発生しました。');
  }
});

// --- 各コマンドの処理 ---

async function handleStartCommand(interaction) {
  // GAS側にセッションを開始させる（Render再起動対策）
  const data = await callGasApi('start', { username: interaction.user.username });
  if (!data.success) return await interaction.editReply('❌ GAS通信失敗');

  const cur = data.current;
  const targetRate = (cur.rate - CONFIG.ALERT_DECREASE).toFixed(1);
  const progressBar = createProgressBar(0);

  const embed = new EmbedBuilder()
    .setColor(data.isReset ? COLORS.WARNING : COLORS.WATER)
    .setAuthor({ name: data.isReset ? '🔄 監視リセット' : '🚣 乗艇開始', iconURL: interaction.user.displayAvatarURL() })
    .setTitle('嘉瀬川ダム監視システム')
    .setDescription(data.isReset ? '```監視をリセットしました```' : '```監視を開始しました```')
    .addFields(
      { name: '━━━━━━━━━━ 📍 基準値 ━━━━━━━━━━', value: '\u200B' },
      { name: '現在の貯水率', value: `\`\`\`css\n${cur.rate}%\n\`\`\``, inline: true },
      { name: '通知ライン', value: `\`\`\`fix\n${targetRate}%\n\`\`\``, inline: true },
      { name: '減少許容', value: `\`\`\`diff\n- ${CONFIG.ALERT_DECREASE}%\n\`\`\``, inline: true },
      { name: '━━━━━━━━━━ 📊 進捗 ━━━━━━━━━━', value: progressBar }
    )
    .setFooter({ text: `実行者: ${interaction.user.username} • 30分毎に自動監視中` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleStatusCommand(interaction) {
  const [sData, stData] = await Promise.all([callGasApi('session'), callGasApi('status')]);
  if (!sData.success || !sData.session) return await interaction.editReply('📊 監視セッションがありません。`/dam start` を行ってください。');

  const session = sData.session;
  const cur = stData.current;
  const change = cur.rate - session.startRate;
  const remaining = cur.rate - (session.startRate - CONFIG.ALERT_DECREASE);
  const progress = Math.min(100, Math.max(0, (Math.abs(change) / CONFIG.ALERT_DECREASE) * 100));

  let color = COLORS.SUCCESS, icon = '✅', text = '正常';
  if (remaining <= 0) { color = COLORS.DANGER; icon = '🚨'; text = '通知ライン到達'; }
  else if (remaining <= 1) { color = COLORS.WARNING; icon = '⚠️'; text = 'まもなく通知'; }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('📊 監視ステータス')
    .setDescription(`\`\`\`${icon} ステータス: ${text}\`\`\``)
    .addFields(
      { name: '━━━━━━━━━ 💧 貯水率情報 ━━━━━━━━━', value: '\u200B' },
      { name: '開始時', value: `\`\`\`yaml\n${session.startRate}%\n\`\`\``, inline: true },
      { name: '現在', value: `\`\`\`css\n${cur.rate}%\n\`\`\``, inline: true },
      { name: '変化', value: `\`\`\`diff\n${change >= 0 ? '+' : ''}${change.toFixed(1)}%\n\`\`\``, inline: true },
      { name: '━━━━━━━━━━ 🎯 通知まで ━━━━━━━━━━', value: '\u200B' },
      { name: '通知ライン', value: `\`\`\`fix\n${(session.startRate - CONFIG.ALERT_DECREASE).toFixed(1)}%\n\`\`\``, inline: true },
      { name: '残り', value: `\`\`\`yaml\n${remaining.toFixed(1)}%\n\`\`\``, inline: true },
      { name: '経過時間', value: `\`\`\`\n${formatDuration(session.startTime)}\n\`\`\``, inline: true },
      { name: '━━━━━━━━━━ 📈 進捗 ━━━━━━━━━━', value: createProgressBar(progress) }
    )
    .setFooter({ text: `開始者: ${session.startedBy}` }).setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleNowCommand(interaction) {
  const data = await callGasApi('status');
  if (!data.success) return await interaction.editReply('❌ データ取得失敗');
  const cur = data.current;

  const embed = new EmbedBuilder()
    .setColor(cur.rate >= 70 ? COLORS.SUCCESS : COLORS.WARNING)
    .setTitle('🌊 現在の嘉瀬川ダム状況')
    .setDescription(`\`\`\`観測日時: ${cur.datetime}\`\`\``)
    .addFields(
      { name: '貯水率', value: `\`\`\`css\n${cur.rate}%\n\`\`\``, inline: true },
      { name: '貯水量', value: `\`\`\`yaml\n${cur.volume.toLocaleString()} 千m³\n\`\`\``, inline: true },
      { name: '流入量', value: `\`\`\`diff\n+ ${cur.inflow} m³/s\n\`\`\``, inline: true },
      { name: '放流量', value: `\`\`\`diff\n- ${cur.outflow} m³/s\n\`\`\``, inline: true }
    ).setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleHelpCommand(interaction) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.PRIMARY).setTitle('🌊 嘉瀬川ダム監視Bot 使い方')
    .addFields(
      { name: '🚣 `/dam start`', value: '監視を開始します。' },
      { name: '📊 `/dam status`', value: '開始時からの変化を表示します。' },
      { name: '💧 `/dam now`', value: '現在の最新ダムデータを表示します。' },
      { name: '⚙️ 仕組み', value: `基準から${CONFIG.ALERT_DECREASE}%減ると@everyoneで通知します。` }
    );
  await interaction.editReply({ embeds: [embed] });
}

// ===== 7. 自動監視タスク (30分毎) =====
cron.schedule('*/30 * * * *', async () => {
  if (!CONFIG.CHANNEL_ID) return;
  const sData = await callGasApi('session');
  if (!sData.success || !sData.session || sData.session.notified) return;

  const stData = await callGasApi('status');
  if (sData.session.startRate - stData.current.rate >= CONFIG.ALERT_DECREASE) {
    const channel = await client.channels.fetch(CONFIG.CHANNEL_ID).catch(() => null);
    if (channel) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.DANGER).setTitle('🚨 貯水率低下アラート')
        .setDescription('```diff\n- 基準値から4%以上低下しました！\n```')
        .addFields(
          { name: '開始時', value: `${sData.session.startRate}%`, inline: true },
          { name: '現在', value: `${stData.current.rate}%`, inline: true },
          { name: '減少量', value: `${(sData.session.startRate - stData.current.rate).toFixed(1)}%`, inline: true }
        );
      await channel.send({ content: '@everyone 🚨 ダムの水位が低下しています！', embeds: [embed] });
      await callGasApi('notify');
    }
  }
}, { timezone: 'Asia/Tokyo' });

// ===== 8. 起動処理 =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: commands });
    console.log('✅ コマンド登録完了');
  } catch (e) { console.error(e); }
});

client.login(CONFIG.DISCORD_TOKEN);
