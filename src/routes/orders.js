const express = require('express');
const { authenticate } = require('../middleware/auth');
const shopify = require('../lib/shopify');
const prisma = require('../lib/prisma');

const router = express.Router();

// GET /orders/:id
router.get('/:id', authenticate, async (req, res) => {
  const order = await shopify.getOrder(req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  res.json({ order: formatOrder(order) });
});

// POST /orders/:id/reship
router.post('/:id/reship', authenticate, async (req, res) => {
  const { lineItems, shippingMethod, reason, notes, ticketId } = req.body;

  if (!lineItems || !lineItems.length || !reason) {
    return res.status(400).json({ error: 'lineItems and reason are required' });
  }

  // Get original order
  const originalOrder = await shopify.getOrder(req.params.id);
  if (!originalOrder) {
    return res.status(404).json({ error: 'Original order not found' });
  }

  // Create reship via Shopify
  const result = await shopify.createReship({
    originalOrder,
    lineItems,
    shippingMethod,
    reason,
    notes,
    agentName: req.agent.name,
  });

  // Estimate reship cost (product retail value — actual shipping cost updated later from ShipStation)
  const estimatedCost = lineItems.reduce(
    (sum, item) => sum + (parseFloat(item.price) * item.quantity), 0
  );

  // Detect channel
  const channel = detectChannel(originalOrder);

  // Detect carrier from shipping method
  const carrier = detectCarrier(shippingMethod || originalOrder.shipping_lines?.[0]?.title || '');

  // Record action
  const action = await prisma.action.create({
    data: {
      ticketId: ticketId || null,
      type: 'reship',
      channel,
      reason,
      originalOrderId: String(originalOrder.id),
      newOrderId: String(result.newOrderId || result.draftOrderId),
      amount: estimatedCost,
      items: lineItems,
      shippingMethod: shippingMethod || originalOrder.shipping_lines?.[0]?.title || 'Standard',
      carrier,
      notes,
      agentId: req.agent.id,
    },
  });

  // Auto-create ticket if none provided
  let ticket = null;
  if (ticketId) {
    ticket = await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status: 'resolved',
        resolvedAt: new Date(),
        updatedAt: new Date(),
      },
    });
  } else {
    ticket = await prisma.ticket.create({
      data: {
        channel,
        status: 'resolved',
        priority: 'normal',
        subject: `Reship: ${originalOrder.name} → ${result.newOrderName || 'New Order'}`,
        customerName: `${originalOrder.customer?.first_name || ''} ${originalOrder.customer?.last_name || ''}`.trim(),
        customerEmail: originalOrder.customer?.email,
        customerPhone: originalOrder.customer?.phone,
        shopifyCustomerId: originalOrder.customer?.id ? String(originalOrder.customer.id) : null,
        assignedAgentId: req.agent.id,
        resolvedAt: new Date(),
      },
    });

    // Link action to the new ticket
    await prisma.action.update({
      where: { id: action.id },
      data: { ticketId: ticket.id },
    });

    // Add system message
    await prisma.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        senderType: 'system',
        body: `Reship created by ${req.agent.name}. ${lineItems.length} item(s) via ${shippingMethod || 'Standard'}. Reason: ${reason}.${notes ? ' Notes: ' + notes : ''}`,
      },
    });
  }

  res.status(201).json({
    success: true,
    reship: {
      newOrderId: result.newOrderId,
      newOrderName: result.newOrderName,
      draftOrderId: result.draftOrderId,
    },
    actionId: action.id,
    ticketId: ticket.id,
  });
});

// POST /orders/:id/refund
router.post('/:id/refund', authenticate, async (req, res) => {
  const { lineItems, fullRefund, reason, notes, ticketId } = req.body;

  if (!reason) {
    return res.status(400).json({ error: 'reason is required' });
  }

  const order = await shopify.getOrder(req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  // Process refund via Shopify
  const result = await shopify.createRefund({
    orderId: req.params.id,
    lineItems: lineItems || [],
    fullRefund: fullRefund !== false,
    reason,
    notes,
    agentName: req.agent.name,
  });

  const channel = detectChannel(order);

  // Record action
  const action = await prisma.action.create({
    data: {
      ticketId: ticketId || null,
      type: 'refund',
      channel,
      reason,
      originalOrderId: String(order.id),
      amount: result.amount,
      items: lineItems || order.line_items.map(i => ({ title: i.title, quantity: i.quantity, price: i.price })),
      carrier: order.fulfillments?.[0]?.tracking_company || null,
      notes,
      agentId: req.agent.id,
    },
  });

  // Auto-create ticket if none provided
  let ticket = null;
  if (ticketId) {
    ticket = await prisma.ticket.update({
      where: { id: ticketId },
      data: { status: 'resolved', resolvedAt: new Date(), updatedAt: new Date() },
    });
  } else {
    ticket = await prisma.ticket.create({
      data: {
        channel,
        status: 'resolved',
        priority: 'normal',
        subject: `Refund: ${order.name} — $${result.amount.toFixed(2)}`,
        customerName: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim(),
        customerEmail: order.customer?.email,
        customerPhone: order.customer?.phone,
        shopifyCustomerId: order.customer?.id ? String(order.customer.id) : null,
        assignedAgentId: req.agent.id,
        resolvedAt: new Date(),
      },
    });

    await prisma.action.update({
      where: { id: action.id },
      data: { ticketId: ticket.id },
    });

    await prisma.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        senderType: 'system',
        body: `Refund of $${result.amount.toFixed(2)} processed by ${req.agent.name}. Reason: ${reason}.${notes ? ' Notes: ' + notes : ''}`,
      },
    });
  }

  res.status(201).json({
    success: true,
    refund: {
      refundId: result.refundId,
      amount: result.amount,
    },
    actionId: action.id,
    ticketId: ticket.id,
  });
});

// ─── Helpers ─────────────────────────────────────────────

function formatOrder(order) {
  return {
    id: order.id,
    name: order.name,
    orderNumber: order.order_number,
    createdAt: order.created_at,
    financialStatus: order.financial_status,
    fulfillmentStatus: order.fulfillment_status,
    totalPrice: order.total_price,
    subtotalPrice: order.subtotal_price,
    currency: order.currency,
    note: order.note,
    tags: order.tags,
    customer: order.customer ? {
      id: order.customer.id,
      name: `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim(),
      email: order.customer.email,
    } : null,
    shippingAddress: order.shipping_address,
    lineItems: order.line_items.map(item => ({
      id: item.id,
      title: item.title,
      quantity: item.quantity,
      price: item.price,
      sku: item.sku,
      variantId: item.variant_id,
    })),
    fulfillments: (order.fulfillments || []).map(f => ({
      id: f.id,
      status: f.status,
      trackingNumber: f.tracking_number,
      trackingUrl: f.tracking_url,
      trackingCompany: f.tracking_company,
      createdAt: f.created_at,
    })),
    shippingLines: (order.shipping_lines || []).map(s => ({
      title: s.title, price: s.price, code: s.code,
    })),
    channel: detectChannel(order),
  };
}

function detectChannel(order) {
  const source = (order.source_name || '').toLowerCase();
  const tags = (order.tags || '').toLowerCase();
  if (source.includes('amazon') || tags.includes('amazon') || tags.includes('ced')) return 'amazon';
  return 'shopify';
}

function detectCarrier(shippingTitle) {
  const s = shippingTitle.toLowerCase();
  if (s.includes('ups')) return 'UPS';
  if (s.includes('usps') || s.includes('priority mail') || s.includes('first class')) return 'USPS';
  if (s.includes('fedex')) return 'FedEx';
  return 'Other';
}

module.exports = router;
