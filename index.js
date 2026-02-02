const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const cron = require('node-cron');

// 設定
const CONFIG = {
  GAS_API_URL: process.env.GAS_API_URL,
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  CHANNEL_ID: process.env.CHANNEL_ID,
  ALERT_DECREASE: 4.0
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// セッション管理
let boatSession = null;

// ===== カラーパレット =====
const COLORS = {
  PRIMARY: 0x3498DB,    // 青
  SUCCESS: 0x2ECC71,    // 緑
  WARNING: 0xF39C12,    // オレンジ
  DANGER: 0xE74C3C,     // 赤
  INFO: 0x9B59B6,       // 紫
  DARK: 0x2C3E50,       // ダークブルー
  WATER: 0x00CED1       // ターコイズ
};

// ===== スラッシュコマンド定義 =====

const commands = [
  new SlashCommandBuilder()
    .setName('dam')
    .setDescription('嘉瀬川ダムの情報を取得')
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('🚣 乗艇開始！監視スタート（再実行でリセット）')
    )
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('📊 現在の監視状態を確認')
    )
    .addSubcommand(sub =>
      sub.setName('now')
        .setDescription('💧 現在の貯水率を表示')
    )
    .addSubcommand(sub =>
      sub.setName('help')
        .setDescription('❓ ヘルプを表示')
    )
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

// ===== GAS API =====

async function callGasApi(action) {
  try {
    const response = await fetch(`${CONFIG.GAS_API_URL}?action=${action}`);
    return await response.json();
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ===== コマンド処理 =====

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'dam') return;
  
  const subcommand = interaction.options.getSubcommand();
  
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
});

// ===== /dam start =====

async function handleStartCommand(interaction) {
  await interaction.deferReply();
  
  const data = await callGasApi('status');
  
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
  const username = interaction.user.username;
  const userAvatar = interaction.user.displayAvatarURL();
  const isReset = boatSession !== null;
  
  boatSession = {
    startRate: currentRate,
    startTime: new Date().toISOString(),
    startedBy: username,
    notified: false
  };
  
  const targetRate = (currentRate - CONFIG.ALERT_DECREASE).toFixed(1);
  const progressBar = createProgressBar(0);
  
  const embed = new EmbedBuilder()
    .setColor(isReset ? COLORS.WARNING : COLORS.WATER)
    .setAuthor({ 
      name: isReset ? '🔄 監視���セット' : '🚣 乗艇開始',
      iconURL: userAvatar
    })
    .setTitle('嘉瀬川ダム監視システム')
    .setDescription(
      isReset 
        ? '```監視をリセットしました```'
        : '```監視を開始しました```'
    )
    .addFields(
      { 
        name: '━━━━━━━━━━ 📍 基準値 ━━━━━━━━━━', 
        value: '\u200B',
        inline: false 
      },
      { 
        name: '現在の貯水率', 
        value: `\`\`\`css\n${currentRate}%\n\`\`\``, 
        inline: true 
      },
      { 
        name: '通知ライン', 
        value: `\`\`\`fix\n${targetRate}%\n\`\`\``, 
        inline: true 
      },
      { 
        name: '減少許容', 
        value: `\`\`\`diff\n- ${CONFIG.ALERT_DECREASE}%\n\`\`\``, 
        inline: true 
      },
      {
        name: '━━━━━━━━━━ 📊 進捗 ━━━━━━━━━━',
        value: progressBar,
        inline: false
      }
    )
    .setFooter({ 
      text: `実行者: ${username} • 再度 /dam start でリセット`,
      iconURL: userAvatar
    })
    .setTimestamp();
  
  await interaction.editReply({ embeds: [embed] });
}

// ===== /dam status =====

