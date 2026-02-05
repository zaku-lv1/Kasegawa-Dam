const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const cron = require('node-cron');
const http = require('http');

// ===== 1. エラーハンドリング (プロセス停止を徹底防止) =====
process.on('uncaughtException', (err) => {
    console.error('❌ 未処理の例外が発生しました:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ 未処理の Promise 拒否:', reason);
});

// ===== 2. HTTPサーバー (Renderのスリープ防止 / ヘルスチェック用) =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ 
    status: 'ok', 
    bot: 'Kasegawa Dam Monitor',
    uptime: Math.floor(process.uptime()) + 's'
  }));
}).listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Webサーバーが起動しました。Port: ${PORT}`);
});

// ===== 3. 設定と定数 =====
const CONFIG = {
  GAS_API_URL: process.env.GAS_API_URL,
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  CHANNEL_ID: process.env.CHANNEL_ID,
  ALERT_DECREASE: 4.0 // 4%低下でアラート
};

const COLORS = {
  PRIMARY: 0x3498DB,  // 青
  SUCCESS: 0x2ECC71,  // 緑
  WARNING: 0xF39C12,  // オレンジ
  DANGER: 0xE74C3C,   // 赤
  INFO: 0x9B59B6,     // 紫
  DARK: 0x2C3E50,     // 紺
  WATER: 0x00CED1     // 水色
};

// 環境変数チェック
if (!CONFIG.DISCORD_TOKEN || !CONFIG.GAS_API_URL || !CONFIG.CLIENT_ID) {
  console.error("⚠️ 警告: 環境変数が不足しています。Renderの設定を確認してください。");
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ===== 4. スラッシュコマンド定義 =====
const commands = [
  new SlashCommandBuilder()
    .setName('dam')
    .setDescription('嘉瀬川ダム監視システム')
    .addSubcommand(sub => 
      sub.setName('start').setDescription('🚣 乗艇開始：現在の貯水率を基準として監視を開始します')
    )
    .addSubcommand(sub => 
      sub.setName('status').setDescription('📊 監視状態：開始時からの変化と通知までの残りを確認します')
    )
    .addSubcommand(sub => 
      sub.setName('now').setDescription('💧 現在の状況：ダムの最新データを表示します')
    )
    .addSubcommand(sub => 
      sub.setName('help').setDescription('❓ ヘルプ：コマンドの使い方を確認します')
    )
].map(cmd => cmd.toJSON());

// ===== 5. GAS API 通信専用関数 (リトライ・タイムアウト対策済) =====
async function callGasApi(action, params = {}) {
  try {
    const url = new URL(CONFIG.GAS_API_URL);
    url.searchParams.append('action', action);
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // GASが遅いため20秒待機

    const response = await fetch(url.toString(), { 
        method: 'GET',
        signal: controller.signal 
    });
    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`HTTPステータス: ${response.status}`);
    const json = await response.json();
    return json;
  } catch (error) {
    console.error(`❌ GAS API通信エラー (${action}):`, error.message);
    return { success: false, error: error.message };
  }
}

// ===== 6. インタラクション処理 (3秒ルール完全回避) =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'dam') return;

  // 【重要】3秒以内にDiscordにレスポンスを予約する（これでタイムアウトを回避）
  try {
    await interaction.deferReply();
  } catch (e) {
    console.error("deferReply失敗:", e);
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  try {
    if (subcommand === 'start') {
      await handleStartCommand(interaction);
    } else if (subcommand === 'status') {
      await handleStatusCommand(interaction);
    } else if (subcommand === 'now') {
      await handleNowCommand(interaction);
    } else if (subcommand === 'help') {
      await handleHelpCommand(interaction);
    }
  } catch (error) {
    console.error(`コマンド実行エラー (${subcommand}):`, error);
    if (interaction.deferred) {
      await interaction.editReply({ content: '⚠️ 内部エラーが発生しました。時間を置いて再度お試しください。' });
    }
  }
});

// --- コマンド詳細処理 (省略なし) ---

async function handleStartCommand(interaction) {
  const data = await callGasApi('start', { username: interaction.user.username });
  
  if (!data.success) {
    return await interaction.editReply(`❌ 監視の開始に失敗しました。GAS側でエラーが発生しています。\n理由: ${data.error}`);
  }

  const cur = data.current;
  const targetRate = (cur.rate - CONFIG.ALERT_DECREASE).toFixed(1);

  const embed = new EmbedBuilder()
    .setColor(data.isReset ? COLORS.WARNING : COLORS.WATER)
    .setTitle(data.isReset ? '🔄 監視セッションのリセット' : '🚣 監視セッションの開始')
    .setDescription(data.isReset ? '既存の監視を上書きしました。' : '新しい監視を開始しました。30分ごとに水位をチェックします。')
    .addFields(
      { name: '基準貯水率', value: `\`${cur.rate}%\``, inline: true },
      { name: '通知ライン', value: `\`${targetRate}%\``, inline: true },
      { name: '判定基準', value: `\`-${CONFIG.ALERT_DECREASE}%\``, inline: true }
    )
    .setFooter({ text: `実行者: ${interaction.user.username}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleStatusCommand(interaction) {
  // 並列でデータを取得して高速化
  const [sessionData, statusData] = await Promise.all([
    callGasApi('session'),
    callGasApi('status')
  ]);

  if (!sessionData.success || !sessionData.session) {
    return await interaction.editReply('📊 現在、動いている監視セッションはありません。`/dam start` で開始してください。');
  }

  const session = sessionData.session;
  const cur = statusData.current;
  
  // 貯水率の変化を計算
  const decrease = (session.startRate - cur.rate).toFixed(1);
  const remaining = (cur.rate - (session.startRate - CONFIG.ALERT_DECREASE)).toFixed(1);

  const embed = new EmbedBuilder()
    .setColor(remaining <= 0 ? COLORS.DANGER : COLORS.SUCCESS)
    .setTitle('📊 現在の監視ステータス')
    .addFields(
      { name: '監視開始時', value: `\`${session.startRate}%\``, inline: true },
      { name: '現在の貯水率', value: `\`${cur.rate}%\``, inline: true },
      { name: '開始からの変動', value: `\`${decrease > 0 ? '-' : '+'}${Math.abs(decrease)}%\``, inline: true },
      { name: '通知まで残り', value: remaining > 0 ? `あと \`${remaining}%\`` : '🚨 通知ライン到達済', inline: false }
    )
    .setFooter({ text: `監視開始者: ${session.startedBy}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleNowCommand(interaction) {
  const data = await callGasApi('status');
  
  if (!data.success) {
    return await interaction.editReply('❌ 最新データの取得に失敗しました。ダムサイトが混み合っている可能性があります。');
  }

  const cur = data.current;
  const embed = new EmbedBuilder()
    .setColor(COLORS.PRIMARY)
    .setTitle('🌊 嘉瀬川ダム リアルタイム現況')
    .addFields(
      { name: '現在の貯水率', value: `\`${cur.rate}%\``, inline: true },
      { name: '貯水量', value: `\`${cur.volume.toLocaleString()} 千m³\``, inline: true },
      { name: '流入量', value: `\`${cur.inflow} m³/s\``, inline: true },
      { name: '放流量', value: `\`${cur.outflow} m³/s\``, inline: true }
    )
    .setFooter({ text: `観測時刻: ${cur.datetime}` });

  await interaction.editReply({ embeds: [embed] });
}

