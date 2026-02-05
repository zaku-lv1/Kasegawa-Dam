const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const cron = require('node-cron');
const http = require('http');

// ===== 重要なエラーハンドリング =====
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', reason));

// ===== HTTPサーバー (Uptime用) =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', bot: '嘉瀬川ダム監視Bot', uptime: process.uptime() }));
}).listen(PORT, '0.0.0.0', () => console.log(`🌐 Server listening on port ${PORT}`));

// ===== 設定 =====
const CONFIG = {
  GAS_API_URL: process.env.GAS_API_URL,
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  CHANNEL_ID: process.env.CHANNEL_ID,
  ALERT_DECREASE: 4.0
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ★変更点: ローカル変数はあくまでキャッシュとして使い、常にGASと同期する意識を持つ
let localSessionCache = null;

// ===== カラーパレット =====
const COLORS = {
  PRIMARY: 0x3498DB, SUCCESS: 0x2ECC71, WARNING: 0xF39C12,
  DANGER: 0xE74C3C, WATER: 0x00CED1
};

// ===== スラッシュコマンド定義 =====
const commands = [
  new SlashCommandBuilder().setName('dam').setDescription('嘉瀬川ダム情報')
    .addSubcommand(sub => sub.setName('start').setDescription('🚣 監視スタート（GASに保存）'))
    .addSubcommand(sub => sub.setName('status').setDescription('📊 監視状態を確認'))
    .addSubcommand(sub => sub.setName('now').setDescription('💧 現在の貯水率'))
    .addSubcommand(sub => sub.setName('help').setDescription('❓ ヘルプ'))
].map(cmd => cmd.toJSON());

// ===== コマンド登録 =====
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: commands });
    console.log('✅ コマンド登録完了');
  } catch (error) { console.error('コマンド登録エラー:', error); }
}

// ===== GAS API (タイムアウト付き) =====
async function callGasApi(action, params = {}) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15秒待ち
    
    // クエリパラメータの構築
    const url = new URL(CONFIG.GAS_API_URL);
    url.searchParams.append('action', action);
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`API Error (${action}):`, error.message);
    return { success: false, error: error.message };
  }
}

// ===== コマンド処理 =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'dam') return;

  const subcommand = interaction.options.getSubcommand();

  try {
    if (subcommand === 'start') await handleStartCommand(interaction);
    else if (subcommand === 'status') await handleStatusCommand(interaction);
    else if (subcommand === 'now') await handleNowCommand(interaction);
    else if (subcommand === 'help') await handleHelpCommand(interaction);
  } catch (e) {
    console.error(e);
    const msg = { content: 'エラーが発生しました', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.editReply(msg);
    else await interaction.reply(msg);
  }
});

// ===== /dam start =====
async function handleStartCommand(interaction) {
  await interaction.deferReply();
  
  // GASの start アクションを叩く（GAS側でsessionが保存される）
  const data = await callGasApi('start', { username: interaction.user.username });
  
  if (!data.success) {
    await interaction.editReply({ content: `❌ エラー: ${data.error}` });
    return;
  }

  // ローカルキャッシュを更新
  localSessionCache = data.session;
  
  const currentRate = data.current.rate;
  const targetRate = (currentRate - CONFIG.ALERT_DECREASE).toFixed(1);
  const isReset = data.isReset;

  const embed = new EmbedBuilder()
    .setColor(isReset ? COLORS.WARNING : COLORS.WATER)
    .setTitle(isReset ? '🔄 監視リセット' : '🚣 乗艇開始')
    .setDescription(`GASにセッションを保存しました。\n現在の貯水率: **${currentRate}%**\n通知ライン: **${targetRate}%**`)
    .setFooter({ text: `実行者: ${interaction.user.username}` });

  await interaction.editReply({ embeds: [embed] });
}

