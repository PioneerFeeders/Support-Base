require('express-async-errors');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const customerRoutes = require('./routes/customers');
const orderRoutes = require('./routes/orders');
const ticketRoutes = require('./routes/tickets');
const analyticsRoutes = require('./routes/analytics');
const webhookRoutes = require('./routes/webhooks');
const eventRoutes = require('./routes/events');
const pushRoutes = require('./routes/push');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ 
    service: 'KEEL API',
    version: '1.0.0',
    status: 'operational',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/customers', customerRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/tickets', ticketRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/webhooks', webhookRoutes);
app.use('/api/v1/events', eventRoutes);
app.use('/api/v1/push', pushRoutes);

// Error handler
app.use(errorHandler);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`KEEL API running on port ${PORT}`);
});

module.exports = app;
