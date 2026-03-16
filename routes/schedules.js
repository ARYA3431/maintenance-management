const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { queryAll, queryOne, runSql, saveDb, getISTTimestamp } = require('../database');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ===== Helper: Calculate next due date from a given date and frequency =====
function calculateNextDueDate(fromDate, frequency) {
  const d = new Date(fromDate + 'T00:00:00+05:30');
  switch (frequency) {
    case 'daily': d.setDate(d.getDate() + 1); break;
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'biweekly': d.setDate(d.getDate() + 14); break;
    case 'monthly': d.setMonth(d.getMonth() + 1); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'yearly': d.setFullYear(d.getFullYear() + 1); break;
  }
  return d.toISOString().slice(0, 10);
}

// ===== Helper: Get today's date in IST =====
function getTodayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().slice(0, 10);
}

// ===== Generate instances for a schedule up to N days ahead =====
function generateInstances(schedule, daysAhead = 7) {
  const today = getTodayIST();
  const futureLimit = new Date(today + 'T00:00:00+05:30');
  futureLimit.setDate(futureLimit.getDate() + daysAhead);
  const futureLimitStr = futureLimit.toISOString().slice(0, 10);

  let nextDue = schedule.next_due_date || schedule.start_date;

  // Don't generate if schedule has ended
  if (schedule.end_date && nextDue > schedule.end_date) return;

  let generated = 0;
  while (nextDue <= futureLimitStr) {
    if (schedule.end_date && nextDue > schedule.end_date) break;

    // Check if instance already exists for this date
    const existing = queryOne(
      'SELECT id FROM schedule_instances WHERE schedule_id = ? AND due_date = ?',
      [schedule.id, nextDue]
    );

    if (!existing) {
      runSql(
        `INSERT INTO schedule_instances (id, schedule_id, equipment_id, task_type, due_date, status, assigned_employee_id, assigned_department, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [uuidv4(), schedule.id, schedule.equipment_id, schedule.task_type || 'inspection', nextDue,
         schedule.assigned_employee_id || null, schedule.assigned_department || null, getISTTimestamp()]
      );
      generated++;
    }

    nextDue = calculateNextDueDate(nextDue, schedule.frequency);
  }

  // Update next_due_date on the schedule
  runSql('UPDATE schedules SET next_due_date = ? WHERE id = ?', [nextDue, schedule.id]);

  return generated;
}

// ===== Update overdue/missed statuses =====
function updateOverdueStatuses() {
  const today = getTodayIST();
  const now = new Date();
  const istNow = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));

  // Mark pending instances past due_date as overdue
  const pendingPastDue = queryAll(
    "SELECT si.*, s.grace_period_hours FROM schedule_instances si JOIN schedules s ON si.schedule_id = s.id WHERE si.status = 'pending' AND si.due_date < ?",
    [today]
  );

  for (const inst of pendingPastDue) {
    const dueDate = new Date(inst.due_date + 'T23:59:59+05:30');
    const hoursOverdue = (istNow.getTime() - dueDate.getTime()) / (1000 * 60 * 60);

    if (hoursOverdue > 48) {
      runSql("UPDATE schedule_instances SET status = 'missed' WHERE id = ?", [inst.id]);
    } else {
      runSql("UPDATE schedule_instances SET status = 'overdue' WHERE id = ?", [inst.id]);
    }
  }

  // Mark overdue instances > 48h as missed
  const overdueInstances = queryAll(
    "SELECT si.* FROM schedule_instances si WHERE si.status = 'overdue'"
  );

  for (const inst of overdueInstances) {
    const dueDate = new Date(inst.due_date + 'T23:59:59+05:30');
    const hoursOverdue = (istNow.getTime() - dueDate.getTime()) / (1000 * 60 * 60);
    if (hoursOverdue > 48) {
      runSql("UPDATE schedule_instances SET status = 'missed' WHERE id = ?", [inst.id]);
    }
  }

  saveDb();
}

// ===== Generate engineer notifications =====
function generateEngineerNotifications() {
  const today = getTodayIST();
  const tomorrow = calculateNextDueDate(today, 'daily');

  // Due today notifications
  const dueToday = queryAll(`
    SELECT si.*, e.name as equipment_name, e.location_name, s.task_type
    FROM schedule_instances si
    JOIN equipment e ON si.equipment_id = e.id
    JOIN schedules s ON si.schedule_id = s.id
    WHERE si.due_date = ? AND si.status = 'pending'
  `, [today]);

  for (const inst of dueToday) {
    const existing = queryOne(
      "SELECT id FROM engineer_notifications WHERE instance_id = ? AND type = 'due_today'",
      [inst.id]
    );
    if (!existing) {
      const typeLabel = (inst.task_type || 'inspection') === 'maintenance' ? '🔧 maintenance' : '🔍 inspection';
      runSql(
        `INSERT INTO engineer_notifications (id, employee_id, department, instance_id, equipment_id, type, message, created_at)
         VALUES (?, ?, ?, ?, ?, 'due_today', ?, ?)`,
        [uuidv4(), inst.assigned_employee_id, inst.assigned_department, inst.id, inst.equipment_id,
         `📋 "${inst.equipment_name}" at ${inst.location_name} — ${typeLabel} due TODAY.`,
         getISTTimestamp()]
      );
    }
  }

  // Upcoming (tomorrow) notifications
  const upcoming = queryAll(`
    SELECT si.*, e.name as equipment_name, e.location_name, s.task_type
    FROM schedule_instances si
    JOIN equipment e ON si.equipment_id = e.id
    JOIN schedules s ON si.schedule_id = s.id
    WHERE si.due_date = ? AND si.status = 'pending'
  `, [tomorrow]);

  for (const inst of upcoming) {
    const existing = queryOne(
      "SELECT id FROM engineer_notifications WHERE instance_id = ? AND type = 'upcoming'",
      [inst.id]
    );
    if (!existing) {
      const typeLabel = (inst.task_type || 'inspection') === 'maintenance' ? '🔧 maintenance' : '🔍 inspection';
      runSql(
        `INSERT INTO engineer_notifications (id, employee_id, department, instance_id, equipment_id, type, message, created_at)
         VALUES (?, ?, ?, ?, ?, 'upcoming', ?, ?)`,
        [uuidv4(), inst.assigned_employee_id, inst.assigned_department, inst.id, inst.equipment_id,
         `🔔 "${inst.equipment_name}" at ${inst.location_name} — ${typeLabel} due TOMORROW.`,
         getISTTimestamp()]
      );
    }
  }

  // Overdue notifications
  const overdue = queryAll(`
    SELECT si.*, e.name as equipment_name, e.location_name, s.task_type
    FROM schedule_instances si
    JOIN equipment e ON si.equipment_id = e.id
    JOIN schedules s ON si.schedule_id = s.id
    WHERE si.status = 'overdue'
  `);

  for (const inst of overdue) {
    const existing = queryOne(
      "SELECT id FROM engineer_notifications WHERE instance_id = ? AND type = 'overdue' AND DATE(created_at) = ?",
      [inst.id, today]
    );
    if (!existing) {
      const dueDate = new Date(inst.due_date + 'T00:00:00+05:30');
      const todayDate = new Date(today + 'T00:00:00+05:30');
      const daysOverdue = Math.floor((todayDate - dueDate) / (1000 * 60 * 60 * 24));
      const typeLabel = (inst.task_type || 'inspection') === 'maintenance' ? '🔧 maintenance' : '🔍 inspection';
      runSql(
        `INSERT INTO engineer_notifications (id, employee_id, department, instance_id, equipment_id, type, message, created_at)
         VALUES (?, ?, ?, ?, ?, 'overdue', ?, ?)`,
        [uuidv4(), inst.assigned_employee_id, inst.assigned_department, inst.id, inst.equipment_id,
         `⚠️ OVERDUE: "${inst.equipment_name}" at ${inst.location_name} — ${typeLabel} ${daysOverdue} day(s) overdue!`,
         getISTTimestamp()]
      );
    }
  }

  saveDb();
}

// ===== Enhanced Escalation: Use escalation_rules table =====
function generateEscalations() {
  const overdue = queryAll(`
    SELECT si.*, e.name as equipment_name, e.location_name, e.is_critical,
           s.assigned_employee_id, s.assigned_department, s.frequency, s.task_type
    FROM schedule_instances si
    JOIN equipment e ON si.equipment_id = e.id
    JOIN schedules s ON si.schedule_id = s.id
    WHERE (si.status = 'overdue' OR si.status = 'missed') AND si.escalated = 0
  `);

  for (const inst of overdue) {
    const dueDate = new Date(inst.due_date + 'T23:59:59+05:30');
    const now = new Date();
    const istNow = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    const hoursOverdue = (istNow.getTime() - dueDate.getTime()) / (1000 * 60 * 60);

    // Look up escalation rule: equipment-specific first, then severity-based default
    const severity = inst.is_critical ? 'critical' : 'normal';
    let rule = queryOne(
      'SELECT * FROM escalation_rules WHERE equipment_id = ? AND severity = ?',
      [inst.equipment_id, severity]
    );
    if (!rule) {
      rule = queryOne(
        'SELECT * FROM escalation_rules WHERE equipment_id IS NULL AND severity = ?',
        [severity]
      );
    }

    const threshold = rule ? rule.hours_to_supervisor : (inst.is_critical ? 24 : 48);

    if (hoursOverdue >= threshold && (rule ? rule.auto_escalate : 1)) {
      const daysOverdue = Math.floor(hoursOverdue / 24);
      const assignee = inst.assigned_employee_id || inst.assigned_department || 'Unassigned';
      const typeLabel = (inst.task_type || 'inspection') === 'maintenance' ? 'maintenance' : 'inspection';

      let escalationLevel = 'Supervisor';
      let priority = 'normal';
      if (rule && hoursOverdue >= rule.hours_to_plant_head) { escalationLevel = 'Plant Head'; priority = 'critical'; }
      else if (rule && hoursOverdue >= rule.hours_to_manager) { escalationLevel = 'Manager'; priority = 'critical'; }
      else { priority = inst.is_critical ? 'critical' : 'normal'; }

      const dummyRecordId = inst.record_id || inst.id;
      runSql(
        `INSERT INTO notifications (id, record_id, equipment_id, message, priority, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), dummyRecordId, inst.equipment_id,
         `🚨 ESCALATION → ${escalationLevel}: "${inst.equipment_name}" at ${inst.location_name} — ${inst.frequency} ${typeLabel} is ${daysOverdue} day(s) overdue. Assigned to: ${assignee}.`,
         priority, getISTTimestamp()]
      );

      runSql('UPDATE schedule_instances SET escalated = 1 WHERE id = ?', [inst.id]);
    }
  }

  // Also escalate open findings based on escalation rules
  const openFindings = queryAll(`
    SELECT f.*, e.is_critical as eq_is_critical, e.name as equipment_name, e.location_name
    FROM findings f
    JOIN equipment e ON f.equipment_id = e.id
    WHERE f.status IN ('open','acknowledged') AND f.severity IN ('critical','emergency')
  `);

  for (const f of openFindings) {
    const createdAt = new Date(f.created_at);
    const now = new Date();
    const hoursOpen = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);

    let rule = queryOne('SELECT * FROM escalation_rules WHERE equipment_id = ? AND severity = ?', [f.equipment_id, f.severity]);
    if (!rule) rule = queryOne('SELECT * FROM escalation_rules WHERE equipment_id IS NULL AND severity = ?', [f.severity]);
    if (!rule) continue;

    if (rule.notify_on_create || hoursOpen >= rule.hours_to_supervisor) {
      // Check if already escalated today
      const today = getTodayIST();
      const existing = queryOne(
        "SELECT id FROM notifications WHERE equipment_id = ? AND message LIKE ? AND DATE(created_at) = ?",
        [f.equipment_id, `%finding: "${f.field_name}"%`, today]
      );
      if (existing) continue;

      runSql(
        `INSERT INTO notifications (id, record_id, equipment_id, message, priority, created_at)
         VALUES (?, ?, ?, ?, 'critical', ?)`,
        [uuidv4(), f.record_id, f.equipment_id,
         `🔴 CRITICAL FINDING: "${f.field_name}" on "${f.equipment_name}" — ${f.severity.toUpperCase()} | Value: ${f.reported_value} | Open ${Math.floor(hoursOpen)}h | ${f.is_repeat ? '🔁 REPEAT ISSUE' : 'New'}`,
         getISTTimestamp()]
      );
    }
  }

  saveDb();
}

