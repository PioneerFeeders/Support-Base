const webpush = require('web-push');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@pioneerfeeders.com';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  console.log('Web Push configured with VAPID keys');
} else {
  console.warn('Web Push: VAPID keys not set — push notifications disabled');
}

async function sendWebPush(subscription, payload) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return null;
  if (!subscription || !subscription.endpoint) return null;

  try {
    const result = await webpush.sendNotification(
      subscription,
      JSON.stringify(payload),
      { TTL: 60 }
    );
    return result;
  } catch (err) {
    console.error('Web push error:', err.statusCode, err.body);
    // 410 = subscription expired/unsubscribed
    if (err.statusCode === 410 || err.statusCode === 404) {
      return { expired: true };
    }
    return null;
  }
}

async function notifyAllAgentsWebPush(prisma, payload) {
  const agents = await prisma.agent.findMany({
    where: {
      isAvailable: true,
      webPushSub: { not: null },
    },
    select: { id: true, webPushSub: true, name: true },
  });

  console.log(`Web push: sending to ${agents.length} agent(s)`);

  const results = await Promise.allSettled(
    agents.map(async (agent) => {
      const result = await sendWebPush(agent.webPushSub, payload);
      // If subscription expired, clear it
      if (result?.expired) {
        await prisma.agent.update({
          where: { id: agent.id },
          data: { webPushSub: null },
        });
        console.log(`Web push: cleared expired subscription for ${agent.name}`);
      }
      return result;
    })
  );

  return {
    sent: results.filter(r => r.status === 'fulfilled' && r.value && !r.value.expired).length,
    expired: results.filter(r => r.status === 'fulfilled' && r.value?.expired).length,
    failed: results.filter(r => r.status === 'rejected').length,
  };
}

function getVapidPublicKey() {
  return VAPID_PUBLIC;
}

module.exports = { sendWebPush, notifyAllAgentsWebPush, getVapidPublicKey };
