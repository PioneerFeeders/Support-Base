const express = require('express');
const prisma = require('../lib/prisma');
const shopify = require('../lib/shopify');
const { notifyAvailableAgents } = require('../lib/notifications');
const { notifyAllAgentsWebPush } = require('../lib/webPush');
const { broadcast } = require('../lib/eventBus');

const router = express.Router();

const REOPEN_WINDOW_DAYS = 7;

// ── Find or create ticket for a phone number ────────────
// 1. Open/in_progress ticket exists → use it
// 2. Resolved ticket within REOPEN_WINDOW_DAYS → reopen it
// 3. Otherwise → create new ticket
async function findOrCreateTicket(phone, { channel, customerName, customerEmail, shopifyCustomerId }) {
  // 1. Check for open/in_progress ticket for this phone
  const activeTicket = await prisma.ticket.findFirst({
    where: {
      customerPhone: phone,
      channel,
      status: { in: ['open', 'in_progress'] },
    },
    orderBy: { updatedAt: 'desc' },
  });

  if (activeTicket) {
    console.log(`Ticket threading: adding to active ticket ${activeTicket.id}`);
    return { ticket: activeTicket, action: 'existing' };
  }

  // 2. Check for recently resolved ticket (within reopen window)
  const reopenCutoff = new Date();
  reopenCutoff.setDate(reopenCutoff.getDate() - REOPEN_WINDOW_DAYS);

  const resolvedTicket = await prisma.ticket.findFirst({
    where: {
      customerPhone: phone,
      channel,
      status: 'resolved',
      resolvedAt: { gte: reopenCutoff },
    },
    orderBy: { resolvedAt: 'desc' },
  });

  if (resolvedTicket) {
    console.log(`Ticket threading: reopening resolved ticket ${resolvedTicket.id}`);
    const reopened = await prisma.ticket.update({
      where: { id: resolvedTicket.id },
      data: {
        status: 'open',
        resolvedAt: null,
        resolutionType: null,
        resolutionReason: null,
      },
    });
    // Add a system message noting the reopen
    await prisma.ticketMessage.create({
      data: {
        ticketId: reopened.id,
        senderType: 'system',
        body: 'Ticket reopened — customer sent a new message',
      },
    });
    return { ticket: reopened, action: 'reopened' };
  }

  // 3. Create new ticket
  const subject = customerName
    ? `${channel === 'text' ? 'Text' : 'Call'} from ${customerName}`
    : `${channel === 'text' ? 'Text' : 'Call'} from ${phone}`;

  const newTicket = await prisma.ticket.create({
    data: {
      channel,
      subject,
      customerName: customerName || null,
      customerEmail: customerEmail || null,
      customerPhone: phone,
      shopifyCustomerId: shopifyCustomerId || null,
    },
  });

  console.log(`Ticket threading: created new ticket ${newTicket.id}`);
  return { ticket: newTicket, action: 'created' };
}

// ── Auto-close old resolved tickets ─────────────────────
// Tickets resolved more than REOPEN_WINDOW_DAYS ago get closed automatically
async function autoCloseOldTickets() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - REOPEN_WINDOW_DAYS);

  const { count } = await prisma.ticket.updateMany({
    where: {
      status: 'resolved',
      resolvedAt: { lt: cutoff },
    },
    data: { status: 'closed' },
  });

  if (count > 0) console.log(`Auto-closed ${count} old resolved ticket(s)`);
}

