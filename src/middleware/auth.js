const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

function authenticate(req, res, next) {
  let token = null;

  // Check Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  // Fallback to query param (needed for SSE EventSource which can't send headers)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Missing or invalid authorization' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.agent = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.agent.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function signToken(agent) {
  return jwt.sign(
    { id: agent.id, email: agent.email, name: agent.name, role: agent.role },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

module.exports = { authenticate, requireAdmin, signToken, JWT_SECRET };
