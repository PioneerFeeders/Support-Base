const express = require('express');
const prisma = require('../lib/prisma');
const shopify = require('../lib/shopify');
const { notifyAvailableAgents } = require('../lib/notifications');

const router = express.Router();

// POST /webhooks/quo — Incoming call or text from Quo
router.post('/quo', async (req, res) => {
  const { event, participants, from, body: messageBody } = req.body;

  // Extract phone number from Quo payload
  let phone = null;
  if (participants && Array.isArray(participants)) {
    // Find the external participant (not our business number)
    const external = participants.find(p => p.type === 'external' || p.direction === 'inbound');
    phone = external?.number || external?.phone || participants[0]?.number;
  }
  if (!phone && from) {
    phone = from;
  }

  if (!phone) {
    console.log('Quo webhook: no phone number found in payload', req.body);
    return res.json({ received: true, matched: false });
  }

  // Clean phone number
  const cleanPhone = phone.replace(/[^\d+]/g, '');

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

  const isCall = event === 'call.ringing' || event === 'call.started';
  const isText = event === 'message.received';

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

    // Create ticket for text messages
    if (isText && messageBody) {
      await prisma.ticket.create({
        data: {
          channel: 'text',
          subject: `Text from ${customerName}`,
          customerName,
          customerEmail: customer.email,
          customerPhone: cleanPhone,
          shopifyCustomerId: String(customer.id),
        },
      });

      // Add the message
      const ticket = await prisma.ticket.findFirst({
        where: { customerPhone: cleanPhone },
        orderBy: { createdAt: 'desc' },
      });

      if (ticket) {
        await prisma.ticketMessage.create({
          data: {
            ticketId: ticket.id,
            senderType: 'customer',
            body: messageBody,
          },
        });
      }
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
  // Verify Shopify webhook (TODO: add HMAC verification)
  const topic = req.headers['x-shopify-topic'];
  const order = req.body;

  console.log(`Shopify webhook: ${topic} for order ${order?.name}`);

  // For now, just acknowledge — we'll use this for real-time order updates later
  res.json({ received: true, topic });
});

module.exports = router;
