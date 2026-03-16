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

// Alert history — aggregates all system events
router.get('/history', requireAuth, requireAdmin, (req, res) => {
  const history = [];

  // 1. Abnormality notifications (from notifications table)
  const abnormals = queryAll(`
    SELECT n.id, n.message, n.priority, n.is_read, n.created_at,
           e.name as equipment_name, e.location_name, 'abnormality' as alert_type
    FROM notifications n
    LEFT JOIN equipment e ON n.equipment_id = e.id
    ORDER BY n.created_at DESC
    LIMIT 200
  `);
  abnormals.forEach(a => history.push({
    id: a.id,
    type: 'abnormality',
    icon: a.priority === 'critical' ? '🚨' : '⚠️',
    title: `${a.equipment_name || 'Unknown'} — ${a.location_name || ''}`,
    message: a.message,
    priority: a.priority,
    is_read: a.is_read,
    created_at: a.created_at
  }));

  // 2. Overdue/missed schedule instances
  const overdue = queryAll(`
    SELECT si.id, si.status, si.due_date, si.assigned_employee_id,
           e.name as equipment_name, e.location_name,
           s.task_type, s.frequency
    FROM schedule_instances si
    JOIN equipment e ON si.equipment_id = e.id
    JOIN schedules s ON si.schedule_id = s.id
    WHERE si.status IN ('overdue', 'missed')
    ORDER BY si.due_date DESC
    LIMIT 200
  `);
  overdue.forEach(o => history.push({
    id: o.id,
    type: o.status === 'overdue' ? 'overdue' : 'missed',
    icon: o.status === 'overdue' ? '⏰' : '❌',
    title: `${o.equipment_name} — ${o.location_name || ''}`,
    message: `${o.task_type} task (${o.frequency}) ${o.status === 'overdue' ? 'is overdue' : 'was missed'} — due ${o.due_date}${o.assigned_employee_id ? ` (assigned: ${o.assigned_employee_id})` : ''}`,
    priority: o.status === 'overdue' ? 'high' : 'normal',
    is_read: 1,
    created_at: o.due_date
  }));

  // 3. Completed tasks (recent)
  const completed = queryAll(`
    SELECT si.id, si.completed_at, si.completed_by, si.due_date,
           e.name as equipment_name, e.location_name,
           s.task_type
    FROM schedule_instances si
    JOIN equipment e ON si.equipment_id = e.id
    JOIN schedules s ON si.schedule_id = s.id
    WHERE si.status = 'completed'
    ORDER BY si.completed_at DESC
    LIMIT 100
  `);
  completed.forEach(c => history.push({
    id: c.id,
    type: 'completed',
    icon: '✅',
    title: `${c.equipment_name} — ${c.location_name || ''}`,
    message: `${c.task_type} completed by ${c.completed_by || 'unknown'}`,
    priority: 'normal',
    is_read: 1,
    created_at: c.completed_at || c.due_date
  }));

  // 4. Recent audit log entries
  const audits = queryAll(`
    SELECT id, user_name, action, target_type, target_id, details, created_at
    FROM audit_log
    ORDER BY created_at DESC
    LIMIT 100
  `);
  audits.forEach(a => history.push({
    id: a.id,
    type: 'audit',
    icon: '📝',
    title: `${a.action} — ${a.target_type || ''}`,
    message: `${a.user_name || 'System'}: ${a.details || a.action}`,
    priority: 'normal',
    is_read: 1,
    created_at: a.created_at
  }));

  // Sort all by created_at descending
  history.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json(history.slice(0, 300));
});

module.exports = router;
