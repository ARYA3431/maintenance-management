const express = require('express');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { queryAll, queryOne, runSql, saveDb, getISTTimestamp } = require('../database');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.userId && !req.session.employeeId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireEmployee(req, res, next) {
  if (!req.session.employeeId) return res.status(401).json({ error: 'Employee verification required' });
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

function logAudit(userId, userName, action, targetType, targetId, details, ip) {
  runSql(
    `INSERT INTO audit_log (id, user_id, user_name, action, target_type, target_id, details, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), userId || null, userName || null, action, targetType || null, targetId || null, details || null, ip || null, getISTTimestamp()]
  );
}

// Submit maintenance record
router.post('/submit', requireEmployee, (req, res) => {
  const { equipment_id, task_type, values, notes, user_lat, user_lng, accuracy, scan_session_id, photo,
          work_done, parts_replaced, time_spent_minutes, corrective_action, abnormal_reason } = req.body;

  if (!equipment_id || !values) {
    return res.status(400).json({ error: 'Equipment ID and values are required' });
  }

  const validTaskType = (task_type === 'inspection' || task_type === 'maintenance') ? task_type : 'inspection';

  const equipment = queryOne('SELECT * FROM equipment WHERE id = ?', [equipment_id]);
  if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

  const employeeId = req.session.employeeId;
  const employeeName = req.session.fullName;
  const employeeDept = req.session.department;

  // Verify scan session
  let scanSession = null;
  let dwellTimeMinutes = 0;
  if (scan_session_id) {
    scanSession = queryOne(
      'SELECT * FROM scan_sessions WHERE id = ? AND equipment_id = ?',
      [scan_session_id, equipment_id]
    );

    if (!scanSession) {
      return res.status(400).json({ error: 'Invalid scan session. Please scan the QR code again.' });
    }
    if (scanSession.is_used) {
      return res.status(400).json({ error: 'This scan session has already been used. Please scan the QR code again.' });
    }
    if (new Date(scanSession.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Scan session expired. Please scan the QR code again.' });
    }

    const scanTime = new Date(scanSession.scanned_at).getTime();
    dwellTimeMinutes = (Date.now() - scanTime) / 60000;

    // Mark session as used
    runSql('UPDATE scan_sessions SET is_used = 1 WHERE id = ?', [scan_session_id]);
  }

  // Calculate distance and verification status
  let distance = null;
  let verificationStatus = 'unverified';
  const forceSubmit = req.body.force_submit === true;

  if (user_lat != null && user_lng != null) {
    distance = getDistanceMeters(equipment.latitude, equipment.longitude, user_lat, user_lng);

    if (distance > equipment.radius_meters) {
      if (!forceSubmit) {
        return res.status(403).json({
          error: `You are ${Math.round(distance)}m away from the equipment (allowed: ${equipment.radius_meters}m). Please go to the equipment location, or tap "Submit Always" to submit anyway.`,
          distance: Math.round(distance),
          allowed_radius: equipment.radius_meters
        });
      }
      // Force submit — mark as override so admin can see it
      verificationStatus = 'override';
    } else {
      verificationStatus = 'verified';
    }
  }

  // Save photo to disk if provided
  let photoPath = null;
  if (photo && typeof photo === 'string' && photo.startsWith('data:image/')) {
    const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    const base64Data = photo.replace(/^data:image\/\w+;base64,/, '');
    const fileName = `photo_${uuidv4()}.jpg`;
    fs.writeFileSync(path.join(uploadsDir, fileName), base64Data, 'base64');
    photoPath = `/uploads/${fileName}`;
  }

  // Get field definitions for abnormality check
  const fields = queryAll('SELECT * FROM maintenance_fields WHERE equipment_id = ?', [equipment_id]);
  const fieldMap = {};
  fields.forEach(f => { fieldMap[f.id] = f; });

  let hasAbnormality = false;
  let hasCriticalAbnormality = false;
  const processedValues = [];

  for (const val of values) {
    let isAbnormal = false;
    const fieldDef = fieldMap[val.field_id];

    if (fieldDef) {
      if (fieldDef.field_type === 'number' && val.value !== '' && val.value != null) {
        const numVal = parseFloat(val.value);
        if (!isNaN(numVal)) {
          if (fieldDef.min_value != null && numVal < fieldDef.min_value) isAbnormal = true;
          if (fieldDef.max_value != null && numVal > fieldDef.max_value) isAbnormal = true;
        }
      }
      if (fieldDef.field_type === 'select' && val.value) {
        const lower = val.value.toLowerCase();
        if (['abnormal', 'faulty', 'bad', 'critical', 'not working', 'damaged', 'broken', 'severe', 'disabled'].includes(lower)) {
          isAbnormal = true;
        }
      }
      if (fieldDef.field_type === 'checkbox' && val.value === 'true') {
        if (fieldDef.field_name.toLowerCase().includes('abnormal') ||
            fieldDef.field_name.toLowerCase().includes('issue') ||
            fieldDef.field_name.toLowerCase().includes('fault') ||
            fieldDef.field_name.toLowerCase().includes('leak') ||
            fieldDef.field_name.toLowerCase().includes('damage')) {
          isAbnormal = true;
        }
      }
    }

    if (isAbnormal) {
      hasAbnormality = true;
      if (fieldDef && fieldDef.is_critical) {
        hasCriticalAbnormality = true;
      }
    }
    processedValues.push({ ...val, is_abnormal: isAbnormal ? 1 : 0 });
  }

  const recordId = uuidv4();
  const istNow = getISTTimestamp();

  runSql(
    `INSERT INTO maintenance_records (id, equipment_id, employee_id, employee_name, employee_department, has_abnormality, notes, latitude, longitude, accuracy, distance_meters, scan_session_id, verification_status, photo_path, status, task_type, work_done, parts_replaced, time_spent_minutes, corrective_action, abnormal_reason, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [recordId, equipment_id, employeeId, employeeName, employeeDept, hasAbnormality ? 1 : 0, notes || '',
     user_lat, user_lng, accuracy || null,
     distance != null ? Math.round(distance) : null,
     scan_session_id || null, verificationStatus, photoPath, 'pending', validTaskType,
     work_done || null, parts_replaced || null, time_spent_minutes || null,
     corrective_action || null, abnormal_reason || null, istNow]
  );

  for (const val of processedValues) {
    runSql(
      `INSERT INTO maintenance_values (id, record_id, field_id, value, is_abnormal) VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), recordId, val.field_id, val.value || '', val.is_abnormal]
    );
  }

  // Auto-link to nearest pending/overdue schedule instance for this equipment and task_type
  const pendingInstance = queryOne(`
    SELECT si.id FROM schedule_instances si
    JOIN schedules s ON si.schedule_id = s.id
    WHERE si.equipment_id = ? AND si.status IN ('pending', 'overdue')
      AND s.is_active = 1 AND s.task_type = ?
    ORDER BY si.due_date ASC LIMIT 1
  `, [equipment_id, validTaskType]);

  if (pendingInstance) {
    runSql(
      "UPDATE schedule_instances SET status = 'completed', completed_by = ?, completed_at = ?, record_id = ? WHERE id = ?",
      [employeeId, istNow, recordId, pendingInstance.id]
    );
  }

  // === Create findings for abnormal values ===
  let overallSeverity = 'normal';
  if (hasAbnormality) {
    for (const val of processedValues) {
      if (!val.is_abnormal) continue;
      const fieldDef = fieldMap[val.field_id];
      if (!fieldDef) continue;

      // Determine severity
      let severity = 'warning';
      let exceptionClass = 'abnormal_but_running';
      if (fieldDef.is_critical) {
        severity = 'critical';
        exceptionClass = 'urgent_maintenance';
      }

      // Check for repeats — same field + same equipment with open findings
      const existingOpen = queryOne(
        `SELECT id, repeat_count FROM findings WHERE equipment_id = ? AND field_id = ? AND status IN ('open','acknowledged','in_progress') ORDER BY created_at DESC LIMIT 1`,
        [equipment_id, val.field_id]
      );

      let isRepeat = 0;
      let repeatCount = 0;
      let parentFindingId = null;
      if (existingOpen) {
        isRepeat = 1;
        repeatCount = (existingOpen.repeat_count || 0) + 1;
        parentFindingId = existingOpen.id;
        // Escalate severity if repeated
        if (repeatCount >= 3) { severity = 'emergency'; exceptionClass = 'immediate_shutdown'; }
        else if (repeatCount >= 2) { severity = 'critical'; exceptionClass = 'urgent_maintenance'; }
        // Update parent repeat count
        runSql('UPDATE findings SET repeat_count = ? WHERE id = ?', [repeatCount, existingOpen.id]);
      }

      // Historical repeat detection — same field abnormal in last 30 days
      if (!isRepeat) {
        const recentCount = queryOne(
          `SELECT COUNT(*) as cnt FROM findings WHERE equipment_id = ? AND field_id = ? AND created_at >= datetime('now', '-30 days')`,
          [equipment_id, val.field_id]
        );
        if (recentCount && recentCount.cnt >= 2) {
          isRepeat = 1;
          repeatCount = recentCount.cnt;
        }
      }

      const normalRange = (fieldDef.min_value != null || fieldDef.max_value != null)
        ? `${fieldDef.min_value ?? '—'} to ${fieldDef.max_value ?? '—'}` : null;

      runSql(
        `INSERT INTO findings (id, record_id, equipment_id, field_id, field_name, reported_value, normal_range, severity, exception_class, status, assigned_department, reported_by, reported_by_name, is_repeat, repeat_count, parent_finding_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), recordId, equipment_id, val.field_id, fieldDef.field_name, val.value, normalRange,
         severity, exceptionClass, employeeDept, employeeId, employeeName,
         isRepeat, repeatCount, parentFindingId, istNow]
      );

      if (severity === 'critical' || severity === 'emergency') overallSeverity = severity;
      else if (severity === 'warning' && overallSeverity === 'normal') overallSeverity = 'warning';
    }

    // Update record with overall severity and critical flag
    runSql('UPDATE maintenance_records SET severity = ?, has_critical_abnormality = ? WHERE id = ?',
      [overallSeverity, hasCriticalAbnormality ? 1 : 0, recordId]);
  }

  // Notify admin
  const shouldNotify = hasAbnormality || equipment.is_critical;

  if (shouldNotify) {
    const abnormalFields = processedValues
      .filter(v => v.is_abnormal)
      .map(v => {
        const f = fieldMap[v.field_id];
        return f ? `${f.field_name}${f.is_critical ? ' [CRITICAL]' : ''}: ${v.value}` : v.value;
      });

    const criticalFieldNames = processedValues
      .filter(v => v.is_abnormal && fieldMap[v.field_id] && fieldMap[v.field_id].is_critical)
      .map(v => fieldMap[v.field_id].field_name);

    const userName = employeeName || 'Unknown';
    let message = '';
    let priority = 'normal';

    if (hasCriticalAbnormality) {
      priority = 'critical';
      message = `🚨 CRITICAL FIELD ALERT on "${equipment.name}" at ${equipment.location_name}. ` +
        `Reported by: ${userName}. ` +
        `GPS: ${verificationStatus}${distance != null ? ` (${Math.round(distance)}m away)` : ''}. ` +
        `Dwell time: ${dwellTimeMinutes.toFixed(1)} min. ` +
        `Critical fields: ${criticalFieldNames.join(', ')}. ` +
        `Abnormal readings: ${abnormalFields.join(', ')}. ` +
        `Notes: ${notes || 'None'}`;
    } else if (hasAbnormality) {
      message = `⚠️ ABNORMALITY on "${equipment.name}" at ${equipment.location_name}. ` +
        `By: ${userName}. GPS: ${verificationStatus}. ` +
        `Abnormal: ${abnormalFields.join(', ')}. Notes: ${notes || 'None'}`;
    } else {
      message = `📋 ROUTINE CHECK: "${equipment.name}" at ${equipment.location_name}. ` +
        `By: ${userName}. GPS: ${verificationStatus}. Notes: ${notes || 'None'}`;
    }

    runSql(
      `INSERT INTO notifications (id, record_id, equipment_id, message, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), recordId, equipment_id, message, priority, istNow]
    );
  }

  // Audit log
  logAudit(employeeId, employeeName, 'submit_report',
    'maintenance_record', recordId,
    JSON.stringify({
      equipment: equipment.name,
      task_type: validTaskType,
      verification: verificationStatus,
      distance: distance != null ? Math.round(distance) : null,
      has_abnormality: hasAbnormality,
      has_critical: hasCriticalAbnormality,
      dwell_time_min: Math.round(dwellTimeMinutes * 10) / 10,
      has_photo: !!photoPath
    }),
    req.ip
  );

  saveDb();

  res.status(201).json({
    id: recordId,
    has_abnormality: hasAbnormality,
    has_critical_abnormality: hasCriticalAbnormality,
    is_critical: !!equipment.is_critical,
    verification_status: verificationStatus,
    dwell_time_minutes: Math.round(dwellTimeMinutes * 10) / 10,
    message: hasCriticalAbnormality
      ? 'Maintenance record submitted. 🚨 CRITICAL FIELD ABNORMALITY — Management has been notified URGENTLY.'
      : hasAbnormality
        ? 'Maintenance record submitted. ⚠️ ABNORMALITY DETECTED — Management has been notified.'
        : equipment.is_critical
          ? 'Maintenance record submitted. Critical equipment report sent to management.'
          : 'Maintenance record submitted successfully.'
  });
});

// Get maintenance history for an equipment
router.get('/history/:equipmentId', requireAuth, (req, res) => {
  const records = queryAll(`
    SELECT mr.*
    FROM maintenance_records mr
    WHERE mr.equipment_id = ?
    ORDER BY mr.submitted_at DESC
    LIMIT 50
  `, [req.params.equipmentId]);

  const result = records.map(record => ({
    ...record,
    values: queryAll(`
      SELECT mv.*, mf.field_name, mf.field_type, mf.is_critical as field_is_critical
      FROM maintenance_values mv
      JOIN maintenance_fields mf ON mv.field_id = mf.id
      WHERE mv.record_id = ?
    `, [record.id])
  }));

  res.json(result);
});

// ===== Admin Reports =====

// Get all reports with filters
router.get('/reports', requireAuth, requireAdmin, (req, res) => {
  const { equipment_id, engineer_id, status, verification, date_from, date_to, has_abnormality } = req.query;

  let sql = `
    SELECT mr.*,
           e.name as equipment_name, e.location_name, e.latitude as eq_lat, e.longitude as eq_lng, e.radius_meters,
           e.is_critical as eq_is_critical
    FROM maintenance_records mr
    JOIN equipment e ON mr.equipment_id = e.id
    WHERE 1=1
  `;
  const params = [];

  if (equipment_id) { sql += ' AND mr.equipment_id = ?'; params.push(equipment_id); }
  if (engineer_id) { sql += ' AND mr.employee_id = ?'; params.push(engineer_id); }
  if (status) { sql += ' AND mr.status = ?'; params.push(status); }
  if (verification) { sql += ' AND mr.verification_status = ?'; params.push(verification); }
  if (has_abnormality === '1') { sql += ' AND mr.has_abnormality = 1'; }
  if (has_abnormality === '0') { sql += ' AND mr.has_abnormality = 0'; }
  if (date_from) { sql += ' AND mr.submitted_at >= ?'; params.push(date_from); }
  if (date_to) { sql += ' AND mr.submitted_at <= ?'; params.push(date_to + ' 23:59:59'); }

  sql += ' ORDER BY mr.submitted_at DESC LIMIT 200';

  const records = queryAll(sql, params);

  const result = records.map(record => {
    // Get scan session info if available
    let scanInfo = null;
    if (record.scan_session_id) {
      scanInfo = queryOne('SELECT * FROM scan_sessions WHERE id = ?', [record.scan_session_id]);
    }

    return {
      ...record,
      scan_session: scanInfo,
      values: queryAll(`
        SELECT mv.*, mf.field_name, mf.field_type, mf.is_critical as field_is_critical,
               mf.min_value, mf.max_value
        FROM maintenance_values mv
        JOIN maintenance_fields mf ON mv.field_id = mf.id
        WHERE mv.record_id = ?
        ORDER BY mf.sort_order
      `, [record.id])
    };
  });

  res.json(result);
});

// Get single detailed report
router.get('/reports/:id', requireAuth, requireAdmin, (req, res) => {
  const record = queryOne(`
    SELECT mr.*,
           e.name as equipment_name, e.location_name, e.description as equipment_description,
           e.latitude as eq_lat, e.longitude as eq_lng, e.radius_meters,
           e.is_critical as eq_is_critical
    FROM maintenance_records mr
    JOIN equipment e ON mr.equipment_id = e.id
    WHERE mr.id = ?
  `, [req.params.id]);

  if (!record) return res.status(404).json({ error: 'Report not found' });

  let scanInfo = null;
  if (record.scan_session_id) {
    scanInfo = queryOne('SELECT * FROM scan_sessions WHERE id = ?', [record.scan_session_id]);
  }

  const values = queryAll(`
    SELECT mv.*, mf.field_name, mf.field_type, mf.is_critical as field_is_critical,
           mf.min_value, mf.max_value, mf.options
    FROM maintenance_values mv
    JOIN maintenance_fields mf ON mv.field_id = mf.id
    WHERE mv.record_id = ?
    ORDER BY mf.sort_order
  `, [req.params.id]);

  res.json({ ...record, scan_session: scanInfo, values });
});

// Update record status (workflow)
router.put('/records/:id/status', requireAuth, requireAdmin, (req, res) => {
  const { status, review_notes } = req.body;
  const validStatuses = ['pending', 'reviewed', 'resolved', 'in_progress', 'blocked', 'reopened', 'closed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  // Workflow transitions validation
  const validTransitions = {
    'pending': ['reviewed', 'in_progress'],
    'reviewed': ['resolved', 'reopened', 'closed'],
    'in_progress': ['reviewed', 'blocked'],
    'blocked': ['in_progress', 'reviewed'],
    'resolved': ['closed', 'reopened'],
    'reopened': ['in_progress', 'reviewed'],
    'closed': ['reopened']
  };

  const record = queryOne('SELECT * FROM maintenance_records WHERE id = ?', [req.params.id]);
  if (!record) return res.status(404).json({ error: 'Record not found' });

  const currentStatus = record.status || 'pending';
  const allowed = validTransitions[currentStatus] || validStatuses;
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `Cannot transition from '${currentStatus}' to '${status}'. Allowed: ${allowed.join(', ')}` });
  }

  const istNow = getISTTimestamp();
  let updateSql = 'UPDATE maintenance_records SET status = ?';
  const params = [status];

  if (status === 'reviewed') {
    updateSql += ', reviewed_by = ?, reviewed_at = ?, review_notes = ?';
    params.push(req.session.userId || req.session.employeeId, istNow, review_notes || null);
  }

  updateSql += ' WHERE id = ?';
  params.push(req.params.id);
  runSql(updateSql, params);

  // Log the review action
  runSql(`INSERT INTO review_actions (id, record_id, action_type, action_by, action_by_name, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), req.params.id, status === 'reviewed' ? 'approve' : status === 'reopened' ? 'reopen' : status === 'closed' ? 'close' : 'comment',
     req.session.userId || req.session.employeeId, req.session.fullName || 'Admin', review_notes || null, istNow]);

  logAudit(req.session.userId, req.session.fullName, 'update_status',
    'maintenance_record', req.params.id,
    JSON.stringify({ old_status: currentStatus, new_status: status, review_notes }),
    req.ip
  );

  saveDb();
  res.json({ message: `Status updated from ${currentStatus} to ${status}` });
});

