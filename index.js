// セッションをGASから取得するように変更

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
  const session = data.session;
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

// 30分ごとのチェックもGASからセッション取得
cron.schedule('*/30 * * * *', async () => {
  const sessionData = await callGasApi('session');
  if (!sessionData.success || !sessionData.session || sessionData.session.notified) return;
  
  const session = sessionData.session;
  const statusData = await callGasApi('status');
  if (!statusData.success) return;
  
  const currentRate = statusData.current.rate;
  const decrease = session.startRate - currentRate;
  
  if (decrease >= CONFIG.ALERT_DECREASE) {
    // 通知処理
    await callGasApi('notify'); // 通知済みフラグ更新
  }
});
