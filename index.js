const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const cron = require('node-cron');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const http = require('http');

// ===== HTTPサーバー（Render用） =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
}).listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Server listening on port ${PORT}`);
});

// ===== 設定 =====
const CONFIG = {
  GAS_API_URL: process.env.GAS_API_URL,
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  CHANNEL_ID: process.env.CHANNEL_ID,
  ALERT_DECREASE: 4.0
};

const COLORS = {
  PRIMARY: 0x3498DB,
  SUCCESS: 0x2ECC71,
  WARNING: 0xF39C12,
  DANGER: 0xE74C3C,
  DARK: 0x2C3E50,
  WATER: 0x00CED1
};

// ====== クライアント ======
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ===== コマンド定義 =====
const commands = [
  new SlashCommandBuilder()
    .setName('dam')
    .setDescription('嘉瀬川ダムの情報を取得')
    .addSubcommand(sub => sub.setName('start').setDescription('🚣 乗艇開始！監視スタート（再実行でリセット）'))
    .addSubcommand(sub => sub.setName('status').setDescription('📊 現在の監視状態を確認'))
    .addSubcommand(sub => sub.setName('now').setDescription('💧 現在の貯水率を表示'))
    .addSubcommand(sub => sub.setName('help').setDescription('❓ ヘルプを表示'))
].map(cmd => cmd.toJSON());

// ===== コマンド登録 =====
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
  try {
    console.log('🔄 スラッシュコマンドを登録中...');
    await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: commands });
    console.log('✅ スラッシュコマンド登録完了');
  } catch (error) {
    console.error('コマンド登録エラー:', error);
  }
}

// ====== GAS API呼び出し ======
async function callGasApi(action) {
  const url = `${CONFIG.GAS_API_URL}?action=${action}`;
  try {
    const res = await fetch(url);
    return await res.json();
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ===== ユーティリティ =====
function createProgressBar(percent) {
  const total = 20;
  const filled = Math.round((percent / 100) * total);
  const empty = total - filled;
  let bar = '';
  if (percent < 50) bar = '🟩'.repeat(filled) + '⬜'.repeat(empty);
  else if (percent < 80) bar = '🟨'.repeat(filled) + '⬜'.repeat(empty);
  else bar = '🟥'.repeat(filled) + '⬜'.repeat(empty);
  return `${bar}\n\`${percent.toFixed(0)}% / 100%\``;
}

function getRateColor(rate) {
  if (rate >= 70) return COLORS.SUCCESS;
  if (rate >= 50) return COLORS.WARNING;
  if (rate >= 30) return COLORS.DANGER;
  return 0x8B0000;
}

function getRateEmoji(rate) {
  if (rate >= 70) return '🟢';
  if (rate >= 50) return '🟡';
  if (rate >= 30) return '🟠';
  return '🔴';
}

function formatDuration(ms) {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  return hours > 0 ? `${hours}時間 ${minutes}分` : `${minutes}分`;
}

// ===== スラッシュコマンド応答 =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'dam') return;
  const sub = interaction.options.getSubcommand();
  switch(sub) {
    case 'start': await handleStartCommand(interaction); break;
    case 'status': await handleStatusCommand(interaction); break;
    case 'now': await handleNowCommand(interaction); break;
    case 'help': await handleHelpCommand(interaction); break;
  }
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
      .setDescription('データの取得に失敗しました。\nしばらく待ってから再度お試しください。')
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

