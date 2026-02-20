const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { authenticate, requireAdmin, signToken } = require('../middleware/auth');

const router = express.Router();

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const agent = await prisma.agent.findUnique({ where: { email: email.toLowerCase() } });
  if (!agent) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, agent.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken(agent);
  res.json({
    token,
    agent: {
      id: agent.id,
      name: agent.name,
      email: agent.email,
      role: agent.role,
      isAvailable: agent.isAvailable,
    },
  });
});

// POST /auth/register (admin only)
router.post('/register', authenticate, requireAdmin, async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password required' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const agent = await prisma.agent.create({
    data: {
      name,
      email: email.toLowerCase(),
      passwordHash,
      role: role || 'agent',
    },
    select: { id: true, name: true, email: true, role: true },
  });

  res.status(201).json({ agent });
});

// POST /auth/setup — Create first admin (only works if no agents exist)
router.post('/setup', async (req, res) => {
  const count = await prisma.agent.count();
  if (count > 0) {
    return res.status(403).json({ error: 'Setup already completed. Use /auth/register to add agents.' });
  }

  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password required' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const agent = await prisma.agent.create({
    data: {
      name,
      email: email.toLowerCase(),
      passwordHash,
      role: 'admin',
    },
  });

  const token = signToken(agent);
  res.status(201).json({
    message: 'Admin account created successfully',
    token,
    agent: { id: agent.id, name: agent.name, email: agent.email, role: agent.role },
  });
});

// PUT /auth/push-token
router.put('/push-token', authenticate, async (req, res) => {
  const { pushToken } = req.body;
  await prisma.agent.update({
    where: { id: req.agent.id },
    data: { pushToken },
  });
  res.json({ success: true });
});

// PUT /auth/availability
router.put('/availability', authenticate, async (req, res) => {
  const { isAvailable } = req.body;
  const agent = await prisma.agent.update({
    where: { id: req.agent.id },
    data: { isAvailable },
    select: { id: true, name: true, isAvailable: true },
  });
  res.json({ agent });
});

module.exports = router;
