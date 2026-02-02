// セッションをGASから取得するように変更

async function handleStartCommand(interaction) {
  await interaction.deferReply();
  
  const username = interaction.user.username;
  // GASでセッション開始
  const data = await callGasApi(`start&username=${encodeURIComponent(username)}`);
  
  if (!data.success) {
    // エラー処理
    return;
  }
  
  const currentRate = data.current.rate;
  const session = data.session;
  // ... 残りは同じ
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