// ===== /dam statusコマンド =====
async function handleStatusCommand(interaction) {
  await interaction.deferReply();

  // GASからセッション取得
  const sessionData = await callGasApi('session');
  const session = sessionData.success ? sessionData.session : null;
  
  if (!session) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.DARK)
      .setTitle('📊 監視ステータス')
      .setDescription('```現在、監視は開始されていません```')
      .addFields({ name: '💡 ヒント', value: '`/dam start` で監視を開始できます' })
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const statusData = await callGasApi('status');
  if (!statusData.success) {
    const errorEmbed = new EmbedBuilder()
      .setColor(COLORS.DANGER)
      .setTitle('❌ エラー')
      .setDescription('データの取得に失敗しました。')
      .setTimestamp();
    await interaction.editReply({ embeds: [errorEmbed] });
    return;
  }

  const currentRate = statusData.current.rate;
  const startRate = session.startRate;
  const targetRate = startRate - CONFIG.ALERT_DECREASE;
  const change = currentRate - startRate;
  const remaining = currentRate - targetRate;
  const progress = Math.min(100, Math.max(0, (Math.abs(change) / CONFIG.ALERT_DECREASE) * 100));
  const duration = formatDuration(Date.now() - new Date(session.startTime).getTime());

  let color, statusIcon, statusText;
  if (session.notified || remaining <= 0) {
    color = COLORS.DANGER; statusIcon = '🚨'; statusText = '通知済み';
  } else if (remaining <= 1) {
    color = COLORS.WARNING; statusIcon = '⚠️'; statusText = 'まもなく通知';
  } else if (remaining <= 2) {
    color = COLORS.WARNING; statusIcon = '📢'; statusText = '注意';
  } else {
    color = COLORS.SUCCESS; statusIcon = '✅'; statusText = '正常';
  }

  const changeDisplay = change >= 0 ? `+${change.toFixed(1)}` : change.toFixed(1);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('📊 監視ステータス')
    .setDescription(`\`\`\`${statusIcon} ステータス: ${statusText}\`\`\``)
    .addFields(
      { name: '━━━━━━━━━ 💧 貯水率情報 ━━━━━━━━━', value: '\u200B', inline: false },
      { name: '開始時', value: `\`\`\`yaml\n${startRate}%\n\`\`\``, inline: true },
      { name: '現在', value: `\`\`\`css\n${currentRate}%\n\`\`\``, inline: true },
      { name: '変化', value: `\`\`\`diff\n${changeDisplay}%\n\`\`\``, inline: true },
      { name: '━━━━━━━━━━ 🎯 通知まで ━━━━━━━━━━', value: '\u200B', inline: false },
      { name: '通知ライン', value: `\`\`\`fix\n${targetRate.toFixed(1)}%\n\`\`\``, inline: true },
      { name: '残り', value: `\`\`\`${remaining <= 1 ? 'diff\n- ' : 'yaml\n'}${remaining.toFixed(1)}%\n\`\`\``, inline: true },
      { name: '経過時間', value: `\`\`\`\n${duration}\n\`\`\``, inline: true },
      { name: '━━━━━━━━━━ 📈 進捗 ━━━━━━━━━━', value: createProgressBar(progress), inline: false }
    )
    .setFooter({ text: `開始者: ${session.startedBy}` })
    .setTimestamp();
  
  await interaction.editReply({ embeds: [embed] });
}