async function handleStatusCommand(interaction) {
  if (!boatSession) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.DARK)
      .setTitle('📊 監視ステータス')
      .setDescription('```現在、監視は開始されていません```')
      .addFields({
        name: '💡 ヒント',
        value: '`/dam start` で監視を開始できます',
        inline: false
      })
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
    return;
  }
  
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
  
  const currentRate = data.current.rate;
  const startRate = boatSession.startRate;
  const targetRate = startRate - CONFIG.ALERT_DECREASE;
  const change = currentRate - startRate;
  const remaining = currentRate - targetRate;
  const progress = Math.min(100, Math.max(0, (Math.abs(change) / CONFIG.ALERT_DECREASE) * 100));
  const duration = formatDuration(Date.now() - new Date(boatSession.startTime).getTime());
  
  // 状態に応じた色とステータス
  let color, statusIcon, statusText;
  
  if (boatSession.notified || remaining <= 0) {
    color = COLORS.DANGER;
    statusIcon = '🚨';
    statusText = '通知済み';
  } else if (remaining <= 1) {
    color = COLORS.WARNING;
    statusIcon = '⚠️';
    statusText = 'まもなく通知';
  } else if (remaining <= 2) {
    color = COLORS.WARNING;
    statusIcon = '📢';
    statusText = '注意';
  } else {
    color = COLORS.SUCCESS;
    statusIcon = '✅';
    statusText = '正常';
  }
  
  const progressBar = createProgressBar(progress);
  const changeDisplay = change >= 0 ? `+${change.toFixed(1)}` : change.toFixed(1);
  
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('📊 監視ステータス')
    .setDescription(`\`\`\`${statusIcon} ステータス: ${statusText}\`\`\``)
    .addFields(
      {
        name: '━━━━━━━━━ 💧 貯水率情報 ━━━━━━━━━',
        value: '\u200B',
        inline: false
      },
      {
        name: '開始時',
        value: `\`\`\`yaml\n${startRate}%\n\`\`\``,
        inline: true
      },
      {
        name: '現在',
        value: `\`\`\`css\n${currentRate}%\n\`\`\``,
        inline: true
      },
      {
        name: '変化',
        value: `\`\`\`diff\n${changeDisplay}%\n\`\`\``,
        inline: true
      },
      {
        name: '━━━━━━━━━━ 🎯 通知まで ━━━━━━━━━━',
        value: '\u200B',
        inline: false
      },
      {
        name: '通知ライン',
        value: `\`\`\`fix\n${targetRate.toFixed(1)}%\n\`\`\``,
        inline: true
      },
      {
        name: '残り',
        value: `\`\`\`${remaining <= 1 ? 'diff\n- ' : 'yaml\n'}${remaining.toFixed(1)}%\n\`\`\``,
        inline: true
      },
      {
        name: '経過時間',
        value: `\`\`\`\n${duration}\n\`\`\``,
        inline: true
      },
      {
        name: '━━━━━━━━━━ 📈 進捗 ━━━━━━━━━━',
        value: progressBar,
        inline: false
      }
    )
    .setFooter({ text: `開始者: ${boatSession.startedBy}` })
    .setTimestamp();
  
  await interaction.editReply({ embeds: [embed] });
}

// ===== /dam now =====

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
  const rateColor = getRateColor(current.rate);
  const rateEmoji = getRateEmoji(current.rate);
  
  const embed = new EmbedBuilder()
    .setColor(rateColor)
    .setAuthor({
      name: '嘉瀬川ダム',
      iconURL: 'https://www.mlit.go.jp/favicon.ico'
    })
    .setTitle(`${rateEmoji} 現在の状況`)
    .setDescription(`\`\`\`観測日時: ${current.datetime}\`\`\``)
    .addFields(
      {
        name: '━━━━━━━━━ 💧 メイン情報 ━━━━━━━━━',
        value: '\u200B',
        inline: false
      },
      {
        name: '貯水率',
        value: `\`\`\`css\n${current.rate}%\n\`\`\``,
        inline: true
      },
      {
        name: '貯水量',
        value: `\`\`\`yaml\n${current.volume.toLocaleString()} 千m³\n\`\`\``,
        inline: true
      },
      {
        name: '\u200B',
        value: '\u200B',
        inline: true
      },
      {
        name: '━━━━━━━━━ 🌊 流量情報 ━━━━━━━━━',
        value: '\u200B',
        inline: false
      },
      {
        name: '📥 流入量',
        value: `\`\`\`diff\n+ ${current.inflow} m³/s\n\`\`\``,
        inline: true
      },
      {
        name: '📤 放流量',
        value: `\`\`\`diff\n- ${current.outflow} m³/s\n\`\`\``,
        inline: true
      },
      {
        name: '\u200B',
        value: '\u200B',
        inline: true
      }
    )
    .setTimestamp();
  
  // 監視中の場合は追加情報
  if (boatSession) {
    const change = current.rate - boatSession.startRate;
    const remaining = current.rate - (boatSession.startRate - CONFIG.ALERT_DECREASE);
    const changeDisplay = change >= 0 ? `+${change.toFixed(1)}` : change.toFixed(1);
    
    embed.addFields({
      name: '━━━━━━━━━ 🚣 監視中 ━━━━━━━━━',
      value: `\`\`\`diff\n開始時: ${boatSession.startRate}% → 現在: ${current.rate}% (${changeDisplay}%)\n通知まで: あと ${remaining.toFixed(1)}%\n\`\`\``,
      inline: false
    });
  }
  
  await interaction.editReply({ embeds: [embed] });
}

// ===== /dam help =====

