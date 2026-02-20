const express = require('express');
const { authenticate } = require('../middleware/auth');
const prisma = require('../lib/prisma');
const { getVapidPublicKey } = require('../lib/webPush');

const router = express.Router();

// GET /push/vapid-key — Return the public VAPID key for the frontend
router.get('/vapid-key', (req, res) => {
  const key = getVapidPublicKey();
  if (!key) return res.status(500).json({ error: 'VAPID keys not configured' });
  res.json({ publicKey: key });
});

// POST /push/subscribe — Save a web push subscription for the logged-in agent
router.post('/subscribe', authenticate, async (req, res) => {
  const { subscription } = req.body;

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription object' });
  }

  await prisma.agent.update({
    where: { id: req.agent.id },
    data: { webPushSub: subscription },
  });

  console.log(`Web push: saved subscription for agent ${req.agent.name}`);
  res.json({ success: true });
});

// DELETE /push/subscribe — Remove push subscription
router.delete('/subscribe', authenticate, async (req, res) => {
  await prisma.agent.update({
    where: { id: req.agent.id },
    data: { webPushSub: null },
  });

  console.log(`Web push: removed subscription for agent ${req.agent.name}`);
  res.json({ success: true });
});

module.exports = router;
