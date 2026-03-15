const express = require('express');
const { queryAll } = require('../database');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Get audit log entries
router.get('/', requireAuth, requireAdmin, (req, res) => {
  const { action, user_id, date_from, date_to } = req.query;

  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const params = [];

  if (action) { sql += ' AND action = ?'; params.push(action); }
  if (user_id) { sql += ' AND user_id = ?'; params.push(user_id); }
  if (date_from) { sql += ' AND created_at >= ?'; params.push(date_from); }
  if (date_to) { sql += ' AND created_at <= ?'; params.push(date_to + ' 23:59:59'); }

  sql += ' ORDER BY created_at DESC LIMIT 200';

  const logs = queryAll(sql, params);
  res.json(logs);
});

module.exports = router;
