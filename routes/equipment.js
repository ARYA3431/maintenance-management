const express = require('express');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { queryAll, queryOne, runSql, saveDb, getISTTimestamp } = require('../database');

// Multer storage for Excel uploads (temp directory)
const upload = multer({
  dest: path.join(os.tmpdir(), 'equipment-uploads'),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls') {
      cb(null, true);
    } else {
      cb(new Error('Only .xlsx and .xls files are allowed'));
    }
  }
});

// Get LAN IP for QR codes so mobile devices can reach the server
function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const router = express.Router();

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// List all equipment
router.get('/', requireAuth, (req, res) => {
  const showArchived = req.query.archived === '1';
  const equipment = queryAll(`
    SELECT e.*, u.full_name as created_by_name
    FROM equipment e
    JOIN users u ON e.created_by = u.id
    WHERE e.is_archived = ?
    ORDER BY e.created_at DESC
  `, [showArchived ? 1 : 0]);
  res.json(equipment);
});

// Get single equipment with fields
router.get('/:id', requireAuth, (req, res) => {
  const equipment = queryOne('SELECT * FROM equipment WHERE id = ?', [req.params.id]);
  if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

  const fields = queryAll(
    'SELECT * FROM maintenance_fields WHERE equipment_id = ? ORDER BY sort_order', [req.params.id]
  );

  res.json({ ...equipment, fields });
});

// Get equipment by QR token (for scan page)
router.get('/scan/:token', (req, res) => {
  const equipment = queryOne('SELECT * FROM equipment WHERE qr_token = ?', [req.params.token]);
  if (!equipment) return res.status(404).json({ error: 'Invalid QR code' });

  const fields = queryAll(
    'SELECT * FROM maintenance_fields WHERE equipment_id = ? ORDER BY sort_order', [equipment.id]
  );

  // Strip coordinates from public scan response — verification happens server-side
  const { latitude, longitude, radius_meters, qr_token, created_by, ...safeEquipment } = equipment;
  res.json({ ...safeEquipment, fields });
});

// Create equipment with maintenance fields
router.post('/', requireAuth, requireAdmin, (req, res) => {
  const { name, description, location_name, latitude, longitude, radius_meters, is_critical, fields } = req.body;

  if (!name || !location_name || latitude == null || longitude == null) {
    return res.status(400).json({ error: 'Name, location, latitude, and longitude are required' });
  }

  const equipmentId = uuidv4();
  const qrToken = uuidv4();

  runSql(
    `INSERT INTO equipment (id, name, description, location_name, latitude, longitude, radius_meters, is_critical, qr_token, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [equipmentId, name, description || '', location_name, latitude, longitude, radius_meters || 100, is_critical ? 1 : 0, qrToken, req.session.userId]
  );

  if (fields && Array.isArray(fields)) {
    fields.forEach((field, index) => {
      runSql(
        `INSERT INTO maintenance_fields (id, equipment_id, field_name, field_type, options, min_value, max_value, is_required, is_critical, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), equipmentId, field.field_name, field.field_type,
         field.options || null, field.min_value ?? null, field.max_value ?? null,
         field.is_required ? 1 : 0, field.is_critical ? 1 : 0, index]
      );
    });
  }

  saveDb();
  res.status(201).json({ id: equipmentId, qr_token: qrToken });
});

// Generate QR code image
router.get('/:id/qr', requireAuth, (req, res) => {
  const equipment = queryOne('SELECT qr_token FROM equipment WHERE id = ?', [req.params.id]);
  if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

  // Use the request's own host — works for both LAN and ngrok/public access
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  const scanUrl = `${protocol}://${host}/scan/${equipment.qr_token}`;

  QRCode.toDataURL(scanUrl, { width: 400, margin: 2 }, (err, dataUrl) => {
    if (err) return res.status(500).json({ error: 'Failed to generate QR code' });
    res.json({ qr_image: dataUrl, scan_url: scanUrl });
  });
});