// ===== Run all scheduled tasks (called periodically) =====
function runScheduledTasks() {
  const activeSchedules = queryAll("SELECT * FROM schedules WHERE is_active = 1");
  for (const schedule of activeSchedules) {
    generateInstances(schedule, 7);
  }
  updateOverdueStatuses();
  generateEngineerNotifications();
  generateEscalations();
  saveDb();
}

// ===== API ROUTES =====

// Get all schedules (admin)
router.get('/', requireAuth, requireAdmin, (req, res) => {
  const schedules = queryAll(`
    SELECT s.*, e.name as equipment_name, e.location_name, e.is_critical
    FROM schedules s
    JOIN equipment e ON s.equipment_id = e.id
    ORDER BY s.created_at DESC
  `);
  res.json(schedules);
});

// Create a new schedule
router.post('/', requireAuth, requireAdmin, (req, res) => {
  const { equipment_id, task_type, frequency, assigned_employee_id, assigned_department, start_date, end_date, grace_period_hours } = req.body;

  if (!equipment_id || !frequency || !start_date) {
    return res.status(400).json({ error: 'Equipment, frequency, and start date are required.' });
  }

  const validFreqs = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
  if (!validFreqs.includes(frequency)) {
    return res.status(400).json({ error: 'Invalid frequency.' });
  }

  const validType = (task_type === 'inspection' || task_type === 'maintenance') ? task_type : 'inspection';

  const equipment = queryOne('SELECT id FROM equipment WHERE id = ?', [equipment_id]);
  if (!equipment) return res.status(404).json({ error: 'Equipment not found.' });

  // Prevent duplicate schedules (same equipment + task type + frequency + department)
  const duplicate = queryOne(
    `SELECT id FROM schedules WHERE equipment_id = ? AND task_type = ? AND frequency = ? AND assigned_department = ? AND is_active = 1`,
    [equipment_id, validType, frequency, assigned_department || null]
  );
  if (duplicate) {
    return res.status(409).json({ error: 'A schedule with the same equipment, task type, frequency, and department already exists.' });
  }

  const id = uuidv4();
  runSql(
    `INSERT INTO schedules (id, equipment_id, task_type, frequency, assigned_employee_id, assigned_department, start_date, end_date, grace_period_hours, is_active, next_due_date, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [id, equipment_id, validType, frequency, assigned_employee_id || null, assigned_department || null,
     start_date, end_date || null, grace_period_hours || 24, start_date,
     req.session.userId, getISTTimestamp()]
  );

  // Generate initial instances
  const schedule = queryOne('SELECT * FROM schedules WHERE id = ?', [id]);
  generateInstances(schedule, 7);
  saveDb();

  res.status(201).json({ id, message: 'Schedule created successfully.' });
});

// Update a schedule
router.put('/:id', requireAuth, requireAdmin, (req, res) => {
  const { frequency, assigned_employee_id, assigned_department, end_date, grace_period_hours, is_active } = req.body;
  const schedule = queryOne('SELECT * FROM schedules WHERE id = ?', [req.params.id]);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found.' });

  runSql(
    `UPDATE schedules SET frequency = ?, assigned_employee_id = ?, assigned_department = ?, end_date = ?, grace_period_hours = ?, is_active = ? WHERE id = ?`,
    [frequency || schedule.frequency, assigned_employee_id ?? schedule.assigned_employee_id,
     assigned_department ?? schedule.assigned_department, end_date ?? schedule.end_date,
     grace_period_hours || schedule.grace_period_hours, is_active != null ? is_active : schedule.is_active,
     req.params.id]
  );
  saveDb();
  res.json({ message: 'Schedule updated.' });
});

// Delete a schedule
router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  runSql('DELETE FROM schedules WHERE id = ?', [req.params.id]);
  saveDb();
  res.json({ message: 'Schedule deleted.' });
});

// Get schedule instances with filters
router.get('/instances', requireAuth, requireAdmin, (req, res) => {
  const { schedule_id, equipment_id, status, date_from, date_to, assigned_employee_id } = req.query;

  let sql = `
    SELECT si.*, e.name as equipment_name, e.location_name, e.is_critical, s.frequency
    FROM schedule_instances si
    JOIN equipment e ON si.equipment_id = e.id
    JOIN schedules s ON si.schedule_id = s.id
    WHERE 1=1
  `;
  const params = [];

  if (schedule_id) { sql += ' AND si.schedule_id = ?'; params.push(schedule_id); }
  if (equipment_id) { sql += ' AND si.equipment_id = ?'; params.push(equipment_id); }
  if (status) { sql += ' AND si.status = ?'; params.push(status); }
  if (assigned_employee_id) { sql += ' AND si.assigned_employee_id = ?'; params.push(assigned_employee_id); }
  if (date_from) { sql += ' AND si.due_date >= ?'; params.push(date_from); }
  if (date_to) { sql += ' AND si.due_date <= ?'; params.push(date_to); }

  sql += ' ORDER BY si.due_date ASC LIMIT 500';
  res.json(queryAll(sql, params));
});

// Get compliance stats (admin dashboard)
router.get('/compliance', requireAuth, requireAdmin, (req, res) => {
  const total = queryOne('SELECT COUNT(*) as count FROM schedule_instances') || { count: 0 };
  const completed = queryOne("SELECT COUNT(*) as count FROM schedule_instances WHERE status = 'completed'") || { count: 0 };
  const overdue = queryOne("SELECT COUNT(*) as count FROM schedule_instances WHERE status = 'overdue'") || { count: 0 };
  const missed = queryOne("SELECT COUNT(*) as count FROM schedule_instances WHERE status = 'missed'") || { count: 0 };
  const pending = queryOne("SELECT COUNT(*) as count FROM schedule_instances WHERE status = 'pending'") || { count: 0 };

  const today = getTodayIST();
  const dueToday = queryOne("SELECT COUNT(*) as count FROM schedule_instances WHERE due_date = ? AND status = 'pending'", [today]) || { count: 0 };

  const complianceRate = total.count > 0 ? Math.round((completed.count / total.count) * 100) : 100;

  // Per-equipment compliance
  const equipmentCompliance = queryAll(`
    SELECT e.id, e.name, e.location_name,
      COUNT(si.id) as total_instances,
      SUM(CASE WHEN si.status = 'completed' THEN 1 ELSE 0 END) as completed_instances,
      SUM(CASE WHEN si.status = 'overdue' THEN 1 ELSE 0 END) as overdue_instances,
      SUM(CASE WHEN si.status = 'missed' THEN 1 ELSE 0 END) as missed_instances
    FROM schedule_instances si
    JOIN equipment e ON si.equipment_id = e.id
    GROUP BY e.id
    ORDER BY completed_instances * 1.0 / MAX(COUNT(si.id), 1) ASC
  `);

  // Per-engineer compliance
  const engineerCompliance = queryAll(`
    SELECT si.assigned_employee_id as employee_id,
      COUNT(si.id) as total_assigned,
      SUM(CASE WHEN si.status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN si.status = 'overdue' THEN 1 ELSE 0 END) as overdue,
      SUM(CASE WHEN si.status = 'missed' THEN 1 ELSE 0 END) as missed
    FROM schedule_instances si
    WHERE si.assigned_employee_id IS NOT NULL
    GROUP BY si.assigned_employee_id
  `);

  res.json({
    total: total.count,
    completed: completed.count,
    overdue: overdue.count,
    missed: missed.count,
    pending: pending.count,
    due_today: dueToday.count,
    compliance_rate: complianceRate,
    equipment_compliance: equipmentCompliance,
    engineer_compliance: engineerCompliance
  });
});

// Calendar view — get instances for a month
router.get('/calendar', requireAuth, requireAdmin, (req, res) => {
  const { year, month } = req.query;
  const y = parseInt(year) || new Date().getFullYear();
  const m = parseInt(month) || (new Date().getMonth() + 1);
  const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
  const endMonth = m === 12 ? 1 : m + 1;
  const endYear = m === 12 ? y + 1 : y;
  const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

  const instances = queryAll(`
    SELECT si.*, e.name as equipment_name, e.location_name, s.frequency
    FROM schedule_instances si
    JOIN equipment e ON si.equipment_id = e.id
    JOIN schedules s ON si.schedule_id = s.id
    WHERE si.due_date >= ? AND si.due_date < ?
    ORDER BY si.due_date ASC
  `, [startDate, endDate]);

  res.json(instances);
});

// Engineer tasks — get tasks for a specific employee
router.get('/my-tasks', (req, res) => {
  if (!req.session.employeeId) {
    return res.status(401).json({ error: 'Employee verification required.' });
  }

  const employeeId = req.session.employeeId;
  const department = req.session.department;
  const today = getTodayIST();

  // Get tasks assigned to this employee OR their department
  const tasks = queryAll(`
    SELECT si.*, e.name as equipment_name, e.location_name, e.description as equipment_description,
           e.qr_token, s.frequency, s.task_type
    FROM schedule_instances si
    JOIN equipment e ON si.equipment_id = e.id
    JOIN schedules s ON si.schedule_id = s.id
    WHERE (si.assigned_employee_id = ? OR (si.assigned_employee_id IS NULL AND si.assigned_department = ?))
      AND si.status IN ('pending', 'overdue')
      AND s.is_active = 1
    ORDER BY
      CASE si.status WHEN 'overdue' THEN 0 WHEN 'pending' THEN 1 END,
      si.due_date ASC
    LIMIT 50
  `, [employeeId, department]);

  // Split into categories
  const overdueList = tasks.filter(t => t.status === 'overdue');
  const dueTodayList = tasks.filter(t => t.status === 'pending' && t.due_date === today);
  const upcomingList = tasks.filter(t => t.status === 'pending' && t.due_date > today);

  // Completion stats for this week
  const weekAgo = new Date(today + 'T00:00:00+05:30');
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString().slice(0, 10);

  const weekStats = queryOne(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM schedule_instances
    WHERE (assigned_employee_id = ? OR (assigned_employee_id IS NULL AND assigned_department = ?))
      AND due_date >= ? AND due_date <= ?
  `, [employeeId, department, weekAgoStr, today]);

  res.json({
    overdue: overdueList,
    due_today: dueTodayList,
    upcoming: upcomingList,
    week_total: weekStats ? weekStats.total : 0,
    week_completed: weekStats ? weekStats.completed : 0
  });
});

