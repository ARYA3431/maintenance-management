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
  const equipment = queryAll(`
    SELECT e.*, u.full_name as created_by_name
    FROM equipment e
    JOIN users u ON e.created_by = u.id
    ORDER BY e.created_at DESC
  `);
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

// Delete equipment
router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  runSql('DELETE FROM equipment WHERE id = ?', [req.params.id]);
  saveDb();
  res.json({ message: 'Equipment deleted' });
});

// ===== Equipment Excel Template Download =====
router.get('/excel/template', requireAuth, requireAdmin, async (req, res) => {
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

  // Style header row
  sheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    cell.alignment = { horizontal: 'center' };
  });

  // Add example rows
  sheet.addRow({
    name: 'HVAC Unit #1',
    description: 'Main building AC unit',
    location_name: 'Building A, Floor 1',
    latitude: 28.6139,
    longitude: 77.2090,
    radius_meters: 100,
    is_critical: 'No'
  });
  sheet.addRow({
    name: 'Generator #3',
    description: 'Backup power generator',
    location_name: 'Power Room B',
    latitude: 28.6145,
    longitude: 77.2095,
    radius_meters: 50,
    is_critical: 'Yes'
  });

  // Style example rows as italic hint
  [2, 3].forEach(rowNum => {
    sheet.getRow(rowNum).eachCell(cell => {
      cell.font = { italic: true, color: { argb: 'FF888888' } };
    });
  });

  // Add instructions sheet
  const instrSheet = workbook.addWorksheet('Instructions');
  instrSheet.columns = [{ header: 'Instructions', key: 'text', width: 80 }];
  instrSheet.getRow(1).font = { bold: true, size: 14 };
  [
    'Fill the "Equipment" sheet with your equipment data.',
    'Delete the example rows (rows 2-3) before uploading.',
    '',
    'Required Fields: Equipment Name, Location Name, Latitude, Longitude',
    'Optional Fields: Description, Radius (defaults to 100m), Is Critical (defaults to No)',
    '',
    'Latitude & Longitude: Use decimal degrees (e.g., 28.6139, 77.2090)',
    'To get coordinates: Open Google Maps → Right-click location → Copy coordinates',
    'Radius: Distance in meters within which the engineer must be to submit the form',
    'Is Critical: Enter "Yes" for critical equipment that triggers admin alerts on every submission'
  ].forEach(text => instrSheet.addRow({ text }));

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
