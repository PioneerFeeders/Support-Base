const express = require('express');
const prisma = require('../lib/prisma');
const shopify = require('../lib/shopify');
const { notifyAvailableAgents } = require('../lib/notifications');

const router = express.Router();

// POST /webhooks/quo — Incoming call or text from Quo
router.post('/quo', async (req, res) => {
  console.log('Quo webhook received:', JSON.stringify(req.body, null, 2));

  // Quo API v3 payload structure:
  // { type: "call.ringing", data: { object: { from, to, direction, status, ... } } }
  // { type: "message.received", data: { object: { from, to, body, direction, ... } } }
  const eventType = req.body.type || req.body.event;
  const dataObj = req.body.data?.object || {};

  // Extract phone number — Quo puts it in data.object.from
  let phone = dataObj.from || req.body.from;

  // Also check participants array (fallback for other formats)
  if (!phone && req.body.participants && Array.isArray(req.body.participants)) {
    const external = req.body.participants.find(p => p.type === 'external' || p.direction === 'inbound');
    phone = external?.number || external?.phone || req.body.participants[0]?.number;
  }

  if (!phone) {
    console.log('Quo webhook: no phone number found in payload');
    return res.json({ received: true, matched: false });
  }

  // Clean phone number
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
        name: o.name,
        date: o.created_at,
        total: o.total_price,
        items: o.line_items.map(i => i.title).join(', '),
        fulfillmentStatus: o.fulfillment_status,
      }));
    }
  } catch (err) {
    console.error('Shopify lookup error:', err.message);
  }

  const isCall = eventType === 'call.ringing' || eventType === 'call.started' || eventType === 'call.answered';
  const isText = eventType === 'message.received';
  const messageBody = dataObj.body || dataObj.text || req.body.body;

  if (customer) {
    const customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();
    const lastOrder = recentOrders[0];

    // Send push notification with customer info
    await notifyAvailableAgents(prisma, {
      title: isCall ? `📞 ${customerName}` : `💬 ${customerName}`,
      body: lastOrder
        ? `${lastOrder.name} — ${lastOrder.items} (${lastOrder.fulfillmentStatus || 'pending'})`
        : `${customer.orders_count || 0} orders · $${customer.total_spent || '0.00'} lifetime`,
      data: {
        type: isCall ? 'incoming_call' : 'incoming_text',
        customerId: String(customer.id),
        customerName,
        phone: cleanPhone,
        recentOrders,
      },
    });

    // Create ticket for calls
    if (isCall) {
      await prisma.ticket.create({
        data: {
          channel: 'phone',
          subject: `Call from ${customerName}`,
          customerName,
          customerEmail: customer.email,
          customerPhone: cleanPhone,
          shopifyCustomerId: String(customer.id),
        },
      });
    }

    // Create ticket for text messages
    if (isText && messageBody) {
      const ticket = await prisma.ticket.create({
        data: {
          channel: 'text',
          subject: `Text from ${customerName}`,
          customerName,
          customerEmail: customer.email,
          customerPhone: cleanPhone,
          shopifyCustomerId: String(customer.id),
        },
      });

      await prisma.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          senderType: 'customer',
          body: messageBody,
        },
      });
    }
  } else {
    // Unknown caller
    await notifyAvailableAgents(prisma, {
      title: isCall ? '📞 Unknown Caller' : '💬 Unknown Number',
      body: cleanPhone,
      data: {
        type: isCall ? 'incoming_call' : 'incoming_text',
        customerId: null,
        customerName: null,
        phone: cleanPhone,
      },
    });

    // Create ticket for call from unknown
    if (isCall) {
      await prisma.ticket.create({
        data: {
          channel: 'phone',
          subject: `Call from ${cleanPhone}`,
          customerPhone: cleanPhone,
        },
      });
    }

    // Create ticket for text from unknown
    if (isText && messageBody) {
      const ticket = await prisma.ticket.create({
        data: {
          channel: 'text',
          subject: `Text from ${cleanPhone}`,
          customerPhone: cleanPhone,
        },
      });

      await prisma.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          senderType: 'customer',
          body: messageBody,
        },
      });
    }
  }

  res.json({ received: true, matched: !!customer });
});

// POST /webhooks/shopify — Order webhooks
router.post('/shopify', async (req, res) => {
  const topic = req.headers['x-shopify-topic'];
  const order = req.body;

  console.log(`Shopify webhook: ${topic} for order ${order?.name}`);

  res.json({ received: true, topic });
});

module.exports = router;