// Engineer notifications
router.get('/my-notifications', (req, res) => {
  if (!req.session.employeeId) {
    return res.status(401).json({ error: 'Employee verification required.' });
  }

  const employeeId = req.session.employeeId;
  const department = req.session.department;

  const notifications = queryAll(`
    SELECT en.*, e.name as equipment_name, e.location_name
    FROM engineer_notifications en
    JOIN equipment e ON en.equipment_id = e.id
    WHERE (en.employee_id = ? OR (en.employee_id IS NULL AND en.department = ?))
    ORDER BY en.created_at DESC
    LIMIT 50
  `, [employeeId, department]);

  res.json(notifications);
});

// Mark engineer notification as read
router.put('/my-notifications/:id/read', (req, res) => {
  runSql('UPDATE engineer_notifications SET is_read = 1 WHERE id = ?', [req.params.id]);
  saveDb();
  res.json({ message: 'Marked as read.' });
});

// Accept a task (engineer)
router.put('/instances/:id/accept', (req, res) => {
  if (!req.session.employeeId) return res.status(401).json({ error: 'Employee verification required.' });

  const instance = queryOne('SELECT * FROM schedule_instances WHERE id = ?', [req.params.id]);
  if (!instance) return res.status(404).json({ error: 'Task not found.' });

  if (instance.status !== 'pending' && instance.status !== 'overdue') {
    return res.status(400).json({ error: `Cannot accept a task with status '${instance.status}'.` });
  }

  const istNow = getISTTimestamp();
  runSql('UPDATE schedule_instances SET accepted_at = ?, assigned_employee_id = ? WHERE id = ?',
    [istNow, req.session.employeeId, req.params.id]);
  saveDb();

  res.json({ message: 'Task accepted.' });
});

