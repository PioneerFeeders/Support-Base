const express = require('express');
const prisma = require('../lib/prisma');
const shopify = require('../lib/shopify');
const { notifyAvailableAgents } = require('../lib/notifications');
const { broadcast } = require('../lib/eventBus');

const router = express.Router();

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

  // ── Broadcast to PWA via SSE ──────────────────────────
  const ssePayload = {
    type: isCall ? 'incoming_call' : 'incoming_text',
    phone: cleanPhone,
    messageBody: isText ? messageBody : null,
    timestamp: new Date().toISOString(),
    customer: customer ? {
      id: customer.id,
      name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
      email: customer.email,
      phone: customer.phone || cleanPhone,
      ordersCount: customer.orders_count || 0,
      totalSpent: customer.total_spent || '0.00',
    } : null,
    recentOrders,
  };

  broadcast('incoming', ssePayload);
  console.log('SSE broadcast sent for', ssePayload.type);

  // ── Push notifications (Expo, if any) ─────────────────
  if (customer) {
    const customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();
    const lastOrder = recentOrders[0];

    await notifyAvailableAgents(prisma, {
      title: isCall ? `📞 ${customerName}` : `💬 ${customerName}`,
      body: lastOrder
        ? `${lastOrder.name} — ${lastOrder.items.map(i => i.title).join(', ')} (${lastOrder.fulfillmentStatus || 'pending'})`
        : `${customer.orders_count || 0} orders · $${customer.total_spent || '0.00'} lifetime`,
      data: { type: isCall ? 'incoming_call' : 'incoming_text', customerId: String(customer.id), customerName, phone: cleanPhone },
    });

    if (isCall) {
      await prisma.ticket.create({
        data: {
          channel: 'phone', subject: `Call from ${customerName}`,
          customerName, customerEmail: customer.email, customerPhone: cleanPhone,
          shopifyCustomerId: String(customer.id),
        },
      });
    }

    if (isText && messageBody) {
      const ticket = await prisma.ticket.create({
        data: {
          channel: 'text', subject: `Text from ${customerName}`,
          customerName, customerEmail: customer.email, customerPhone: cleanPhone,
          shopifyCustomerId: String(customer.id),
        },
      });
      await prisma.ticketMessage.create({
        data: { ticketId: ticket.id, senderType: 'customer', body: messageBody },
      });
    }
  } else {
    await notifyAvailableAgents(prisma, {
      title: isCall ? '📞 Unknown Caller' : '💬 Unknown Number',
      body: cleanPhone,
      data: { type: isCall ? 'incoming_call' : 'incoming_text', customerId: null, customerName: null, phone: cleanPhone },
    });

    if (isCall) {
      await prisma.ticket.create({
        data: { channel: 'phone', subject: `Call from ${cleanPhone}`, customerPhone: cleanPhone },
      });
    }

    if (isText && messageBody) {
      const ticket = await prisma.ticket.create({
        data: { channel: 'text', subject: `Text from ${cleanPhone}`, customerPhone: cleanPhone },
      });
      await prisma.ticketMessage.create({
        data: { ticketId: ticket.id, senderType: 'customer', body: messageBody },
      });
    }
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