// POST /webhooks/quo — Incoming call or text from Quo
router.post('/quo', async (req, res) => {
  console.log('Quo webhook received:', JSON.stringify(req.body, null, 2));

  const eventType = req.body.type || req.body.event;
  const dataObj = req.body.data?.object || {};

  let phone = dataObj.from || req.body.from;

  if (!phone && req.body.participants && Array.isArray(req.body.participants)) {
    const external = req.body.participants.find(p => p.type === 'external' || p.direction === 'inbound');
    phone = external?.number || external?.phone || req.body.participants[0]?.number;
  }

  if (!phone) {
    console.log('Quo webhook: no phone number found in payload');
    return res.json({ received: true, matched: false });
  }

  const cleanPhone = phone.replace(/[^\d+]/g, '');
  console.log(`Quo webhook: event=${eventType}, phone=${cleanPhone}`);

  // Auto-close old resolved tickets on each webhook (lightweight)
  await autoCloseOldTickets().catch(err => console.error('Auto-close error:', err.message));

  // Search Shopify for customer by phone
  let customer = null;
  let recentOrders = [];
  try {
    const customers = await shopify.searchCustomers(cleanPhone);
    if (customers.length > 0) {
      customer = customers[0];
      const orders = await shopify.getCustomerOrders(customer.id, 3);
      recentOrders = orders.map(o => ({
        id: o.id,
        name: o.name,
        date: o.created_at,
        total: o.total_price,
        totalPrice: o.total_price,
        items: o.line_items.map(i => ({ title: i.title, quantity: i.quantity, price: i.price, sku: i.sku, variantId: i.variant_id })),
        lineItems: o.line_items.map(i => ({ id: i.id, title: i.title, quantity: i.quantity, price: i.price, sku: i.sku, variantId: i.variant_id })),
        fulfillmentStatus: o.fulfillment_status,
        shippingLines: o.shipping_lines,
        channel: 'shopify',
        createdAt: o.created_at,
      }));
    }
  } catch (err) {
    console.error('Shopify lookup error:', err.message);
  }

  const isCall = eventType === 'call.ringing' || eventType === 'call.started' || eventType === 'call.answered';
  const isText = eventType === 'message.received';
  const messageBody = dataObj.body || dataObj.text || req.body.body;

  const customerName = customer ? `${customer.first_name || ''} ${customer.last_name || ''}`.trim() : null;

  // ── Broadcast to PWA via SSE ──────────────────────────
  const ssePayload = {
    type: isCall ? 'incoming_call' : 'incoming_text',
    phone: cleanPhone,
    messageBody: isText ? messageBody : null,
    timestamp: new Date().toISOString(),
    customer: customer ? {
      id: customer.id,
      name: customerName,
      email: customer.email,
      phone: customer.phone || cleanPhone,
      ordersCount: customer.orders_count || 0,
      totalSpent: customer.total_spent || '0.00',
    } : null,
    recentOrders,
  };

  broadcast('incoming', ssePayload);
  console.log('SSE broadcast sent for', ssePayload.type);

  // ── Web Push notifications (works when app is closed) ──
  const lastOrder = recentOrders[0];
  await notifyAllAgentsWebPush(prisma, {
    title: isCall
      ? `📞 ${customerName || 'Unknown Caller'}`
      : `💬 ${customerName || 'Unknown Number'}`,
    body: customer && lastOrder
      ? `${lastOrder.name} — ${lastOrder.items.map(i => i.title).join(', ')}`
      : customer
        ? `${customer.orders_count || 0} orders · $${customer.total_spent || '0.00'} lifetime`
        : cleanPhone,
    data: ssePayload,
  });

  // ── Expo push notifications ───────────────────────────
  await notifyAvailableAgents(prisma, {
    title: isCall
      ? `📞 ${customerName || 'Unknown Caller'}`
      : `💬 ${customerName || 'Unknown Number'}`,
    body: customer && lastOrder
      ? `${lastOrder.name} — ${lastOrder.items.map(i => i.title).join(', ')}`
      : cleanPhone,
    data: { type: isCall ? 'incoming_call' : 'incoming_text', customerId: customer ? String(customer.id) : null, customerName, phone: cleanPhone },
  });

  // ── Ticket creation / threading ───────────────────────
  if (isCall) {
    const { ticket, action } = await findOrCreateTicket(cleanPhone, {
      channel: 'phone',
      customerName,
      customerEmail: customer?.email,
      shopifyCustomerId: customer ? String(customer.id) : null,
    });
    console.log(`Call ticket: ${action} → ${ticket.id}`);
  }

  if (isText && messageBody) {
    const { ticket, action } = await findOrCreateTicket(cleanPhone, {
      channel: 'text',
      customerName,
      customerEmail: customer?.email,
      shopifyCustomerId: customer ? String(customer.id) : null,
    });

    await prisma.ticketMessage.create({
      data: { ticketId: ticket.id, senderType: 'customer', body: messageBody },
    });

    // Touch the ticket so it moves to top of inbox
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { updatedAt: new Date() },
    });

    console.log(`Text ticket: ${action} → ${ticket.id}, message added`);
  }

  res.json({ received: true, matched: !!customer });
});

// POST /webhooks/shopify — Order webhooks
router.post('/shopify', async (req, res) => {
  const topic = req.headers['x-shopify-topic'];
  console.log(`Shopify webhook: ${topic} for order ${req.body?.name}`);
  res.json({ received: true, topic });
});

module.exports = router;