// Start work on a task (engineer)
router.put('/instances/:id/start', (req, res) => {
  if (!req.session.employeeId) return res.status(401).json({ error: 'Employee verification required.' });

  const instance = queryOne('SELECT * FROM schedule_instances WHERE id = ?', [req.params.id]);
  if (!instance) return res.status(404).json({ error: 'Task not found.' });

  const istNow = getISTTimestamp();
  runSql('UPDATE schedule_instances SET started_at = ? WHERE id = ?', [istNow, req.params.id]);
  saveDb();

  res.json({ message: 'Work started.' });
});

// Block a task with reason (engineer)
router.put('/instances/:id/block', (req, res) => {
  if (!req.session.employeeId) return res.status(401).json({ error: 'Employee verification required.' });

  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Block reason is required.' });

  const instance = queryOne('SELECT * FROM schedule_instances WHERE id = ?', [req.params.id]);
  if (!instance) return res.status(404).json({ error: 'Task not found.' });

  runSql('UPDATE schedule_instances SET blocked_reason = ? WHERE id = ?', [reason, req.params.id]);
  saveDb();

  // Notify admin about blocked task
  const equip = queryOne('SELECT name, location_name FROM equipment WHERE id = ?', [instance.equipment_id]);
  runSql(`INSERT INTO notifications (id, record_id, equipment_id, message, priority, created_at) VALUES (?, ?, ?, ?, 'normal', ?)`,
    [uuidv4(), instance.id, instance.equipment_id,
     `🚧 TASK BLOCKED: "${equip ? equip.name : 'Equipment'}" — by ${req.session.fullName || req.session.employeeId}. Reason: ${reason}`,
     getISTTimestamp()]);
  saveDb();

  res.json({ message: 'Task marked as blocked.' });
});

