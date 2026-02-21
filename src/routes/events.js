const express = require('express');
const { authenticate } = require('../middleware/auth');
const { addClient, getClientCount } = require('../lib/eventBus');

const router = express.Router();

// GET /events/stream — SSE endpoint for real-time events
router.get('/stream', authenticate, (req, res) => {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no', // Disable nginx buffering on Railway
  });

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to SupportBase events', clients: getClientCount() + 1 })}\n\n`);

  // Register this client
  addClient(res);

  // Keep-alive ping every 30 seconds to prevent timeout
  const keepAlive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 30000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

module.exports = router;
