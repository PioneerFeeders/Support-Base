const express = require('express');
const { authenticate } = require('../middleware/auth');
const prisma = require('../lib/prisma');

const router = express.Router();

// GET /analytics/overview
router.get('/overview', authenticate, async (req, res) => {
  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(now.getDate() - now.getDay());
  thisWeekStart.setHours(0, 0, 0, 0);

  const [openTickets, reshipCostMonth, reshipCostWeek, refundMonth, doaActionsMonth, totalActionsMonth] = await Promise.all([
    // Open tickets
    prisma.ticket.count({ where: { status: { in: ['open', 'in_progress'] } } }),

    // Reship cost this month
    prisma.action.aggregate({
      where: { type: 'reship', createdAt: { gte: thisMonthStart } },
      _sum: { amount: true },
      _count: true,
    }),

    // Reship cost this week
    prisma.action.aggregate({
      where: { type: 'reship', createdAt: { gte: thisWeekStart } },
      _sum: { amount: true },
      _count: true,
    }),

    // Refund total this month
    prisma.action.aggregate({
      where: { type: 'refund', createdAt: { gte: thisMonthStart } },
      _sum: { amount: true },
      _count: true,
    }),

    // DOA actions this month (reason = doa)
    prisma.action.count({
      where: { reason: 'doa', createdAt: { gte: thisMonthStart } },
    }),

    // Total actions this month (for DOA rate denominator)
    prisma.action.count({
      where: { createdAt: { gte: thisMonthStart } },
    }),
  ]);

  const doaRate = totalActionsMonth > 0 
    ? ((doaActionsMonth / totalActionsMonth) * 100).toFixed(1) 
    : '0.0';

  res.json({
    openTickets,
    reshipCost: {
      month: parseFloat(reshipCostMonth._sum.amount || 0),
      monthCount: reshipCostMonth._count,
      week: parseFloat(reshipCostWeek._sum.amount || 0),
      weekCount: reshipCostWeek._count,
    },
    refunds: {
      month: parseFloat(refundMonth._sum.amount || 0),
      monthCount: refundMonth._count,
    },
    doaRate: parseFloat(doaRate),
    doaTarget: 2.5,
    doaAboveTarget: parseFloat(doaRate) > 2.5,
  });
});

// GET /analytics/doa-by-channel
router.get('/doa-by-channel', authenticate, async (req, res) => {
  const { weeks = 12 } = req.query;
  const since = new Date();
  since.setDate(since.getDate() - (parseInt(weeks) * 7));

  const actions = await prisma.action.groupBy({
    by: ['channel', 'reason'],
    where: { createdAt: { gte: since } },
    _count: true,
  });

  // Build per-channel DOA stats
  const channels = {};
  for (const row of actions) {
    if (!channels[row.channel]) {
      channels[row.channel] = { total: 0, doa: 0 };
    }
    channels[row.channel].total += row._count;
    if (row.reason === 'doa') {
      channels[row.channel].doa += row._count;
    }
  }

  const result = Object.entries(channels).map(([channel, stats]) => ({
    channel,
    totalActions: stats.total,
    doaCount: stats.doa,
    doaRate: stats.total > 0 ? parseFloat(((stats.doa / stats.total) * 100).toFixed(1)) : 0,
  }));

  res.json({ doaByChannel: result, periodWeeks: parseInt(weeks) });
});

// GET /analytics/reship-costs
router.get('/reship-costs', authenticate, async (req, res) => {
  const { weeks = 12 } = req.query;
  const since = new Date();
  since.setDate(since.getDate() - (parseInt(weeks) * 7));

  // Get all reships in the period
  const reships = await prisma.action.findMany({
    where: { type: 'reship', createdAt: { gte: since } },
    select: { amount: true, createdAt: true, channel: true, carrier: true },
    orderBy: { createdAt: 'asc' },
  });

  // Group by week
  const weeklyData = {};
  for (const r of reships) {
    const weekStart = getWeekStart(r.createdAt);
    const key = weekStart.toISOString().split('T')[0];
    if (!weeklyData[key]) {
      weeklyData[key] = { week: key, total: 0, count: 0 };
    }
    weeklyData[key].total += parseFloat(r.amount);
    weeklyData[key].count += 1;
  }

  res.json({
    reshipCosts: Object.values(weeklyData),
    periodWeeks: parseInt(weeks),
    grandTotal: reships.reduce((sum, r) => sum + parseFloat(r.amount), 0),
    grandCount: reships.length,
  });
});

// GET /analytics/refund-totals
router.get('/refund-totals', authenticate, async (req, res) => {
  const { weeks = 12 } = req.query;
  const since = new Date();
  since.setDate(since.getDate() - (parseInt(weeks) * 7));

  const refunds = await prisma.action.findMany({
    where: { type: 'refund', createdAt: { gte: since } },
    select: { amount: true, createdAt: true, channel: true, reason: true },
    orderBy: { createdAt: 'asc' },
  });

  // Group by week
  const weeklyData = {};
  for (const r of refunds) {
    const weekStart = getWeekStart(r.createdAt);
    const key = weekStart.toISOString().split('T')[0];
    if (!weeklyData[key]) {
      weeklyData[key] = { week: key, total: 0, count: 0 };
    }
    weeklyData[key].total += parseFloat(r.amount);
    weeklyData[key].count += 1;
  }

  res.json({
    refundTotals: Object.values(weeklyData),
    periodWeeks: parseInt(weeks),
    grandTotal: refunds.reduce((sum, r) => sum + parseFloat(r.amount), 0),
    grandCount: refunds.length,
  });
});

// ─── Helpers ─────────────────────────────────────────────

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

module.exports = router;
