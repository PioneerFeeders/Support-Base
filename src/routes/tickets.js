const express = require('express');
const { authenticate } = require('../middleware/auth');
const prisma = require('../lib/prisma');

const router = express.Router();

// GET /tickets — List with filters
router.get('/', authenticate, async (req, res) => {
  const { channel, status, priority, limit = 50, offset = 0 } = req.query;

  const where = {};
  if (channel) where.channel = channel;
  if (status) where.status = status;
  if (priority) where.priority = priority;

  const [tickets, total] = await Promise.all([
    prisma.ticket.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset),
      include: {
        assignedAgent: { select: { id: true, name: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { body: true, createdAt: true, senderType: true } },
        _count: { select: { messages: true, actions: true } },
      },
    }),
    prisma.ticket.count({ where }),
  ]);

  res.json({
    tickets: tickets.map(t => ({
      id: t.id,
      channel: t.channel,
      status: t.status,
      priority: t.priority,
      subject: t.subject,
      customerName: t.customerName,
      customerEmail: t.customerEmail,
      assignedAgent: t.assignedAgent,
      lastMessage: t.messages[0] || null,
      messageCount: t._count.messages,
      actionCount: t._count.actions,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      resolvedAt: t.resolvedAt,
    })),
    total,
    limit: parseInt(limit),
    offset: parseInt(offset),
  });
});

// GET /tickets/:id — Full ticket with messages and actions
router.get('/:id', authenticate, async (req, res) => {
  const ticket = await prisma.ticket.findUnique({
    where: { id: req.params.id },
    include: {
      assignedAgent: { select: { id: true, name: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
        include: { senderAgent: { select: { id: true, name: true } } },
      },
      actions: {
        orderBy: { createdAt: 'desc' },
        include: { agent: { select: { id: true, name: true } } },
      },
    },
  });

  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  res.json({ ticket });
});

// POST /tickets — Create ticket
router.post('/', authenticate, async (req, res) => {
  const { channel, subject, customerName, customerEmail, customerPhone, shopifyCustomerId, amazonOrderId, priority, body } = req.body;

  if (!channel || !subject) {
    return res.status(400).json({ error: 'channel and subject are required' });
  }

  const ticket = await prisma.ticket.create({
    data: {
      channel,
      subject,
      customerName,
      customerEmail,
      customerPhone,
      shopifyCustomerId,
      amazonOrderId,
      priority: priority || 'normal',
      assignedAgentId: req.agent.id,
    },
  });

  // Add initial message if body provided
  if (body) {
    await prisma.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        senderType: 'customer',
        body,
      },
    });
  }

  res.status(201).json({ ticket });
});

// PUT /tickets/:id — Update ticket
router.put('/:id', authenticate, async (req, res) => {
  const { status, priority, assignedAgentId, resolutionType, resolutionReason } = req.body;
  const data = {};

  if (status) {
    data.status = status;
    if (status === 'resolved' || status === 'closed') {
      data.resolvedAt = new Date();
    }
  }
  if (priority) data.priority = priority;
  if (assignedAgentId !== undefined) data.assignedAgentId = assignedAgentId;
  if (resolutionType) data.resolutionType = resolutionType;
  if (resolutionReason) data.resolutionReason = resolutionReason;

  const ticket = await prisma.ticket.update({
    where: { id: req.params.id },
    data,
    include: { assignedAgent: { select: { id: true, name: true } } },
  });

  res.json({ ticket });
});

// POST /tickets/:id/messages — Add message
router.post('/:id/messages', authenticate, async (req, res) => {
  const { body, senderType = 'agent' } = req.body;

  if (!body) {
    return res.status(400).json({ error: 'body is required' });
  }

  // Verify ticket exists
  const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id } });
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  const message = await prisma.ticketMessage.create({
    data: {
      ticketId: req.params.id,
      senderType,
      senderAgentId: senderType === 'agent' ? req.agent.id : null,
      body,
    },
    include: { senderAgent: { select: { id: true, name: true } } },
  });

  // Update ticket to in_progress if it was open
  if (ticket.status === 'open') {
    await prisma.ticket.update({
      where: { id: req.params.id },
      data: { status: 'in_progress', assignedAgentId: req.agent.id },
    });
  }

  // TODO: If ticket.channel === 'amazon', send reply via SP-API

  res.status(201).json({ message });
});

module.exports = router;