// Supervisor review of instance
router.put('/instances/:id/review', requireAuth, requireAdmin, (req, res) => {
  const { notes } = req.body;
  const instance = queryOne('SELECT * FROM schedule_instances WHERE id = ?', [req.params.id]);
  if (!instance) return res.status(404).json({ error: 'Instance not found.' });

  const istNow = getISTTimestamp();
  runSql('UPDATE schedule_instances SET reviewed_by = ?, reviewed_at = ?, review_notes = ? WHERE id = ?',
    [req.session.userId || req.session.fullName, istNow, notes || null, req.params.id]);

  runSql(`INSERT INTO review_actions (id, instance_id, action_type, action_by, action_by_name, notes, created_at) VALUES (?, ?, 'approve', ?, ?, ?, ?)`,
    [uuidv4(), req.params.id, req.session.userId, req.session.fullName || 'Admin', notes || null, istNow]);

  saveDb();
  res.json({ message: 'Instance reviewed.' });
});

// Trigger task processing manually (also called on interval)
router.post('/process', requireAuth, requireAdmin, (req, res) => {
  runScheduledTasks();
  res.json({ message: 'Scheduled tasks processed.' });
});

// Get list of departments from employees data
router.get('/departments', requireAuth, (req, res) => {
  // Get unique departments from maintenance_records and schedules
  const depts = queryAll("SELECT DISTINCT assigned_department as department FROM schedules WHERE assigned_department IS NOT NULL");
  const recordDepts = queryAll("SELECT DISTINCT employee_department as department FROM maintenance_records WHERE employee_department IS NOT NULL");
  const all = new Set();
  depts.forEach(d => { if (d.department) all.add(d.department); });
  recordDepts.forEach(d => { if (d.department) all.add(d.department); });
  // Add common defaults
  ['Operations', 'Electrical', 'Mechanical'].forEach(d => all.add(d));
  res.json([...all].sort());
});