async function handleHelpCommand(interaction) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.PRIMARY)
    .setTitle('🌊 嘉瀬川ダム監視Bot')
    .setDescription('```ボート部の桟橋が干上がらないように\nダムの貯水率を監視するBotです```')
    .addFields(
      {
        name: '━━━━━━━━━ 📋 コマンド一覧 ━━━━━━━━━',
        value: '\u200B',
        inline: false
      },
      {
        name: '🚣 `/dam start`',
        value: '```乗艇開始！監視をスタート\n再度実行するとリセット```',
        inline: false
      },
      {
        name: '📊 `/dam status`',
        value: '```現在の監視状態を確認\n通知までの残り%を表示```',
        inline: false
      },
      {
        name: '💧 `/dam now`',
        value: '```現在の貯水率・流量を表示```',
        inline: false
      },
      {
        name: '━━━━━━━━━ ⚙️ 仕組み ━━━━━━━━━',
        value: 
          '```' +
          '1. /dam start で現在の貯水率を記録\n' +
          `2. そこから ${CONFIG.ALERT_DECREASE}% 減少したら通知\n` +
          '3. 再度 /dam start でリセット\n' +
          '```',
        inline: false
      },
      {
        name: '━━━━━━━━━ 📢 自動通知 ━━━━━━━━━',
        value: '```30分ごとに自動チェック\n条件達成で @everyone 通知```',
        inline: false
      }
    )
    .setFooter({ text: '🚣 安全な活動のために！' })
    .setTimestamp();
  
  await interaction.reply({ embeds: [embed] });
}

// ===== ユーティリティ =====

function getRateColor(rate) {
  if (rate >= 70) return COLORS.SUCCESS;
  if (rate >= 50) return COLORS.WARNING;
  if (rate >= 30) return COLORS.DANGER;
  return 0x8B0000; // ダークレッド
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
  
  if (hours > 0) {
    return `${hours}時間 ${minutes}分`;
  }
  return `${minutes}分`;
}

function createProgressBar(percent) {
  const total = 20;
  const filled = Math.round((percent / 100) * total);
  const empty = total - filled;
  
  let bar = '';
  
  // 色付きのバー
  if (percent < 50) {
    bar = '🟩'.repeat(filled) + '⬜'.repeat(empty);
  } else if (percent < 80) {
    bar = '🟨'.repeat(filled) + '⬜'.repeat(empty);
  } else {
    bar = '🟥'.repeat(filled) + '⬜'.repeat(empty);
  }
  
  return `${bar}\n\`${percent.toFixed(0)}% / 100%\``;
}

// ===== 自動監視（30分ごと） =====

cron.schedule('*/30 * * * *', async () => {
  if (!boatSession || boatSession.notified) return;
  
  const data = await callGasApi('status');
  if (!data.success) return;
  
  const currentRate = data.current.rate;
  const decrease = boatSession.startRate - currentRate;
  
  if (decrease >= CONFIG.ALERT_DECREASE) {
    const channel = client.channels.cache.get(CONFIG.CHANNEL_ID);
    if (!channel) return;
    
    const progressBar = createProgressBar(100);
    
    const embed = new EmbedBuilder()
      .setColor(COLORS.DANGER)
      .setTitle('🚨 貯水率低下アラート')
      .setDescription('```diff\n- 基準値から4%以上低下しました！\n```')
      .addFields(
        {
          name: '━━━━━━━━ ⚠️ アラート情報 ━━━━━━━━',
          value: '\u200B',
          inline: false
        },
        {
          name: '開始時',
          value: `\`\`\`yaml\n${boatSession.startRate}%\n\`\`\``,
          inline: true
        },
        {
          name: '現在',
          value: `\`\`\`css\n${currentRate}%\n\`\`\``,
          inline: true
        },
        {
          name: '減少',
          value: `\`\`\`diff\n- ${decrease.toFixed(1)}%\n\`\`\``,
          inline: true
        },
        {
          name: '━━━━━━━━━━ 📈 進捗 ━━━━━━━━━━',
          value: progressBar,
          inline: false
        },
        {
          name: '━━━━━━━━━ 📝 対応事項 ━━━━━━━━━',
          value: '```\n⚠️ 桟橋の状態を確認してください\n⚠️ 必要に応じて位置を調整してください\n```',
          inline: false
        }
      )
      .setFooter({ text: `監視開始者: ${boatSession.startedBy}` })
      .setTimestamp();
    
    channel.send({ 
      content: '@everyone 🚨 **貯水率が基準値から4%低下しました！**', 
      embeds: [embed] 
    });
    
    boatSession.notified = true;
  }
}, { timezone: 'Asia/Tokyo' });

// ===== 起動 =====

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.login(CONFIG.DISCORD_TOKEN);
