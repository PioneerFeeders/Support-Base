const express = require('express');
const { authenticate } = require('../middleware/auth');
const shopify = require('../lib/shopify');

const router = express.Router();

// GET /customers/search?q=sarah
router.get('/search', authenticate, async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }

  // Check if query looks like an order number
  const isOrderNumber = /^#?\d+$/.test(q.replace(/^PF-/i, ''));

  let customers = [];

  if (isOrderNumber) {
    // Search by order number, then get the customer
    const orders = await shopify.searchOrderByNumber(q);
    const seen = new Set();
    for (const order of orders) {
      if (order.customer && !seen.has(order.customer.id)) {
        seen.add(order.customer.id);
        customers.push(order.customer);
      }
    }
  } else {
    // Search customers directly by name, email, or phone
    customers = await shopify.searchCustomers(q);
  }

  // Format response
  const results = customers.map(c => ({
    id: c.id,
    name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
    email: c.email,
    phone: c.phone,
    ordersCount: c.orders_count,
    totalSpent: c.total_spent,
    createdAt: c.created_at,
    defaultAddress: c.default_address ? {
      city: c.default_address.city,
      province: c.default_address.province,
      country: c.default_address.country,
    } : null,
  }));

  res.json({ customers: results });
});

// GET /customers/:id
router.get('/:id', authenticate, async (req, res) => {
  const customer = await shopify.getCustomer(req.params.id);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  res.json({
    customer: {
      id: customer.id,
      name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
      email: customer.email,
      phone: customer.phone,
      ordersCount: customer.orders_count,
      totalSpent: customer.total_spent,
      createdAt: customer.created_at,
      defaultAddress: customer.default_address,
      tags: customer.tags,
    },
  });
});

// GET /customers/:id/orders
router.get('/:id/orders', authenticate, async (req, res) => {
  const limit = parseInt(req.query.limit) || 25;
  const orders = await shopify.getCustomerOrders(req.params.id, limit);

  const formatted = orders.map(formatOrder);
  res.json({ orders: formatted });
});

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
    totalShippingPrice: order.total_shipping_price_set?.shop_money?.amount || '0.00',
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
      variantTitle: item.variant_title,
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
      title: s.title,
      price: s.price,
      code: s.code,
      source: s.source,
    })),
    // Detect channel from tags or source
    channel: detectChannel(order),
  };
}

function detectChannel(order) {
  const source = (order.source_name || '').toLowerCase();
  const tags = (order.tags || '').toLowerCase();

  if (source.includes('amazon') || tags.includes('amazon') || tags.includes('ced')) {
    return 'amazon';
  }
  if (source === 'web' || source === 'shopify_draft_order') {
    return 'shopify';
  }
  return 'shopify';
}

module.exports = router;