// Get list of ALL employees from Excel + any from records
router.get('/employees', requireAuth, (req, res) => {
  const { getAllEmployees } = require('../employees');
  const allExcel = getAllEmployees();
  // Also get employees from maintenance_records as fallback
  const fromRecords = queryAll("SELECT DISTINCT employee_id, employee_name, employee_department FROM maintenance_records WHERE employee_id IS NOT NULL");
  // Merge: Excel employees take priority
  const map = new Map();
  fromRecords.forEach(e => map.set(e.employee_id, { employee_id: e.employee_id, employee_name: e.employee_name, employee_department: e.employee_department || '' }));
  allExcel.forEach(e => map.set(e.employeeId, { employee_id: e.employeeId, employee_name: e.fullName, employee_department: e.department || '' }));
  const merged = Array.from(map.values()).sort((a, b) => (a.employee_name || '').localeCompare(b.employee_name || ''));
  res.json(merged);
});

// ===== FOLLOW-UP & NON-COMPLIANCE TRACKING =====

// Get follow-up tracking table — all pending/overdue instances with assigned person details
router.get('/follow-up', requireAuth, requireAdmin, (req, res) => {
  const { task_type, status, department, equipment_id } = req.query;

  let sql = `
    SELECT si.*, e.name as equipment_name, e.location_name, e.is_critical,
           s.frequency, s.task_type, s.assigned_employee_id as sched_employee,
           s.assigned_department as sched_department
    FROM schedule_instances si
    JOIN equipment e ON si.equipment_id = e.id
    JOIN schedules s ON si.schedule_id = s.id
    WHERE si.status IN ('pending', 'overdue', 'missed')
      AND s.is_active = 1
  `;
  const params = [];

  if (task_type) { sql += ' AND s.task_type = ?'; params.push(task_type); }
  if (status) { sql += ' AND si.status = ?'; params.push(status); }
  if (department) { sql += ' AND si.assigned_department = ?'; params.push(department); }
  if (equipment_id) { sql += ' AND si.equipment_id = ?'; params.push(equipment_id); }

  sql += ' ORDER BY CASE si.status WHEN \'overdue\' THEN 0 WHEN \'missed\' THEN 1 WHEN \'pending\' THEN 2 END, si.due_date ASC LIMIT 500';

  const instances = queryAll(sql, params);
  res.json(instances);
});