// Create scan session (when engineer scans QR at location)
router.post('/scan-session', (req, res) => {
  const { equipment_id, latitude, longitude, accuracy } = req.body;

  if (!equipment_id) {
    return res.status(400).json({ error: 'Equipment ID is required' });
  }

  const equipment = queryOne('SELECT * FROM equipment WHERE id = ?', [equipment_id]);
  if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

  const sessionId = uuidv4();
  const istNow = getISTTimestamp();
  // expire 30 min from now in IST
  const expireDate = new Date(Date.now() + (5.5 * 60 * 60 * 1000) + (30 * 60 * 1000));
  const expiresAt = expireDate.toISOString().replace('T', ' ').slice(0, 19);

  runSql(
    `INSERT INTO scan_sessions (id, equipment_id, employee_id, scan_lat, scan_lng, scan_accuracy, scanned_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, equipment_id, null, latitude || null, longitude || null, accuracy || null, istNow, expiresAt]
  );

  saveDb();
  res.json({ session_id: sessionId, expires_at: expiresAt });
});

// Update equipment
router.put('/:id', requireAuth, requireAdmin, (req, res) => {
  const existing = queryOne('SELECT * FROM equipment WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Equipment not found' });

  const { name, description, location_name, latitude, longitude, radius_meters, is_critical, fields } = req.body;

  if (!name || !location_name || latitude == null || longitude == null) {
    return res.status(400).json({ error: 'Name, location, latitude, and longitude are required' });
  }

  runSql(
    `UPDATE equipment SET name=?, description=?, location_name=?, latitude=?, longitude=?, radius_meters=?, is_critical=? WHERE id=?`,
    [name, description || '', location_name, latitude, longitude, radius_meters || 100, is_critical ? 1 : 0, req.params.id]
  );

  // Replace all fields
  if (fields && Array.isArray(fields)) {
    runSql('DELETE FROM maintenance_fields WHERE equipment_id = ?', [req.params.id]);
    fields.forEach((field, index) => {
      runSql(
        `INSERT INTO maintenance_fields (id, equipment_id, field_name, field_type, options, min_value, max_value, is_required, is_critical, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), req.params.id, field.field_name, field.field_type,
         field.options || null, field.min_value ?? null, field.max_value ?? null,
         field.is_required ? 1 : 0, field.is_critical ? 1 : 0, index]
      );
    });
  }

  saveDb();
  res.json({ message: 'Equipment updated successfully' });
});

// Duplicate equipment
router.post('/:id/duplicate', requireAuth, requireAdmin, (req, res) => {
  const existing = queryOne('SELECT * FROM equipment WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Equipment not found' });

  const fields = queryAll('SELECT * FROM maintenance_fields WHERE equipment_id = ? ORDER BY sort_order', [req.params.id]);

  const newId = uuidv4();
  const newToken = uuidv4();
  const newName = existing.name + ' (Copy)';

  runSql(
    `INSERT INTO equipment (id, name, description, location_name, latitude, longitude, radius_meters, is_critical, qr_token, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId, newName, existing.description || '', existing.location_name, existing.latitude, existing.longitude,
     existing.radius_meters, existing.is_critical, newToken, req.session.userId]
  );

  fields.forEach((field, index) => {
    runSql(
      `INSERT INTO maintenance_fields (id, equipment_id, field_name, field_type, options, min_value, max_value, is_required, is_critical, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), newId, field.field_name, field.field_type,
       field.options || null, field.min_value ?? null, field.max_value ?? null,
       field.is_required, field.is_critical, index]
    );
  });

  saveDb();
  res.status(201).json({ id: newId, name: newName, qr_token: newToken, fields_copied: fields.length });
});

// Archive / Unarchive equipment
router.patch('/:id/archive', requireAuth, requireAdmin, (req, res) => {
  const existing = queryOne('SELECT * FROM equipment WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Equipment not found' });

  const newState = existing.is_archived ? 0 : 1;
  runSql('UPDATE equipment SET is_archived = ? WHERE id = ?', [newState, req.params.id]);
  saveDb();
  res.json({ message: newState ? 'Equipment archived' : 'Equipment restored', is_archived: newState });
});