// ===== /dam nowコマンド =====
async function handleNowCommand(interaction) {
  await interaction.deferReply();

  const data = await callGasApi('status');
    
  if (!data.success) {
    const errorEmbed = new EmbedBuilder()
      .setColor(COLORS.DANGER)
      .setTitle('❌ エラー')
      .setDescription('データの取得に失敗しました。')
      .setTimestamp();
    await interaction.editReply({ embeds: [errorEmbed] });
    return;
  }

  const current = data.current;

  const embed = new EmbedBuilder()
    .setColor(getRateColor(current.rate))
    .setAuthor({ name: '嘉瀬川ダム' })
    .setTitle(`${getRateEmoji(current.rate)} 現在の状況`)
    .setDescription(`\`\`\`観測日時: ${current.datetime}\`\`\``)
    .addFields(
      { name: '━━━━━━━━━ 💧 メイン情報 ━━━━━━━━━', value: '\u200B', inline: false },
      { name: '貯水率', value: `\`\`\`css\n${current.rate}%\n\`\`\``, inline: true },
      { name: '貯水量', value: `\`\`\`yaml\n${current.volume.toLocaleString()} 千m³\n\`\`\``, inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
      { name: '━━━━━━━━━ 🌊 流量情報 ━━━━━━━━━', value: '\u200B', inline: false },
      { name: '📥 流入量', value: `\`\`\`diff\n+ ${current.inflow} m³/s\n\`\`\``, inline: true },
      { name: '📤 放流量', value: `\`\`\`diff\n- ${current.outflow} m³/s\n\`\`\``, inline: true },
      { name: '\u200B', value: '\u200B', inline: true }
    )
    .setTimestamp();

  // 監視中ならセッション情報追加
  const sessionData = await callGasApi('session');
  if (sessionData.success && sessionData.session) {
    const session = sessionData.session;
    const change = current.rate - session.startRate;
    const remaining = current.rate - (session.startRate - CONFIG.ALERT_DECREASE);
    const changeDisplay = change >= 0 ? `+${change.toFixed(1)}` : change.toFixed(1);

    embed.addFields({
      name: '━━━━━━━━━ 🚣 監視中 ━━━━━━━━━',
      value: `\`\`\`diff\n開始時: ${session.startRate}% → 現在: ${current.rate}% (${changeDisplay}%)\n通知まで: あと ${remaining.toFixed(1)}%\n\`\`\``,
      inline: false
    });
  }
  
  await interaction.editReply({ embeds: [embed] });
}

// ===== /dam helpコマンド =====
async function handleHelpCommand(interaction) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.PRIMARY)
    .setTitle('🌊 嘉瀬川ダム監視Bot')
    .setDescription('```ボート部の桟橋が干上がらないように\nダムの貯水率を監視するBotです```')
    .addFields(
      { name: '━━━━━━━━━ 📋 コマンド一覧 ━━━━━━━━━', value: '\u200B', inline: false },
      { name: '🚣 `/dam start`', value: '```乗艇開始！監視をスタート\n再度実行するとリセット```', inline: false },
      { name: '📊 `/dam status`', value: '```現在の監視状態を確認\n通知までの残り%を表示```', inline: false },
      { name: '💧 `/dam now`', value: '```現在の貯水率・流量を表示```', inline: false },
      { name: '━━━━━━━━━ ⚙️ 仕組み ━━━━━━━━━', value: `\`\`\`1. /dam start で現在の貯水率を記録\n2. そこから ${CONFIG.ALERT_DECREASE}% 減少したら通知\n3. 再度 /dam start でリセット\n\`\`\``, inline: false }
    )
    .setFooter({ text: '🚣 安全な活動のために！' })
    .setTimestamp();
  await interaction.reply({ embeds: [embed] });
}

// ===== 定期監視（30分ごと） =====
cron.schedule('*/30 * * * *', async () => {
  console.log('🔄 定期チェック開始');
  // GASからセッション取得
  const sessionData = await callGasApi('session');
  if (!sessionData.success || !sessionData.session) {
    console.log('📭 セッションなし');
    return;
  }
  const session = sessionData.session;
  if (session.notified) {
    console.log('📨 通知済み');
    return;
  }
  const statusData = await callGasApi('status');
  if (!statusData.success) {
    console.log('❌ ステータス取得失敗');
    return;
  }
  const currentRate = statusData.current.rate;
  const decrease = session.startRate - currentRate;
  console.log(`📊 開始: ${session.startRate}% → 現在: ${currentRate}% (減少: ${decrease.toFixed(1)}%)`);
  if (decrease >= CONFIG.ALERT_DECREASE) {
    const channel = client.channels.cache.get(CONFIG.CHANNEL_ID);
    if (!channel) {
      console.log('❌ チャンネル取得失敗');
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(COLORS.DANGER)
      .setTitle('🚨 貯水率低下アラート')
      .setDescription('```diff\n- 基準値から4%以上低下しました！\n```')
      .addFields(
        { name: '━━━━━━━━ ⚠️ アラート情報 ━━━━━━━━', value: '\u200B', inline: false },
        { name: '開始時', value: `\`\`\`yaml\n${session.startRate}%\n\`\`\``, inline: true },
        { name: '現在', value: `\`\`\`css\n${currentRate}%\n\`\`\``, inline: true },
        { name: '減少', value: `\`\`\`diff\n- ${decrease.toFixed(1)}%\n\`\`\``, inline: true },
        { name: '━━━━━━━━━ 📝 対応事項 ━━━━━━━━━', value: '```\n⚠️ 桟橋の状態を確認してください\n```', inline: false }
      )
      .setFooter({ text: `監視開始者: ${session.startedBy}` })
      .setTimestamp();
    await channel.send({ content: '@everyone 🚨 **貯水率が基準値から4%低下しました！**', embeds: [embed] });
    // GASで通知済みフラグを更新
    await callGasApi('notify');
    console.log('✅ 通知完了');
  }
}, { timezone: 'Asia/Tokyo' });

// ===== 起動 =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.login(CONFIG.DISCORD_TOKEN);