// Get filter options (engineers, equipment list)
router.get('/filter-options', requireAuth, requireAdmin, (req, res) => {
  const engineers = queryAll("SELECT DISTINCT employee_id as id, employee_name as full_name FROM maintenance_records WHERE employee_id IS NOT NULL ORDER BY employee_name");
  const equipment = queryAll("SELECT id, name, location_name FROM equipment ORDER BY name");
  res.json({ engineers, equipment });
});

// Excel export
router.get('/export/excel', requireAuth, requireAdmin, async (req, res) => {
  const ExcelJS = require('exceljs');
  const { equipment_id, engineer_id, status, verification, date_from, date_to, has_abnormality } = req.query;

  let sql = `
    SELECT mr.*,
           e.name as equipment_name, e.location_name, e.latitude as eq_lat, e.longitude as eq_lng,
           e.radius_meters, e.is_critical as eq_is_critical
    FROM maintenance_records mr
    JOIN equipment e ON mr.equipment_id = e.id
    WHERE 1=1
  `;
  const params = [];

  if (equipment_id) { sql += ' AND mr.equipment_id = ?'; params.push(equipment_id); }
  if (engineer_id) { sql += ' AND mr.employee_id = ?'; params.push(engineer_id); }
  if (status) { sql += ' AND mr.status = ?'; params.push(status); }
  if (verification) { sql += ' AND mr.verification_status = ?'; params.push(verification); }
  if (has_abnormality === '1') { sql += ' AND mr.has_abnormality = 1'; }
  if (has_abnormality === '0') { sql += ' AND mr.has_abnormality = 0'; }
  if (date_from) { sql += ' AND mr.submitted_at >= ?'; params.push(date_from); }
  if (date_to) { sql += ' AND mr.submitted_at <= ?'; params.push(date_to + ' 23:59:59'); }

  sql += ' ORDER BY mr.submitted_at DESC';

  const records = queryAll(sql, params);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Maintenance Management System';
  workbook.created = new Date();

  // Summary sheet
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: '#', key: 'num', width: 5 },
    { header: 'Date & Time', key: 'date', width: 20 },
    { header: 'Equipment', key: 'equipment', width: 25 },
    { header: 'Location', key: 'location', width: 25 },
    { header: 'Engineer', key: 'engineer', width: 20 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'GPS Verified', key: 'gps', width: 12 },
    { header: 'Distance (m)', key: 'distance', width: 12 },
    { header: 'Accuracy (m)', key: 'accuracy', width: 12 },
    { header: 'Abnormality', key: 'abnormality', width: 12 },
    { header: 'Photo', key: 'photo', width: 8 },
    { header: 'Notes', key: 'notes', width: 40 },
    { header: 'Eng. Lat', key: 'eng_lat', width: 12 },
    { header: 'Eng. Lng', key: 'eng_lng', width: 12 },
    { header: 'Eq. Lat', key: 'eq_lat', width: 12 },
    { header: 'Eq. Lng', key: 'eq_lng', width: 12 },
  ];

  // Style header row
  summarySheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  summarySheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };

  records.forEach((r, i) => {
    const row = summarySheet.addRow({
      num: i + 1,
      date: r.submitted_at,
      equipment: r.equipment_name,
      location: r.location_name,
      engineer: r.employee_name,
      status: (r.status || 'pending').toUpperCase(),
      gps: (r.verification_status || 'unverified').toUpperCase(),
      distance: r.distance_meters,
      accuracy: r.accuracy,
      abnormality: r.has_abnormality ? 'YES' : 'No',
      photo: r.photo_path ? 'Yes' : 'No',
      notes: r.notes || '',
      eng_lat: r.latitude,
      eng_lng: r.longitude,
      eq_lat: r.eq_lat,
      eq_lng: r.eq_lng
    });

    if (r.has_abnormality) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
    }
  });

  // Detailed Values sheet
  const detailSheet = workbook.addWorksheet('Checklist Details');
  detailSheet.columns = [
    { header: '#', key: 'num', width: 5 },
    { header: 'Date', key: 'date', width: 20 },
    { header: 'Equipment', key: 'equipment', width: 25 },
    { header: 'Engineer', key: 'engineer', width: 20 },
    { header: 'Check Item', key: 'field', width: 30 },
    { header: 'Value', key: 'value', width: 20 },
    { header: 'Normal Range', key: 'range', width: 15 },
    { header: 'Abnormal?', key: 'abnormal', width: 10 },
    { header: 'Critical Field?', key: 'critical', width: 12 },
  ];

  detailSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  detailSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };

  let rowNum = 0;
  records.forEach((r) => {
    const vals = queryAll(`
      SELECT mv.*, mf.field_name, mf.is_critical as field_is_critical, mf.min_value, mf.max_value
      FROM maintenance_values mv
      JOIN maintenance_fields mf ON mv.field_id = mf.id
      WHERE mv.record_id = ?
      ORDER BY mf.sort_order
    `, [r.id]);

    vals.forEach(v => {
      rowNum++;
      const range = (v.min_value != null || v.max_value != null)
        ? `${v.min_value ?? '—'} to ${v.max_value ?? '—'}` : '—';
      const row = detailSheet.addRow({
        num: rowNum,
        date: r.submitted_at,
        equipment: r.equipment_name,
        engineer: r.employee_name,
        field: v.field_name,
        value: v.value,
        range: range,
        abnormal: v.is_abnormal ? 'YES' : 'No',
        critical: v.field_is_critical ? 'YES' : 'No'
      });
      if (v.is_abnormal) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
      }
    });
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=maintenance-report-${new Date().toISOString().slice(0, 10)}.xlsx`);

  await workbook.xlsx.write(res);
  res.end();
});

// ===== Dashboard Stats =====
router.get('/stats', requireAuth, requireAdmin, (req, res) => {
  const totalRecords = queryOne('SELECT COUNT(*) as count FROM maintenance_records');
  const pendingRecords = queryOne("SELECT COUNT(*) as count FROM maintenance_records WHERE status = 'pending'");
  const abnormalRecords = queryOne('SELECT COUNT(*) as count FROM maintenance_records WHERE has_abnormality = 1');
  const verifiedRecords = queryOne("SELECT COUNT(*) as count FROM maintenance_records WHERE verification_status = 'verified'");
  const unverifiedRecords = queryOne("SELECT COUNT(*) as count FROM maintenance_records WHERE verification_status = 'unverified'");
  const todayIST = getISTTimestamp().slice(0, 10);
  const todayRecords = queryOne("SELECT COUNT(*) as count FROM maintenance_records WHERE date(submitted_at) = ?", [todayIST]);

  res.json({
    total: totalRecords?.count || 0,
    pending: pendingRecords?.count || 0,
    abnormal: abnormalRecords?.count || 0,
    verified: verifiedRecords?.count || 0,
    unverified: unverifiedRecords?.count || 0,
    today: todayRecords?.count || 0
  });
});

// ===== FINDINGS / ABNORMALITY TRACKER =====

// Get all findings with filters
router.get('/findings', requireAuth, requireAdmin, (req, res) => {
  const { equipment_id, status, severity, exception_class, is_repeat } = req.query;

  let sql = `
    SELECT f.*, e.name as equipment_name, e.location_name, e.is_critical as eq_is_critical
    FROM findings f
    JOIN equipment e ON f.equipment_id = e.id
    WHERE 1=1
  `;
  const params = [];

  if (equipment_id) { sql += ' AND f.equipment_id = ?'; params.push(equipment_id); }
  if (status) { sql += ' AND f.status = ?'; params.push(status); }
  if (severity) { sql += ' AND f.severity = ?'; params.push(severity); }
  if (exception_class) { sql += ' AND f.exception_class = ?'; params.push(exception_class); }
  if (is_repeat === '1') { sql += ' AND f.is_repeat = 1'; }

  sql += ' ORDER BY CASE f.severity WHEN \'emergency\' THEN 0 WHEN \'critical\' THEN 1 WHEN \'warning\' THEN 2 ELSE 3 END, f.created_at DESC LIMIT 500';

  res.json(queryAll(sql, params));
});

// Get findings stats
router.get('/findings/stats', requireAuth, requireAdmin, (req, res) => {
  const open = queryOne("SELECT COUNT(*) as cnt FROM findings WHERE status IN ('open','acknowledged','in_progress')") || { cnt: 0 };
  const resolved = queryOne("SELECT COUNT(*) as cnt FROM findings WHERE status IN ('resolved','closed')") || { cnt: 0 };
  const critical = queryOne("SELECT COUNT(*) as cnt FROM findings WHERE severity IN ('critical','emergency') AND status IN ('open','acknowledged','in_progress')") || { cnt: 0 };
  const repeats = queryOne("SELECT COUNT(*) as cnt FROM findings WHERE is_repeat = 1 AND status IN ('open','acknowledged','in_progress')") || { cnt: 0 };

  // By exception class
  const byClass = queryAll(`
    SELECT exception_class, COUNT(*) as cnt
    FROM findings WHERE status IN ('open','acknowledged','in_progress')
    GROUP BY exception_class
  `);

  // By equipment (top offenders)
  const byEquipment = queryAll(`
    SELECT f.equipment_id, e.name as equipment_name, COUNT(*) as cnt,
      SUM(CASE WHEN f.severity IN ('critical','emergency') THEN 1 ELSE 0 END) as critical_cnt
    FROM findings f JOIN equipment e ON f.equipment_id = e.id
    WHERE f.status IN ('open','acknowledged','in_progress')
    GROUP BY f.equipment_id ORDER BY cnt DESC LIMIT 10
  `);

  res.json({
    open: open.cnt, resolved: resolved.cnt, critical: critical.cnt, repeats: repeats.cnt,
    by_exception_class: byClass, by_equipment: byEquipment
  });
});

// Update finding status
router.put('/findings/:id/status', requireAuth, requireAdmin, (req, res) => {
  const { status, notes, corrective_action, root_cause, exception_class, assigned_to } = req.body;
  const validStatuses = ['open', 'acknowledged', 'in_progress', 'resolved', 'closed', 'deferred'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be: ${validStatuses.join(', ')}` });
  }

  const finding = queryOne('SELECT * FROM findings WHERE id = ?', [req.params.id]);
  if (!finding) return res.status(404).json({ error: 'Finding not found' });

  const istNow = getISTTimestamp();
  let updateParts = ['status = ?'];
  const params = [status];

  if (status === 'acknowledged') {
    updateParts.push('acknowledged_by = ?', 'acknowledged_at = ?');
    params.push(req.session.fullName || req.session.userId, istNow);
  }
  if (status === 'resolved' || status === 'closed') {
    updateParts.push('resolved_by = ?', 'resolved_at = ?', 'resolution_notes = ?');
    params.push(req.session.fullName || req.session.userId, istNow, notes || null);
  }
  if (corrective_action) { updateParts.push('corrective_action = ?'); params.push(corrective_action); }
  if (root_cause) { updateParts.push('root_cause = ?'); params.push(root_cause); }
  if (exception_class) { updateParts.push('exception_class = ?'); params.push(exception_class); }
  if (assigned_to) { updateParts.push('assigned_to = ?'); params.push(assigned_to); }

  params.push(req.params.id);
  runSql(`UPDATE findings SET ${updateParts.join(', ')} WHERE id = ?`, params);

  // Log review action
  runSql(`INSERT INTO review_actions (id, finding_id, action_type, action_by, action_by_name, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), req.params.id, status === 'resolved' ? 'approve' : status === 'closed' ? 'close' : 'comment',
     req.session.userId || req.session.employeeId, req.session.fullName || 'Admin', notes || null, istNow]);

  logAudit(req.session.userId, req.session.fullName, 'update_finding',
    'finding', req.params.id,
    JSON.stringify({ old_status: finding.status, new_status: status, corrective_action, root_cause }),
    req.ip
  );
  saveDb();
  res.json({ message: `Finding updated to ${status}` });
});

// ===== TREND ANALYSIS =====

// Get reading trends for a specific equipment+field
router.get('/trends/:equipmentId', requireAuth, requireAdmin, (req, res) => {
  const { field_id, days } = req.query;
  const daysBack = parseInt(days) || 90;

  let sql = `
    SELECT mv.value, mv.is_abnormal, mv.field_id,
           mf.field_name, mf.field_type, mf.min_value, mf.max_value, mf.is_critical,
           mr.submitted_at, mr.employee_name
    FROM maintenance_values mv
    JOIN maintenance_records mr ON mv.record_id = mr.id
    JOIN maintenance_fields mf ON mv.field_id = mf.id
    WHERE mr.equipment_id = ? AND mf.field_type = 'number'
      AND mr.submitted_at >= datetime('now', '-${daysBack} days')
  `;
  const params = [req.params.equipmentId];

  if (field_id) { sql += ' AND mv.field_id = ?'; params.push(field_id); }
  sql += ' ORDER BY mf.field_name, mr.submitted_at ASC';

  const readings = queryAll(sql, params);

  // Group by field
  const grouped = {};
  for (const r of readings) {
    if (!grouped[r.field_id]) {
      grouped[r.field_id] = {
        field_id: r.field_id,
        field_name: r.field_name,
        min_value: r.min_value,
        max_value: r.max_value,
        is_critical: r.is_critical,
        readings: []
      };
    }
    grouped[r.field_id].readings.push({
      value: parseFloat(r.value),
      is_abnormal: r.is_abnormal,
      date: r.submitted_at,
      engineer: r.employee_name
    });
  }

  // Calculate trend info
  const trends = Object.values(grouped).map(g => {
    const values = g.readings.map(r => r.value).filter(v => !isNaN(v));
    const avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    const abnormalCount = g.readings.filter(r => r.is_abnormal).length;
    const totalCount = g.readings.length;

    // Simple trend direction: compare last 3 vs first 3
    let trendDirection = 'stable';
    if (values.length >= 6) {
      const firstAvg = values.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
      const lastAvg = values.slice(-3).reduce((a, b) => a + b, 0) / 3;
      const pctChange = ((lastAvg - firstAvg) / (firstAvg || 1)) * 100;
      if (pctChange > 10) trendDirection = 'increasing';
      else if (pctChange < -10) trendDirection = 'decreasing';
    }

    return {
      ...g,
      average: Math.round(avg * 100) / 100,
      abnormal_count: abnormalCount,
      total_readings: totalCount,
      abnormal_rate: totalCount > 0 ? Math.round((abnormalCount / totalCount) * 100) : 0,
      trend_direction: trendDirection
    };
  });

  res.json(trends);
});

// Repeated abnormality report — fields with recurring problems
router.get('/repeated-abnormalities', requireAuth, requireAdmin, (req, res) => {
  const repeats = queryAll(`
    SELECT f.equipment_id, e.name as equipment_name, e.location_name,
           f.field_id, f.field_name, f.severity,
           COUNT(*) as occurrence_count,
           MAX(f.created_at) as last_occurrence,
           MIN(f.created_at) as first_occurrence,
           SUM(CASE WHEN f.status IN ('open','acknowledged','in_progress') THEN 1 ELSE 0 END) as still_open
    FROM findings f
    JOIN equipment e ON f.equipment_id = e.id
    GROUP BY f.equipment_id, f.field_id
    HAVING COUNT(*) >= 2
    ORDER BY occurrence_count DESC, last_occurrence DESC
  `);
  res.json(repeats);
});

// ===== SUPERVISOR REVIEW QUEUE =====

// Get pending reviews (records + findings needing review)
router.get('/review-queue', requireAuth, requireAdmin, (req, res) => {
  // Pending maintenance records
  const pendingRecords = queryAll(`
    SELECT mr.*, e.name as equipment_name, e.location_name, e.is_critical as eq_is_critical
    FROM maintenance_records mr
    JOIN equipment e ON mr.equipment_id = e.id
    WHERE mr.status = 'pending' AND mr.has_abnormality = 1
    ORDER BY mr.has_critical_abnormality DESC, mr.submitted_at DESC
    LIMIT 100
  `);

  // Open findings needing action
  const openFindings = queryAll(`
    SELECT f.*, e.name as equipment_name, e.location_name
    FROM findings f
    JOIN equipment e ON f.equipment_id = e.id
    WHERE f.status = 'open'
    ORDER BY CASE f.severity WHEN 'emergency' THEN 0 WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, f.created_at DESC
    LIMIT 100
  `);

  // Recent review actions
  const recentActions = queryAll(`
    SELECT ra.*, mr.employee_name as record_engineer
    FROM review_actions ra
    LEFT JOIN maintenance_records mr ON ra.record_id = mr.id
    ORDER BY ra.created_at DESC LIMIT 20
  `);

  res.json({
    pending_records: pendingRecords,
    open_findings: openFindings,
    recent_actions: recentActions
  });
});

// Batch review action
router.post('/review-batch', requireAuth, requireAdmin, (req, res) => {
  const { record_ids, action, notes } = req.body;
  if (!record_ids || !Array.isArray(record_ids) || !action) {
    return res.status(400).json({ error: 'record_ids (array) and action are required' });
  }

  const validActions = ['reviewed', 'resolved', 'closed'];
  if (!validActions.includes(action)) {
    return res.status(400).json({ error: `Invalid action. Must be: ${validActions.join(', ')}` });
  }

  const istNow = getISTTimestamp();
  let count = 0;
  for (const id of record_ids) {
    const record = queryOne('SELECT id, status FROM maintenance_records WHERE id = ?', [id]);
    if (!record) continue;

    let updateSql = 'UPDATE maintenance_records SET status = ?';
    const params = [action];
    if (action === 'reviewed') {
      updateSql += ', reviewed_by = ?, reviewed_at = ?, review_notes = ?';
      params.push(req.session.userId, istNow, notes || null);
    }
    updateSql += ' WHERE id = ?';
    params.push(id);
    runSql(updateSql, params);

    runSql(`INSERT INTO review_actions (id, record_id, action_type, action_by, action_by_name, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), id, action === 'reviewed' ? 'approve' : action,
       req.session.userId, req.session.fullName || 'Admin', notes || null, istNow]);
    count++;
  }
  saveDb();
  res.json({ message: `${count} records updated to ${action}` });
});

