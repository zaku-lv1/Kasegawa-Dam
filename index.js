const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const cron = require('node-cron');
const http = require('http');

// ===== 1. Render用 Webサーバー (これが無いとRenderに落とされます) =====
const PORT = process.env.PORT || 10000;

// fetch polyfill（Node18未満なら必要）
if (typeof fetch === 'undefined') {
  global.fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
}

// Webサーバー起動＆その「完了」後にBotログイン
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'active' }));
}).listen(PORT, async () => {
  console.log(`🌐 Webサーバー起動完了 (Port: ${PORT})`);

  // 固定: 必要な環境変数が揃っているかチェック
  if (!CONFIG.DISCORD_TOKEN) {
    console.error('❌ DISCORD_TOKENが未設定です。Renderの管理画面または.envで確認してください。');
    process.exit(1);
  }
  try {
    console.log("🚨 ABOUT TO LOGIN DISCORD");
    await client.login(CONFIG.DISCORD_TOKEN);
    console.log("🚀 client.login() resolved");
  } catch (err) {
    console.error('❌ ログイン失敗:', err);
    process.exit(1);
  }
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

// ===== 4. GAS API 通信 (タイムアウト対策) =====
async function callGasApi(action, params = {}) {
  try {
    const url = new URL(CONFIG.GAS_API_URL);
    url.searchParams.append('action', action);
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
    
    // Node.jsの標準fetchを使用 (18以降)
    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`❌ GAS通信エラー (${action}):`, error.message);
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

// ===== 6. インタラクション処理 (強化版) =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'dam') return;

  // 1. まず、最速で deferReply を実行 (3秒ルール対策)
  try {
    await interaction.deferReply();
  } catch (e) {
    console.error("deferReply 失敗:", e);
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  try {
    // 2. タイムアウト付きでGASを呼び出すヘルパー (GASが重すぎる場合用)
    const fetchWithTimeout = async (action, params, timeout = 25000) => {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await callGasApi(action, params, controller.signal);
        clearTimeout(id);
        return res;
      } catch (err) {
        clearTimeout(id);
        throw err;
      }
    };

    if (subcommand === 'start') {
      const data = await fetchWithTimeout('start', { username: interaction.user.username });
      if (!data.success) throw new Error('GASからの応答が異常です');

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
      // 複数を同時に待つ際、GASが遅いとここで詰まるので注意
      const [sData, stData] = await Promise.all([
        fetchWithTimeout('session'),
        fetchWithTimeout('status')
      ]);

      if (!sData.success || !sData.session) {
        return await interaction.editReply('📊 現在、アクティブな監視セッションはありません。`/dam start` で開始してください。');
      }
      
      const session = sData.session;
      const cur = stData.current;
      const change = cur.rate - session.startRate;
      const progress = Math.min(100, Math.max(0, (Math.abs(change) / CONFIG.ALERT_DECREASE) * 100));

      const embed = new EmbedBuilder()
        .setColor(cur.rate <= (session.startRate - CONFIG.ALERT_DECREASE) ? COLORS.DANGER : COLORS.SUCCESS)
        .setTitle('📊 監視ステータス')
        .addFields(
          { name: '開始時', value: `\`${session.startRate}%\``, inline: true },
          { name: '現在', value: `\`${cur.rate}%\``, inline: true },
          { name: '経過時間', value: `\`${formatDuration(session.startTime)}\``, inline: true },
          { name: '進捗', value: createProgressBar(progress) }
        ).setFooter({ text: `開始者: ${session.startedBy}` });

      await interaction.editReply({ embeds: [embed] });

    } else if (subcommand === 'now') {
      const data = await fetchWithTimeout('status');
      if (!data.success) throw new Error('データ取得失敗');
      
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
    console.error("処理エラー:", error);
    // ユーザーにエラーを通知（すでにdeferしているのでeditReplyを使う）
    const errorMsg = error.name === 'AbortError' 
      ? '⌛ GASの応答がタイムアウトしました。しばらく経ってから再度お試しください。'
      : '❌ データの取得中にエラーが発生しました。';
    
    await interaction.editReply({ content: errorMsg }).catch(() => null);
  }
});

// callGasApiに関数引数を追加できるように修正
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