// Get defaulters / non-compliance report
router.get('/defaulters', requireAuth, requireAdmin, (req, res) => {
  const { task_type } = req.query;

  // Get all assigned employees/departments who have overdue or missed tasks
  let filterClause = '';
  const params = [];
  if (task_type) { filterClause = ' AND s.task_type = ?'; params.push(task_type); }

  // Per-employee defaulter report
  const employeeDefaulters = queryAll(`
    SELECT
      COALESCE(si.assigned_employee_id, 'Unassigned') as employee_id,
      si.assigned_department as department,
      COUNT(si.id) as total_assigned,
      SUM(CASE WHEN si.status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN si.status = 'overdue' THEN 1 ELSE 0 END) as overdue,
      SUM(CASE WHEN si.status = 'missed' THEN 1 ELSE 0 END) as missed,
      SUM(CASE WHEN si.status = 'pending' THEN 1 ELSE 0 END) as pending,
      MAX(CASE WHEN si.status = 'completed' THEN si.completed_at ELSE NULL END) as last_completed_at,
      MIN(CASE WHEN si.status IN ('overdue','missed') THEN si.due_date ELSE NULL END) as oldest_overdue_date
    FROM schedule_instances si
    JOIN schedules s ON si.schedule_id = s.id
    WHERE s.is_active = 1 ${filterClause}
    GROUP BY COALESCE(si.assigned_employee_id, 'Unassigned'), si.assigned_department
    HAVING overdue > 0 OR missed > 0
    ORDER BY (overdue + missed) DESC
  `, params);

  // Per-equipment summary
  const equipmentSummary = queryAll(`
    SELECT
      e.id, e.name, e.location_name, e.is_critical,
      s.task_type,
      COUNT(si.id) as total_instances,
      SUM(CASE WHEN si.status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN si.status = 'overdue' THEN 1 ELSE 0 END) as overdue,
      SUM(CASE WHEN si.status = 'missed' THEN 1 ELSE 0 END) as missed,
      SUM(CASE WHEN si.status = 'pending' THEN 1 ELSE 0 END) as pending,
      MAX(CASE WHEN si.status = 'completed' THEN si.completed_at ELSE NULL END) as last_completed_at
    FROM schedule_instances si
    JOIN equipment e ON si.equipment_id = e.id
    JOIN schedules s ON si.schedule_id = s.id
    WHERE s.is_active = 1 ${filterClause}
    GROUP BY e.id, s.task_type
    ORDER BY (SUM(CASE WHEN si.status = 'overdue' THEN 1 ELSE 0 END) + SUM(CASE WHEN si.status = 'missed' THEN 1 ELSE 0 END)) DESC
  `, params);

  res.json({
    employee_defaulters: employeeDefaulters,
    equipment_summary: equipmentSummary
  });
});

module.exports = router;
module.exports.runScheduledTasks = runScheduledTasks;