// ===== ESCALATION RULES MANAGEMENT =====

// Get all escalation rules
router.get('/escalation-rules', requireAuth, requireAdmin, (req, res) => {
  const rules = queryAll(`
    SELECT er.*, e.name as equipment_name
    FROM escalation_rules er
    LEFT JOIN equipment e ON er.equipment_id = e.id
    ORDER BY er.equipment_id IS NULL, er.severity
  `);
  res.json(rules);
});

// Create/update escalation rule
router.post('/escalation-rules', requireAuth, requireAdmin, (req, res) => {
  const { equipment_id, severity, hours_to_supervisor, hours_to_manager, hours_to_plant_head, auto_escalate, notify_on_create } = req.body;

  // Check if rule exists for this equipment+severity combo
  const existing = queryOne(
    'SELECT id FROM escalation_rules WHERE (equipment_id = ? OR (equipment_id IS NULL AND ? IS NULL)) AND severity = ?',
    [equipment_id || null, equipment_id || null, severity || 'normal']
  );

  if (existing) {
    runSql(`UPDATE escalation_rules SET hours_to_supervisor = ?, hours_to_manager = ?, hours_to_plant_head = ?, auto_escalate = ?, notify_on_create = ? WHERE id = ?`,
      [hours_to_supervisor || 24, hours_to_manager || 48, hours_to_plant_head || 72,
       auto_escalate != null ? auto_escalate : 1, notify_on_create || 0, existing.id]);
    saveDb();
    return res.json({ message: 'Escalation rule updated', id: existing.id });
  }

  const id = uuidv4();
  runSql(`INSERT INTO escalation_rules (id, equipment_id, severity, hours_to_supervisor, hours_to_manager, hours_to_plant_head, auto_escalate, notify_on_create, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, equipment_id || null, severity || 'normal', hours_to_supervisor || 24, hours_to_manager || 48,
     hours_to_plant_head || 72, auto_escalate != null ? auto_escalate : 1, notify_on_create || 0, getISTTimestamp()]);
  saveDb();
  res.json({ message: 'Escalation rule created', id });
});

// ===== ENHANCED DEFAULTER DASHBOARD =====

// Detailed defaulters by department
router.get('/defaulters/by-department', requireAuth, requireAdmin, (req, res) => {
  const result = queryAll(`
    SELECT
      COALESCE(si.assigned_department, mr.employee_department, 'Unassigned') as department,
      COUNT(DISTINCT si.id) as total_tasks,
      SUM(CASE WHEN si.status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN si.status = 'overdue' THEN 1 ELSE 0 END) as overdue,
      SUM(CASE WHEN si.status = 'missed' THEN 1 ELSE 0 END) as missed,
      COUNT(DISTINCT CASE WHEN si.status IN ('overdue','missed') THEN si.assigned_employee_id END) as defaulter_count
    FROM schedule_instances si
    LEFT JOIN maintenance_records mr ON si.record_id = mr.id
    JOIN schedules s ON si.schedule_id = s.id
    WHERE s.is_active = 1
    GROUP BY department
    ORDER BY (overdue + missed) DESC
  `);
  res.json(result);
});

// Detailed defaulters by equipment/area
router.get('/defaulters/by-equipment', requireAuth, requireAdmin, (req, res) => {
  const result = queryAll(`
    SELECT
      e.id as equipment_id, e.name as equipment_name, e.location_name, e.is_critical,
      COUNT(si.id) as total_tasks,
      SUM(CASE WHEN si.status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN si.status = 'overdue' THEN 1 ELSE 0 END) as overdue,
      SUM(CASE WHEN si.status = 'missed' THEN 1 ELSE 0 END) as missed,
      ROUND(SUM(CASE WHEN si.status = 'completed' THEN 1.0 ELSE 0 END) / MAX(COUNT(si.id), 1) * 100) as compliance_pct
    FROM schedule_instances si
    JOIN equipment e ON si.equipment_id = e.id
    JOIN schedules s ON si.schedule_id = s.id
    WHERE s.is_active = 1
    GROUP BY e.id
    ORDER BY compliance_pct ASC
  `);
  res.json(result);
});

// Detailed defaulters per person with drill-down
router.get('/defaulters/by-person', requireAuth, requireAdmin, (req, res) => {
  const { employee_id } = req.query;

  if (employee_id) {
    // Drill-down: specific person's tasks
    const tasks = queryAll(`
      SELECT si.*, e.name as equipment_name, e.location_name, s.frequency, s.task_type
      FROM schedule_instances si
      JOIN equipment e ON si.equipment_id = e.id
      JOIN schedules s ON si.schedule_id = s.id
      WHERE si.assigned_employee_id = ? AND si.status IN ('overdue','missed')
      ORDER BY si.due_date ASC
    `, [employee_id]);
    return res.json({ employee_id, tasks });
  }

  const result = queryAll(`
    SELECT
      COALESCE(si.assigned_employee_id, 'Unassigned') as employee_id,
      si.assigned_department as department,
      COUNT(si.id) as total_tasks,
      SUM(CASE WHEN si.status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN si.status = 'overdue' THEN 1 ELSE 0 END) as overdue,
      SUM(CASE WHEN si.status = 'missed' THEN 1 ELSE 0 END) as missed,
      ROUND(SUM(CASE WHEN si.status = 'completed' THEN 1.0 ELSE 0 END) / MAX(COUNT(si.id), 1) * 100) as compliance_pct,
      MAX(CASE WHEN si.status = 'completed' THEN si.completed_at END) as last_completed
    FROM schedule_instances si
    JOIN schedules s ON si.schedule_id = s.id
    WHERE s.is_active = 1 AND si.assigned_employee_id IS NOT NULL
    GROUP BY si.assigned_employee_id
    ORDER BY compliance_pct ASC
  `);
  res.json(result);
});

// Haversine formula
function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg) { return deg * (Math.PI / 180); }

module.exports = router;