async function handleHelpCommand(interaction) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.DARK)
    .setTitle('❓ 嘉瀬川ダム監視Bot 使い方')
    .addFields(
      { name: '`/dam start`', value: '乗艇開始時に使用。現在の水位を「基準値」として保存し、監視を開始します。' },
      { name: '`/dam status`', value: '現在の水位が基準値からどれくらい減ったか、アラートまであと何％かを表示します。' },
      { name: '`/dam now`', value: '監視とは関係なく、現在のダムの最新情報を表示します。' },
      { name: '自動通知について', value: '監視開始後、30分ごとにチェックを行い、基準値から4.0%低下すると自動で@everyone通知を飛ばします。' }
    );
  await interaction.editReply({ embeds: [embed] });
}

// ===== 7. 自動監視タスク (30分ごとのCron) =====
cron.schedule('*/30 * * * *', async () => {
  console.log('[定期監視] チェックを開始します...');
  
  if (!CONFIG.CHANNEL_ID) {
    console.log('[定期監視] CHANNEL_IDが未設定のため、通知をスキップします。');
    return;
  }

  // GASからセッション情報を取得
  const sessionData = await callGasApi('session');
  if (!sessionData.success || !sessionData.session || sessionData.session.notified) {
    console.log('[定期監視] アクティブな未通知セッションがないため、終了します。');
    return;
  }

  // 現在の貯水率を取得
  const statusData = await callGasApi('status');
  if (!statusData.success) return;

  const session = sessionData.session;
  const currentRate = statusData.current.rate;
  const decrease = session.startRate - currentRate;

  // 4%以上の低下を検知した場合
  if (decrease >= CONFIG.ALERT_DECREASE) {
    try {
      const channel = await client.channels.fetch(CONFIG.CHANNEL_ID);
      if (channel) {
        const embed = new EmbedBuilder()
          .setColor(COLORS.DANGER)
          .setTitle('🚨 【警告】貯水率低下アラート')
          .setDescription(`基準値(${session.startRate}%)から **${decrease.toFixed(1)}%** 低下しました。\n桟橋が干上がる恐れがあるため、状態を確認してください。`)
          .addFields(
            { name: '開始時', value: `${session.startRate}%`, inline: true },
            { name: '現在', value: `${currentRate}%`, inline: true }
          )
          .setTimestamp();

        await channel.send({ 
            content: `@everyone 🚨 **嘉瀬川ダムの水位が危険域まで低下しています！**`, 
            embeds: [embed] 
        });
        
        // GAS側を「通知済み」に更新して、何度も通知が飛ばないようにする
        await callGasApi('notify');
        console.log('🚨 アラート送信完了');
      }
    } catch (err) {
      console.error('❌ 通知送信エラー:', err);
    }
  } else {
    console.log(`[定期監視] 異常なし (減少幅: ${decrease.toFixed(1)}%)`);
  }
}, { timezone: 'Asia/Tokyo' });

// ===== 8. 起動とコマンド登録 =====
async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
  try {
    console.log('🔄 スラッシュコマンドを登録しています...');
    await rest.put(
      Routes.applicationCommands(CONFIG.CLIENT_ID),
      { body: commands },
    );
    console.log('✅ スラッシュコマンドの登録に成功しました');
  } catch (error) {
    console.error('❌ コマンド登録エラー:', error);
  }
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerSlashCommands();
});

client.login(CONFIG.DISCORD_TOKEN);
