const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

async function sendPushNotification({ pushToken, title, body, data = {} }) {
  if (!pushToken) return null;

  const message = {
    to: pushToken,
    sound: 'default',
    title,
    body,
    data,
    priority: 'high',
  };

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    return res.json();
  } catch (err) {
    console.error('Push notification error:', err);
    return null;
  }
}

async function notifyAvailableAgents(prisma, { title, body, data }) {
  const agents = await prisma.agent.findMany({
    where: {
      isAvailable: true,
      pushToken: { not: null },
    },
    select: { pushToken: true, name: true },
  });

  const results = await Promise.allSettled(
    agents.map(agent =>
      sendPushNotification({ pushToken: agent.pushToken, title, body, data })
    )
  );

  return {
    sent: results.filter(r => r.status === 'fulfilled').length,
    failed: results.filter(r => r.status === 'rejected').length,
  };
}

module.exports = { sendPushNotification, notifyAvailableAgents };