// Delete equipment (and all related data)
router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  const existing = queryOne('SELECT id FROM equipment WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Equipment not found' });

  // Clean up tables without CASCADE
  runSql('DELETE FROM engineer_notifications WHERE equipment_id = ?', [req.params.id]);
  runSql('DELETE FROM escalation_rules WHERE equipment_id = ?', [req.params.id]);
  runSql('DELETE FROM findings WHERE equipment_id = ?', [req.params.id]);
  runSql('DELETE FROM scan_sessions WHERE equipment_id = ?', [req.params.id]);
  runSql('DELETE FROM notifications WHERE equipment_id = ?', [req.params.id]);
  // maintenance_values CASCADE from maintenance_records
  runSql('DELETE FROM maintenance_records WHERE equipment_id = ?', [req.params.id]);
  // CASCADE handles: maintenance_fields, schedules, schedule_instances
  runSql('DELETE FROM equipment WHERE id = ?', [req.params.id]);
  saveDb();
  res.json({ message: 'Equipment and all related data deleted' });
});

// ===== Equipment Excel Template Download =====
const MAX_CHECK_FIELDS = 10;
router.get('/excel/template', async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Equipment');

  // Base equipment columns
  const columns = [
    { header: 'Equipment Name', key: 'name', width: 25 },
    { header: 'Description', key: 'description', width: 30 },
    { header: 'Location Name', key: 'location_name', width: 25 },
    { header: 'Latitude', key: 'latitude', width: 15 },
    { header: 'Longitude', key: 'longitude', width: 15 },
    { header: 'Radius (meters)', key: 'radius_meters', width: 18 },
    { header: 'Is Critical (Yes/No)', key: 'is_critical', width: 20 }
  ];

  // Add maintenance check field columns (up to 10 fields)
  for (let i = 1; i <= MAX_CHECK_FIELDS; i++) {
    columns.push({ header: `Check${i} Name`, key: `f${i}_name`, width: 20 });
    columns.push({ header: `Check${i} Type`, key: `f${i}_type`, width: 15 });
    columns.push({ header: `Check${i} Options`, key: `f${i}_options`, width: 22 });
    columns.push({ header: `Check${i} Min`, key: `f${i}_min`, width: 12 });
    columns.push({ header: `Check${i} Max`, key: `f${i}_max`, width: 12 });
    columns.push({ header: `Check${i} Required`, key: `f${i}_required`, width: 15 });
    columns.push({ header: `Check${i} Critical`, key: `f${i}_critical`, width: 15 });
  }
  sheet.columns = columns;

  // Style header row — blue for base columns, green for check field columns
  sheet.getRow(1).eachCell((cell, colNumber) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colNumber <= 7 ? 'FF2563EB' : 'FF16A34A' } };
    cell.alignment = { horizontal: 'center', wrapText: true };
  });

  // Add Excel dropdown validations for Is Critical column (col 7)
  for (let r = 2; r <= 500; r++) {
    sheet.getCell(r, 7).dataValidation = {
      type: 'list', allowBlank: true, formulae: ['"Yes,No"'],
      showInputMessage: true, promptTitle: 'Is Critical?', prompt: 'Select Yes or No',
      showErrorMessage: true, errorTitle: 'Invalid', error: 'Select Yes or No'
    };
  }

  // Add Excel dropdown validations for each Check field group
  for (let i = 0; i < MAX_CHECK_FIELDS; i++) {
    const typeCol = 8 + (i * 7) + 1;     // Check Type column
    const reqCol  = 8 + (i * 7) + 5;     // Check Required column
    const critCol = 8 + (i * 7) + 6;     // Check Critical column
    for (let r = 2; r <= 500; r++) {
      sheet.getCell(r, typeCol).dataValidation = {
        type: 'list', allowBlank: true, formulae: ['"number,text,select,checkbox"'],
        showInputMessage: true, promptTitle: 'Field Type', prompt: 'Pick: number, text, select, or checkbox',
        showErrorMessage: true, errorTitle: 'Invalid Type', error: 'Must be: number, text, select, or checkbox'
      };
      sheet.getCell(r, reqCol).dataValidation = {
        type: 'list', allowBlank: true, formulae: ['"Yes,No"'],
        showInputMessage: true, promptTitle: 'Required?', prompt: 'Is this field required?',
        showErrorMessage: true, errorTitle: 'Invalid', error: 'Select Yes or No'
      };
      sheet.getCell(r, critCol).dataValidation = {
        type: 'list', allowBlank: true, formulae: ['"Yes,No"'],
        showInputMessage: true, promptTitle: 'Critical?', prompt: 'Alert admin if abnormal?',
        showErrorMessage: true, errorTitle: 'Invalid', error: 'Select Yes or No'
      };
    }
  }

  // Add example rows covering all field types
  sheet.addRow({
    name: 'HVAC Unit #1',
    description: 'Main building AC unit',
    location_name: 'Building A, Floor 1',
    latitude: 28.6139,
    longitude: 77.2090,
    radius_meters: 100,
    is_critical: 'No',
    f1_name: 'Temperature (°C)', f1_type: 'number', f1_options: '', f1_min: 15, f1_max: 45, f1_required: 'Yes', f1_critical: 'Yes',
    f2_name: 'Humidity (%)', f2_type: 'number', f2_options: '', f2_min: 20, f2_max: 80, f2_required: 'Yes', f2_critical: 'No',
    f3_name: 'Filter Status', f3_type: 'select', f3_options: 'Clean,Dirty,Replace', f3_min: '', f3_max: '', f3_required: 'Yes', f3_critical: 'Yes',
    f4_name: 'Compressor Running OK', f4_type: 'checkbox', f4_options: '', f4_min: '', f4_max: '', f4_required: 'Yes', f4_critical: 'Yes',
    f5_name: 'Remarks', f5_type: 'text', f5_options: '', f5_min: '', f5_max: '', f5_required: 'No', f5_critical: 'No'
  });
  sheet.addRow({
    name: 'Generator #3',
    description: 'Backup power generator',
    location_name: 'Power Room B',
    latitude: 28.6145,
    longitude: 77.2095,
    radius_meters: 50,
    is_critical: 'Yes',
    f1_name: 'Fuel Level (%)', f1_type: 'number', f1_options: '', f1_min: 10, f1_max: 100, f1_required: 'Yes', f1_critical: 'Yes',
    f2_name: 'Engine Oil Pressure (psi)', f2_type: 'number', f2_options: '', f2_min: 30, f2_max: 80, f2_required: 'Yes', f2_critical: 'Yes',
    f3_name: 'Coolant Level', f3_type: 'select', f3_options: 'Full,Low,Critical', f3_min: '', f3_max: '', f3_required: 'Yes', f3_critical: 'Yes',
    f4_name: 'Battery Condition', f4_type: 'select', f4_options: 'Good,Fair,Poor,Dead', f4_min: '', f4_max: '', f4_required: 'Yes', f4_critical: 'Yes',
    f5_name: 'Auto-Start Test OK', f5_type: 'checkbox', f5_options: '', f5_min: '', f5_max: '', f5_required: 'Yes', f5_critical: 'No',
    f6_name: 'Oil Leak Detected', f6_type: 'checkbox', f6_options: '', f6_min: '', f6_max: '', f6_required: 'Yes', f6_critical: 'Yes',
    f7_name: 'Observations', f7_type: 'text', f7_options: '', f7_min: '', f7_max: '', f7_required: 'No', f7_critical: 'No'
  });
  sheet.addRow({
    name: 'Pump Station P-101',
    description: 'Main water supply pump',
    location_name: 'Pump House, Block C',
    latitude: 28.6152,
    longitude: 77.2088,
    radius_meters: 75,
    is_critical: 'Yes',
    f1_name: 'Discharge Pressure (bar)', f1_type: 'number', f1_options: '', f1_min: 2, f1_max: 8, f1_required: 'Yes', f1_critical: 'Yes',
    f2_name: 'Vibration Level (mm/s)', f2_type: 'number', f2_options: '', f2_min: 0, f2_max: 4.5, f2_required: 'Yes', f2_critical: 'Yes',
    f3_name: 'Motor Temperature (°C)', f3_type: 'number', f3_options: '', f3_min: 20, f3_max: 85, f3_required: 'Yes', f3_critical: 'Yes',
    f4_name: 'Seal Condition', f4_type: 'select', f4_options: 'Good,Leaking,Replace', f4_min: '', f4_max: '', f4_required: 'Yes', f4_critical: 'Yes',
    f5_name: 'Bearing Noise', f5_type: 'select', f5_options: 'Normal,Slight,Loud', f5_min: '', f5_max: '', f5_required: 'Yes', f5_critical: 'Yes',
    f6_name: 'Lubrication Done', f6_type: 'checkbox', f6_options: '', f6_min: '', f6_max: '', f6_required: 'Yes', f6_critical: 'No',
    f7_name: 'Alignment Checked', f7_type: 'checkbox', f7_options: '', f7_min: '', f7_max: '', f7_required: 'No', f7_critical: 'No',
    f8_name: 'Notes', f8_type: 'text', f8_options: '', f8_min: '', f8_max: '', f8_required: 'No', f8_critical: 'No'
  });
  sheet.addRow({
    name: 'Electrical Panel EP-04',
    description: 'Main distribution panel zone 4',
    location_name: 'Electrical Room, Floor G',
    latitude: 28.6135,
    longitude: 77.2082,
    radius_meters: 30,
    is_critical: 'Yes',
    f1_name: 'R Phase Voltage (V)', f1_type: 'number', f1_options: '', f1_min: 380, f1_max: 440, f1_required: 'Yes', f1_critical: 'Yes',
    f2_name: 'Y Phase Voltage (V)', f2_type: 'number', f2_options: '', f2_min: 380, f2_max: 440, f2_required: 'Yes', f2_critical: 'Yes',
    f3_name: 'B Phase Voltage (V)', f3_type: 'number', f3_options: '', f3_min: 380, f3_max: 440, f3_required: 'Yes', f3_critical: 'Yes',
    f4_name: 'Load Current (A)', f4_type: 'number', f4_options: '', f4_min: 0, f4_max: 500, f4_required: 'Yes', f4_critical: 'No',
    f5_name: 'Panel Condition', f5_type: 'select', f5_options: 'Good,Dusty,Damaged,Overheating', f5_min: '', f5_max: '', f5_required: 'Yes', f5_critical: 'Yes',
    f6_name: 'Earth Leakage OK', f6_type: 'checkbox', f6_options: '', f6_min: '', f6_max: '', f6_required: 'Yes', f6_critical: 'Yes',
    f7_name: 'Breaker Trip Test Done', f7_type: 'checkbox', f7_options: '', f7_min: '', f7_max: '', f7_required: 'No', f7_critical: 'No',
    f8_name: 'Remarks', f8_type: 'text', f8_options: '', f8_min: '', f8_max: '', f8_required: 'No', f8_critical: 'No'
  });
  sheet.addRow({
    name: 'Fire Pump FP-02',
    description: 'Fire fighting jockey pump',
    location_name: 'Fire Pump Room',
    latitude: 28.6148,
    longitude: 77.2078,
    radius_meters: 50,
    is_critical: 'Yes',
    f1_name: 'Pressure (bar)', f1_type: 'number', f1_options: '', f1_min: 5, f1_max: 12, f1_required: 'Yes', f1_critical: 'Yes',
    f2_name: 'Flow Rate (LPM)', f2_type: 'number', f2_options: '', f2_min: 100, f2_max: 1000, f2_required: 'Yes', f2_critical: 'Yes',
    f3_name: 'Auto-Start Working', f3_type: 'checkbox', f3_options: '', f3_min: '', f3_max: '', f3_required: 'Yes', f3_critical: 'Yes',
    f4_name: 'Valve Position', f4_type: 'select', f4_options: 'Open,Closed,Partial', f4_min: '', f4_max: '', f4_required: 'Yes', f4_critical: 'Yes',
    f5_name: 'Tank Level', f5_type: 'select', f5_options: 'Full,75%,50%,25%,Empty', f5_min: '', f5_max: '', f5_required: 'Yes', f5_critical: 'Yes',
    f6_name: 'Weekly Run Test Done', f6_type: 'checkbox', f6_options: '', f6_min: '', f6_max: '', f6_required: 'Yes', f6_critical: 'No',
    f7_name: 'Observations', f7_type: 'text', f7_options: '', f7_min: '', f7_max: '', f7_required: 'No', f7_critical: 'No'
  });

  // Style example rows as italic hint
  [2, 3, 4, 5, 6].forEach(rowNum => {
    sheet.getRow(rowNum).eachCell(cell => {
      cell.font = { italic: true, color: { argb: 'FF888888' } };
    });
  });

  // Add instructions sheet
  const instrSheet = workbook.addWorksheet('Instructions');
  instrSheet.columns = [{ header: 'Instructions', key: 'text', width: 90 }];
  instrSheet.getRow(1).font = { bold: true, size: 14 };
  [
    '=== EQUIPMENT FIELDS (Blue Columns) ===',
    'Fill the "Equipment" sheet with your equipment data.',
    'Delete the example rows (rows 2-6) before uploading.',
    '',
    'Required: Equipment Name, Location Name, Latitude, Longitude',
    'Optional: Description, Radius (defaults to 100m), Is Critical (defaults to No)',
    '',
    'Latitude & Longitude: Use decimal degrees (e.g., 28.6139, 77.2090)',
    'To get coordinates: Open Google Maps → Right-click location → Copy coordinates',
    'Radius: Distance in meters within which the engineer must be to submit the form (10-5000)',
    'Is Critical: Enter "Yes" for critical equipment that triggers admin alerts on every submission',
    '',
    '=== MAINTENANCE CHECK FIELDS (Green Columns) ===',
    'You can add up to 10 maintenance check fields per equipment.',
    'Each check field has 7 columns: Name, Type, Options, Min, Max, Required, Critical',
    '',
    'Check Name: The field label shown to engineers (e.g., "Temperature", "Oil Level")',
    'Check Type: Use the DROPDOWN in Excel to pick: number, text, select, checkbox',
    '   • number — Engineer enters a numeric value (use Min/Max to set valid range)',
    '   • text — Engineer enters free text',
    '   • select — Engineer picks from a dropdown (fill the Options column)',
    '   • checkbox — Engineer ticks a checkbox (Yes/No)',
    '',
    'Is Critical / Required / Critical columns also have Yes/No DROPDOWNS in Excel.',
    '',
    'Check Options: Only for "select" type. Comma-separated values (e.g., Good,Fair,Poor)',
    'Check Min / Max: Only for "number" type. Values outside this range will trigger an alert.',
    'Check Required: "Yes" or "No" — whether the field must be filled (defaults to Yes)',
    'Check Critical: "Yes" or "No" — if "Yes", abnormal values will alert admin',
    '',
    '=== EXAMPLES (5 filled rows) ===',
    'Row 2: HVAC Unit — Temperature (number), Humidity (number), Filter Status (select), Compressor OK (checkbox), Remarks (text)',
    'Row 3: Generator — Fuel Level (number), Oil Pressure (number), Coolant (select), Battery (select), checkbox, text',
    'Row 4: Pump Station — Pressure, Vibration, Motor Temp (numbers), Seal & Bearing (selects), Lubrication (checkbox), Notes (text)',
    'Row 5: Electrical Panel — R/Y/B Voltage + Load Current (numbers), Panel Condition (select), Earth Leakage (checkbox), Remarks (text)',
    'Row 6: Fire Pump — Pressure & Flow (numbers), Auto-Start & Run Test (checkboxes), Valve & Tank (selects), Observations (text)',
    '',
    'Leave check field columns empty if no maintenance checks are needed for that equipment.'
  ].forEach(text => instrSheet.addRow({ text }));

  // Bold instruction section headers
  instrSheet.eachRow((row, rowNum) => {
    const val = String(row.getCell(1).value || '');
    if (val.startsWith('===')) {
      row.getCell(1).font = { bold: true, size: 12, color: { argb: 'FF2563EB' } };
    }
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=equipment_template.xlsx');
  await workbook.xlsx.write(res);
});

