const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const cron = require('node-cron');
const http = require('http');

// ===== 1. エラーハンドリング (プロセス停止防止) =====
process.on('uncaughtException', (err) => {
    console.error('❌ 未処理の例外:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ 未処理の拒否:', reason);
});

// ===== 2. HTTPサーバー (Renderのスリープ防止 / UptimeRobot用) =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ 
    status: 'ok', 
    bot: '嘉瀬川ダム監視Bot',
    uptime: process.uptime() 
  }));
}).listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 サーバーがポート ${PORT} で待機中...`);
});

// ===== 3. 設定確認 =====
const CONFIG = {
  GAS_API_URL: process.env.GAS_API_URL,
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  CHANNEL_ID: process.env.CHANNEL_ID,
  ALERT_DECREASE: 4.0
};

// 必須項目のチェック
if (!CONFIG.DISCORD_TOKEN || !CONFIG.GAS_API_URL) {
  console.error("❌ 環境変数が不足しています。RENDERの設定を確認してください。");
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const COLORS = {
  PRIMARY: 0x3498DB,
  SUCCESS: 0x2ECC71,
  WARNING: 0xF39C12,
  DANGER: 0xE74C3C,
  INFO: 0x9B59B6,
  DARK: 0x2C3E50,
  WATER: 0x00CED1
};

// ===== 4. スラッシュコマンド定義 =====
const commands = [
  new SlashCommandBuilder()
    .setName('dam')
    .setDescription('嘉瀬川ダム監視コマンド')
    .addSubcommand(sub => 
      sub.setName('start').setDescription('🚣 乗艇開始！監視をスタート（GASに状態を保存）')
    )
    .addSubcommand(sub => 
      sub.setName('status').setDescription('📊 監視状態を確認（再起動後もGASから復元）')
    )
    .addSubcommand(sub => 
      sub.setName('now').setDescription('💧 現在の貯水率を表示')
    )
    .addSubcommand(sub => 
      sub.setName('help').setDescription('❓ ヘルプを表示')
    )
].map(cmd => cmd.toJSON());

// ===== 5. GAS API 連携共通関数 =====
async function callGasApi(action, params = {}) {
  try {
    const url = new URL(CONFIG.GAS_API_URL);
    url.searchParams.append('action', action);
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15秒でタイムアウト

    const response = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`HTTPエラー: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`❌ GAS API通信エラー (${action}):`, error.message);
    return { success: false, error: error.message };
  }
}

// ===== 6. インタラクション処理 (3秒ルール完全対策) =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'dam') return;

  // 【重要】即座に応答を予約。これで「インタラクションに失敗しました」を防ぐ
  try {
    await interaction.deferReply();
  } catch (e) {
    console.error("deferReply失敗:", e);
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  try {
    switch (subcommand) {
      case 'start':
        await handleStartCommand(interaction);
        break;
      case 'status':
        await handleStatusCommand(interaction);
        break;
      case 'now':
        await handleNowCommand(interaction);
        break;
      case 'help':
        await handleHelpCommand(interaction);
        break;
    }
  } catch (error) {
    console.error('コマンド実行中エラー:', error);
    await interaction.editReply('⚠️ 内部エラーが発生しました。');
  }
});

// --- コマンド実行関数群 ---