// ===== /dam status =====
async function handleStatusCommand(interaction) {
  await interaction.deferReply();

  // ★重要: 表示する前にGASから最新のセッション情報を取る
  const sessionData = await callGasApi('session');
  const statusData = await callGasApi('status');

  if (!sessionData.success || !sessionData.session) {
    await interaction.editReply({ content: '現在、監視セッションは開始されていません。\n`/dam start` で開始してください。' });
    return;
  }
  if (!statusData.success) {
    await interaction.editReply({ content: '現在のダム情報の取得に失敗しました。' });
    return;
  }

  localSessionCache = sessionData.session; // キャッシュ更新
  const session = sessionData.session;
  const currentRate = statusData.current.rate;
  
  const decrease = session.startRate - currentRate;
  const remaining = currentRate - (session.startRate - CONFIG.ALERT_DECREASE);

  const embed = new EmbedBuilder()
    .setColor(COLORS.INFO)
    .setTitle('📊 監視ステータス')
    .addFields(
      { name: '開始時', value: `${session.startRate}%`, inline: true },
      { name: '現在', value: `${currentRate}%`, inline: true },
      { name: '変動', value: `${decrease > 0 ? '-' : '+'}${Math.abs(decrease).toFixed(1)}%`, inline: true },
      { name: '通知まで', value: remaining > 0 ? `あと ${remaining.toFixed(1)}%` : '🚨 通知圏内', inline: true }
    )
    .setFooter({ text: `開始日時: ${new Date(session.startTime).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}` });

  await interaction.editReply({ embeds: [embed] });
}

// ===== /dam now =====
async function handleNowCommand(interaction) {
  await interaction.deferReply();
  const data = await callGasApi('status');
  if (!data.success) {
    await interaction.editReply('データの取得に失敗しました。');
    return;
  }
  
  const current = data.current;
  const embed = new EmbedBuilder()
    .setColor(current.rate >= 50 ? COLORS.SUCCESS : COLORS.WARNING)
    .setTitle('💧 現在の嘉瀬川ダム')
    .setDescription(`貯水率: **${current.rate}%**\n流入: ${current.inflow} m³/s\n放流: ${current.outflow} m³/s`)
    .setFooter({ text: `観測: ${current.datetime}` });

  await interaction.editReply({ embeds: [embed] });
}

// ===== /dam help (簡易版) =====
async function handleHelpCommand(interaction) {
  await interaction.reply({ 
    content: '**嘉瀬川ダム監視Bot**\n`/dam start` : 監視開始\n`/dam status` : 状態確認\n`/dam now` : 今の水位',
    ephemeral: true 
  });
}

// ===== 自動監視（Cron） =====
cron.schedule('*/30 * * * *', async () => {
  console.log('[Cron] Checking status...');

  // 1. GASからセッション情報を取得（Renderが再起動していてもこれで復活する）
  const sessionData = await callGasApi('session');
  if (!sessionData.success || !sessionData.session) {
    console.log('[Cron] No active session.');
    localSessionCache = null;
    return;
  }
  
  const session = sessionData.session;
  localSessionCache = session; // キャッシュ更新

  // 既に通知済みなら何もしない
  if (session.notified) {
    console.log('[Cron] Already notified.');
    return;
  }

  // 2. 現在のダム情報を取得
  const statusData = await callGasApi('status');
  if (!statusData.success) {
    console.error('[Cron] Failed to fetch dam status.');
    return;
  }

  const currentRate = statusData.current.rate;
  const decrease = session.startRate - currentRate;

  // 3. 判定ロジック
  if (decrease >= CONFIG.ALERT_DECREASE) {
    const channel = client.channels.cache.get(CONFIG.CHANNEL_ID);
    if (channel) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.DANGER)
        .setTitle('🚨 貯水率低下アラート')
        .setDescription(`基準値より **${decrease.toFixed(1)}%** 低下しました！\n桟橋の位置を確認してください。`)
        .addFields(
            { name: '開始時', value: `${session.startRate}%`, inline: true },
            { name: '現在', value: `${currentRate}%`, inline: true }
        );

      await channel.send({ content: '@everyone', embeds: [embed] });
      
      // 4. GASに「通知済み」状態を保存（再通知を防ぐ）
      await callGasApi('notify');
      console.log('🚨 Alert sent and saved to GAS.');
    }
  } else {
    console.log(`[Cron] Safe. Decrease: ${decrease.toFixed(1)}%`);
  }
}, { timezone: 'Asia/Tokyo' });


// ===== 起動処理 =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  // 起動時に現在のセッション状態をチェック（ログ用）
  const sessionCheck = await callGasApi('session');
  if (sessionCheck.success && sessionCheck.session) {
    console.log('🔄 既存のセッションを復元しました:', sessionCheck.session);
    localSessionCache = sessionCheck.session;
  }
  await registerCommands();
});

client.login(CONFIG.DISCORD_TOKEN);
