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
  const { equipment_id, values, notes, user_lat, user_lng, accuracy, scan_session_id, photo } = req.body;

  if (!equipment_id || !values) {
    return res.status(400).json({ error: 'Equipment ID and values are required' });
  }

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

  if (user_lat != null && user_lng != null) {
    distance = getDistanceMeters(equipment.latitude, equipment.longitude, user_lat, user_lng);

    if (distance > equipment.radius_meters) {
      return res.status(403).json({
        error: 'You are not at the equipment location. Please scan the QR code at the equipment site.',
        distance: Math.round(distance),
        allowed_radius: equipment.radius_meters
      });
    }
    verificationStatus = 'verified';
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
    `INSERT INTO maintenance_records (id, equipment_id, employee_id, employee_name, employee_department, has_abnormality, notes, latitude, longitude, accuracy, distance_meters, scan_session_id, verification_status, photo_path, status, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [recordId, equipment_id, employeeId, employeeName, employeeDept, hasAbnormality ? 1 : 0, notes || '',
     user_lat, user_lng, accuracy || null,
     distance != null ? Math.round(distance) : null,
     scan_session_id || null, verificationStatus, photoPath, 'pending', istNow]
  );

  for (const val of processedValues) {
    runSql(
      `INSERT INTO maintenance_values (id, record_id, field_id, value, is_abnormal) VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), recordId, val.field_id, val.value || '', val.is_abnormal]
    );
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
  const { status } = req.body;
  const validStatuses = ['pending', 'reviewed', 'resolved'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be: pending, reviewed, or resolved' });
  }

  const record = queryOne('SELECT * FROM maintenance_records WHERE id = ?', [req.params.id]);
  if (!record) return res.status(404).json({ error: 'Record not found' });

  runSql('UPDATE maintenance_records SET status = ? WHERE id = ?', [status, req.params.id]);

  logAudit(req.session.userId, req.session.fullName, 'update_status',
    'maintenance_record', req.params.id,
    JSON.stringify({ old_status: record.status, new_status: status }),
    req.ip
  );

  saveDb();
  res.json({ message: `Status updated to ${status}` });
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