// ===== Equipment Excel Import =====
router.post('/excel/import', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);

    const sheet = workbook.getWorksheet('Equipment') || workbook.worksheets[0];
    if (!sheet) {
      return res.status(400).json({ error: 'No worksheet found in the uploaded file' });
    }

    const results = { created: 0, errors: [] };

    sheet.eachRow((row, rowNum) => {
      if (rowNum === 1) return; // Skip header

      const name = String(row.getCell(1).value || '').trim();
      const description = String(row.getCell(2).value || '').trim();
      const location_name = String(row.getCell(3).value || '').trim();
      const latitude = parseFloat(row.getCell(4).value);
      const longitude = parseFloat(row.getCell(5).value);
      const radius_meters = parseInt(row.getCell(6).value) || 100;
      const is_critical_val = String(row.getCell(7).value || '').trim().toLowerCase();
      const is_critical = is_critical_val === 'yes' || is_critical_val === '1' || is_critical_val === 'true';

      // Validate required fields
      if (!name) {
        results.errors.push(`Row ${rowNum}: Equipment Name is required`);
        return;
      }
      if (!location_name) {
        results.errors.push(`Row ${rowNum}: Location Name is required`);
        return;
      }
      if (isNaN(latitude) || latitude < -90 || latitude > 90) {
        results.errors.push(`Row ${rowNum}: Invalid Latitude (must be -90 to 90)`);
        return;
      }
      if (isNaN(longitude) || longitude < -180 || longitude > 180) {
        results.errors.push(`Row ${rowNum}: Invalid Longitude (must be -180 to 180)`);
        return;
      }
      if (radius_meters < 10 || radius_meters > 5000) {
        results.errors.push(`Row ${rowNum}: Radius must be between 10 and 5000 meters`);
        return;
      }

      const equipmentId = uuidv4();
      const qrToken = uuidv4();

      runSql(
        `INSERT INTO equipment (id, name, description, location_name, latitude, longitude, radius_meters, is_critical, qr_token, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [equipmentId, name, description, location_name, latitude, longitude, radius_meters, is_critical ? 1 : 0, qrToken, req.session.userId]
      );

      // Parse maintenance check fields (columns 8 onwards, 7 columns per field)
      const validTypes = ['number', 'text', 'select', 'checkbox'];
      for (let i = 0; i < MAX_CHECK_FIELDS; i++) {
        const base = 8 + (i * 7); // Column offset (1-indexed: 8,15,22,...)
        const fName = String(row.getCell(base).value || '').trim();
        if (!fName) break; // Stop at first empty field name

        let fType = String(row.getCell(base + 1).value || 'text').trim().toLowerCase();
        if (!validTypes.includes(fType)) fType = 'text';

        const fOptions = String(row.getCell(base + 2).value || '').trim();
        const fMin = row.getCell(base + 3).value;
        const fMax = row.getCell(base + 4).value;
        const fReqVal = String(row.getCell(base + 5).value || 'yes').trim().toLowerCase();
        const fCritVal = String(row.getCell(base + 6).value || 'no').trim().toLowerCase();

        const isReq = fReqVal !== 'no' && fReqVal !== '0' && fReqVal !== 'false';
        const isCrit = fCritVal === 'yes' || fCritVal === '1' || fCritVal === 'true';

        runSql(
          `INSERT INTO maintenance_fields (id, equipment_id, field_name, field_type, options, min_value, max_value, is_required, is_critical, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), equipmentId, fName, fType,
           fType === 'select' && fOptions ? fOptions : null,
           fType === 'number' && fMin != null && fMin !== '' ? parseFloat(fMin) : null,
           fType === 'number' && fMax != null && fMax !== '' ? parseFloat(fMax) : null,
           isReq ? 1 : 0, isCrit ? 1 : 0, i]
        );
      }

      results.created++;
    });

    saveDb();

    // Clean up temp file
    fs.unlink(req.file.path, () => {});

    res.json({
      message: `Successfully imported ${results.created} equipment${results.created !== 1 ? 's' : ''}.`,
      created: results.created,
      errors: results.errors
    });
  } catch (err) {
    // Clean up temp file on error
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Failed to parse Excel file: ' + err.message });
  }
});

// ===== Export Current Equipment to Excel =====
router.get('/excel/export', requireAuth, requireAdmin, async (req, res) => {
  const equipment = queryAll('SELECT * FROM equipment ORDER BY created_at DESC');

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Equipment');

  sheet.columns = [
    { header: 'Equipment Name', key: 'name', width: 25 },
    { header: 'Description', key: 'description', width: 30 },
    { header: 'Location Name', key: 'location_name', width: 25 },
    { header: 'Latitude', key: 'latitude', width: 15 },
    { header: 'Longitude', key: 'longitude', width: 15 },
    { header: 'Radius (meters)', key: 'radius_meters', width: 18 },
    { header: 'Is Critical (Yes/No)', key: 'is_critical', width: 20 }
  ];

  sheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    cell.alignment = { horizontal: 'center' };
  });

  equipment.forEach(eq => {
    sheet.addRow({
      name: eq.name,
      description: eq.description || '',
      location_name: eq.location_name,
      latitude: eq.latitude,
      longitude: eq.longitude,
      radius_meters: eq.radius_meters,
      is_critical: eq.is_critical ? 'Yes' : 'No'
    });
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=equipment_list.xlsx');
  await workbook.xlsx.write(res);
});

module.exports = router;
