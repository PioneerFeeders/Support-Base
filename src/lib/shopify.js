const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'pioneer-feeders.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = '2024-01';

const BASE_URL = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}`;

async function shopifyFetch(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify API error ${res.status}: ${body}`);
  }

  return res.json();
}

// ─── Customers ───────────────────────────────────────────

async function searchCustomers(query) {
  const data = await shopifyFetch(`/customers/search.json?query=${encodeURIComponent(query)}&limit=10`);
  return data.customers || [];
}

async function getCustomer(customerId) {
  const data = await shopifyFetch(`/customers/${customerId}.json`);
  return data.customer;
}

// ─── Orders ──────────────────────────────────────────────

async function getCustomerOrders(customerId, limit = 25) {
  const data = await shopifyFetch(`/orders.json?customer_id=${customerId}&status=any&limit=${limit}`);
  return data.orders || [];
}

async function getOrder(orderId) {
  const data = await shopifyFetch(`/orders/${orderId}.json`);
  return data.order;
}

async function searchOrderByNumber(orderNumber) {
  // Remove # or PF- prefix if present
  const num = orderNumber.replace(/^#?(PF-)?/i, '');
  const data = await shopifyFetch(`/orders.json?name=${encodeURIComponent('#' + num)}&status=any&limit=5`);
  return data.orders || [];
}

// ─── Reship (Draft Order) ────────────────────────────────

async function createReship({ originalOrder, lineItems, shippingMethod, reason, notes, agentName }) {
  // Build line items for draft order
  const draftLineItems = lineItems.map(item => ({
    title: item.title,
    quantity: item.quantity,
    price: item.price,
    sku: item.sku,
    variant_id: item.variant_id,
  }));

  // Create draft order
  const draftData = await shopifyFetch('/draft_orders.json', {
    method: 'POST',
    body: JSON.stringify({
      draft_order: {
        line_items: draftLineItems,
        shipping_address: originalOrder.shipping_address,
        billing_address: originalOrder.billing_address,
        customer: { id: originalOrder.customer?.id },
        note: `Reship of #${originalOrder.name} — Reason: ${reason}${notes ? ' — ' + notes : ''} — Agent: ${agentName}`,
        shipping_line: {
          title: shippingMethod || 'Standard',
          price: '0.00',
        },
        applied_discount: {
          title: `Reship - ${reason}`,
          value: '100.0',
          value_type: 'percentage',
          description: `Reship of order ${originalOrder.name}`,
        },
        tags: `reship,${reason}`,
      }
    })
  });

  const draftOrder = draftData.draft_order;

  // Complete the draft order (marks as paid at $0)
  const completeData = await shopifyFetch(`/draft_orders/${draftOrder.id}/complete.json`, {
    method: 'PUT',
    body: JSON.stringify({ payment_pending: false })
  });

  const newOrder = completeData.draft_order?.order_id 
    ? await getOrder(completeData.draft_order.order_id)
    : completeData.draft_order;

  // Add note to original order
  const existingNotes = originalOrder.note || '';
  const reshipNote = `[RESHIP] → ${newOrder?.name || 'New Order'} | Reason: ${reason} | Agent: ${agentName} | ${new Date().toISOString()}`;
  await shopifyFetch(`/orders/${originalOrder.id}.json`, {
    method: 'PUT',
    body: JSON.stringify({
      order: {
        id: originalOrder.id,
        note: existingNotes ? `${existingNotes}\n${reshipNote}` : reshipNote,
      }
    })
  });

  return {
    newOrderId: newOrder?.id,
    newOrderName: newOrder?.name,
    draftOrderId: draftOrder.id,
  };
}

// ─── Refund ──────────────────────────────────────────────

async function createRefund({ orderId, lineItems, fullRefund, reason, notes, agentName }) {
  const order = await getOrder(orderId);

  let refundLineItems;
  let shipping = { full_refund: false };

  if (fullRefund) {
    // Refund all line items
    refundLineItems = order.line_items.map(item => ({
      line_item_id: item.id,
      quantity: item.quantity,
      restock_type: 'no_restock',
    }));
    shipping = { full_refund: true };
  } else {
    // Partial refund — only selected items
    refundLineItems = lineItems.map(item => ({
      line_item_id: item.line_item_id,
      quantity: item.quantity,
      restock_type: 'no_restock',
    }));
  }

  // Calculate refund
  const calcData = await shopifyFetch(`/orders/${orderId}/refunds/calculate.json`, {
    method: 'POST',
    body: JSON.stringify({
      refund: {
        refund_line_items: refundLineItems,
        shipping,
      }
    })
  });

  // Process the refund
  const refundData = await shopifyFetch(`/orders/${orderId}/refunds.json`, {
    method: 'POST',
    body: JSON.stringify({
      refund: {
        note: `Reason: ${reason}${notes ? ' — ' + notes : ''} — Agent: ${agentName}`,
        refund_line_items: refundLineItems,
        shipping,
        transactions: calcData.refund.transactions.map(t => ({
          parent_id: t.parent_id,
          amount: t.amount,
          kind: 'refund',
          gateway: t.gateway,
        })),
      }
    })
  });

  // Calculate total refund amount
  const totalRefund = refundData.refund.transactions?.reduce(
    (sum, t) => sum + parseFloat(t.amount || 0), 0
  ) || 0;

  // Add note to order
  const existingNotes = order.note || '';
  const refundNote = `[REFUND] $${totalRefund.toFixed(2)} | Reason: ${reason} | Agent: ${agentName} | ${new Date().toISOString()}`;
  await shopifyFetch(`/orders/${orderId}.json`, {
    method: 'PUT',
    body: JSON.stringify({
      order: {
        id: orderId,
        note: existingNotes ? `${existingNotes}\n${refundNote}` : refundNote,
      }
    })
  });

  return {
    refundId: refundData.refund.id,
    amount: totalRefund,
    transactions: refundData.refund.transactions,
  };
}

module.exports = {
  searchCustomers,
  getCustomer,
  getCustomerOrders,
  getOrder,
  searchOrderByNumber,
  createReship,
  createRefund,
};
