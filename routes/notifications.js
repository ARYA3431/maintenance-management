const express = require('express');
const { queryAll, queryOne, runSql, saveDb } = require('../database');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Get all notifications (admin)
router.get('/', requireAuth, requireAdmin, (req, res) => {
  const notifications = queryAll(`
    SELECT n.*, e.name as equipment_name, e.location_name
    FROM notifications n
    JOIN equipment e ON n.equipment_id = e.id
    ORDER BY n.created_at DESC
    LIMIT 100
  `);
  res.json(notifications);
});

// Get unread count
router.get('/unread-count', requireAuth, requireAdmin, (req, res) => {
  const result = queryOne('SELECT COUNT(*) as count FROM notifications WHERE is_read = 0');
  const critical = queryOne("SELECT COUNT(*) as count FROM notifications WHERE is_read = 0 AND priority = 'critical'");
  res.json({
    count: result ? result.count : 0,
    critical_count: critical ? critical.count : 0
  });
});

// Get latest unread critical notification (for admin popup)
router.get('/latest-critical', requireAuth, requireAdmin, (req, res) => {
  const notification = queryOne(`
    SELECT n.*, e.name as equipment_name, e.location_name
    FROM notifications n
    JOIN equipment e ON n.equipment_id = e.id
    WHERE n.is_read = 0 AND n.priority = 'critical'
    ORDER BY n.created_at DESC
    LIMIT 1
  `);
  res.json(notification || null);
});

// Mark notification as read
router.put('/:id/read', requireAuth, requireAdmin, (req, res) => {
  runSql('UPDATE notifications SET is_read = 1 WHERE id = ?', [req.params.id]);
  saveDb();
  res.json({ message: 'Marked as read' });
});

// Mark all as read
router.put('/read-all', requireAuth, requireAdmin, (req, res) => {
  runSql('UPDATE notifications SET is_read = 1 WHERE is_read = 0');
  saveDb();
  res.json({ message: 'All marked as read' });
});

module.exports = router;