async function handleStartCommand(interaction) {
  const data = await callGasApi('start', { username: interaction.user.username });
  
  if (!data.success) {
    return interaction.editReply(`❌ 監視の開始に失敗しました: ${data.error}`);
  }

  const cur = data.current;
  const targetRate = (cur.rate - CONFIG.ALERT_DECREASE).toFixed(1);

  const embed = new EmbedBuilder()
    .setColor(data.isReset ? COLORS.WARNING : COLORS.WATER)
    .setTitle(data.isReset ? '🔄 監視リセット' : '🚣 監視開始')
    .setDescription(data.isReset ? '既存の監視をリセットし、再開しました。' : '本日の監視を開始しました。')
    .addFields(
      { name: '基準貯水率', value: `\`${cur.rate}%\``, inline: true },
      { name: '通知ライン', value: `\`${targetRate}%\``, inline: true },
      { name: '許容減少量', value: `\`-${CONFIG.ALERT_DECREASE}%\``, inline: true }
    )
    .setFooter({ text: `実行者: ${interaction.user.username}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleStatusCommand(interaction) {
  // セッションと現在の状況を両方取得
  const [sessionData, statusData] = await Promise.all([
    callGasApi('session'),
    callGasApi('status')
  ]);

  if (!sessionData.success || !sessionData.session) {
    return interaction.editReply('📊 アクティブな監視はありません。`/dam start` で開始してください。');
  }

  const session = sessionData.session;
  const cur = statusData.current;
  const decrease = (session.startRate - cur.rate).toFixed(1);
  const remaining = (cur.rate - (session.startRate - CONFIG.ALERT_DECREASE)).toFixed(1);

  const embed = new EmbedBuilder()
    .setColor(remaining <= 0 ? COLORS.DANGER : COLORS.SUCCESS)
    .setTitle('📊 監視ステータス')
    .addFields(
      { name: '開始時', value: `\`${session.startRate}%\``, inline: true },
      { name: '現在', value: `\`${cur.rate}%\``, inline: true },
      { name: '変動', value: `\`${decrease > 0 ? '-' : '+'}${Math.abs(decrease)}%\``, inline: true },
      { name: '通知まで', value: remaining > 0 ? `あと \`${remaining}%\`` : '🚨 通知ライン到達', inline: false }
    )
    .setFooter({ text: `開始者: ${session.startedBy}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleNowCommand(interaction) {
  const data = await callGasApi('status');
  if (!data.success) return interaction.editReply('❌ データの取得に失敗しました。');

  const cur = data.current;
  const embed = new EmbedBuilder()
    .setColor(COLORS.PRIMARY)
    .setTitle('🌊 嘉瀬川ダム 現在の状況')
    .addFields(
      { name: '貯水率', value: `\`${cur.rate}%\``, inline: true },
      { name: '貯水量', value: `\`${cur.volume.toLocaleString()} 千m³\``, inline: true },
      { name: '流入量', value: `\`+${cur.inflow} m³/s\``, inline: true },
      { name: '放流量', value: `\`-${cur.outflow} m³/s\``, inline: true }
    )
    .setFooter({ text: `観測日時: ${cur.datetime}` });

  await interaction.editReply({ embeds: [embed] });
}

async function handleHelpCommand(interaction) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.DARK)
    .setTitle('❓ 使い方ヘルプ')
    .setDescription('ボート部の活動を支えるダム監視Botです。')
    .addFields(
      { name: '`/dam start`', value: '乗艇時の水位を基準として記録し、監視を始めます。' },
      { name: '`/dam status`', value: '開始時からの水位の変化と、通知までの残りを確認します。' },
      { name: '`/dam now`', value: '現在のダムの貯水率と流量をリアルタイム表示します。' }
    )
    .setFooter({ text: '※30分ごとに自動チェックし、4%低下で@everyone通知します。' });

  await interaction.editReply({ embeds: [embed] });
}

// ===== 7. 自動監視タスク (30分ごと) =====
cron.schedule('*/30 * * * *', async () => {
  console.log('[定期監視] 実行中...');
  
  // GASからセッション取得（Renderが再起動していてもGASから復元される）
  const sessionData = await callGasApi('session');
  if (!sessionData.success || !sessionData.session || sessionData.session.notified) {
    return; // セッションなし、または通知済みなら終了
  }

  const statusData = await callGasApi('status');
  if (!statusData.success) return;

  const session = sessionData.session;
  const cur = statusData.current;
  const decrease = session.startRate - cur.rate;

  if (decrease >= CONFIG.ALERT_DECREASE) {
    const channel = client.channels.cache.get(CONFIG.CHANNEL_ID);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(COLORS.DANGER)
      .setTitle('🚨 貯水率低下アラート')
      .setDescription(`基準値(${session.startRate}%)から **${decrease.toFixed(1)}%** 低下しました。\n桟橋の状態を確認してください。`)
      .setTimestamp();

    await channel.send({ 
        content: `@everyone 🚨 **貯水率が${CONFIG.ALERT_DECREASE}%以上減少しました！**`, 
        embeds: [embed] 
    });
    
    // GAS側を通知済みに更新
    await callGasApi('notify');
    console.log('🚨 アラートを送信し、GASの状態を更新しました。');
  }
}, { timezone: 'Asia/Tokyo' });

// ===== 8. 起動処理 =====
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
  try {
    console.log('🔄 スラッシュコマンドを同期中...');
    await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: commands });
    console.log('✅ スラッシュコマンド同期完了');
  } catch (e) {
    console.error('❌ コマンド登録エラー:', e);
  }
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.login(CONFIG.DISCORD_TOKEN);
