const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, 'maintenance.db');

let db = null;

// Get current timestamp in IST (UTC+5:30) as ISO string
function getISTTimestamp() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().replace('T', ' ').slice(0, 19);
}

async function initializeDatabase() {
  const SQL = await initSqlJs({
    locateFile: file => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file)
  });
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run("PRAGMA foreign_keys = ON");

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'engineer')), full_name TEXT NOT NULL,
    email TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS equipment (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, location_name TEXT NOT NULL,
    latitude REAL NOT NULL, longitude REAL NOT NULL, radius_meters REAL DEFAULT 100,
    is_critical INTEGER DEFAULT 0,
    qr_token TEXT UNIQUE NOT NULL, created_by TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS maintenance_fields (
    id TEXT PRIMARY KEY, equipment_id TEXT NOT NULL, field_name TEXT NOT NULL,
    field_type TEXT NOT NULL CHECK(field_type IN ('text','number','select','checkbox')),
    options TEXT, min_value REAL, max_value REAL, is_required INTEGER DEFAULT 1,
    is_critical INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS maintenance_records (
    id TEXT PRIMARY KEY, equipment_id TEXT NOT NULL, employee_id TEXT NOT NULL,
    employee_name TEXT, employee_department TEXT,
    has_abnormality INTEGER DEFAULT 0, notes TEXT,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP, latitude REAL, longitude REAL,
    FOREIGN KEY (equipment_id) REFERENCES equipment(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS maintenance_values (
    id TEXT PRIMARY KEY, record_id TEXT NOT NULL, field_id TEXT NOT NULL,
    value TEXT, is_abnormal INTEGER DEFAULT 0,
    FOREIGN KEY (record_id) REFERENCES maintenance_records(id) ON DELETE CASCADE,
    FOREIGN KEY (field_id) REFERENCES maintenance_fields(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, record_id TEXT NOT NULL, equipment_id TEXT NOT NULL,
    message TEXT NOT NULL, priority TEXT DEFAULT 'normal', is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (record_id) REFERENCES maintenance_records(id),
    FOREIGN KEY (equipment_id) REFERENCES equipment(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS scan_sessions (
    id TEXT PRIMARY KEY,
    equipment_id TEXT NOT NULL,
    employee_id TEXT,
    scan_lat REAL,
    scan_lng REAL,
    scan_accuracy REAL,
    scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    is_used INTEGER DEFAULT 0,
    FOREIGN KEY (equipment_id) REFERENCES equipment(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    user_name TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    details TEXT,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Seed defaults
  const result = queryAll("SELECT id FROM users WHERE role = 'admin'");

  // Migration: add is_critical column if missing
  try {
    db.run("ALTER TABLE equipment ADD COLUMN is_critical INTEGER DEFAULT 0");
  } catch (e) { /* column already exists */ }

  // Migration: add is_critical to maintenance_fields if missing
  try {
    db.run("ALTER TABLE maintenance_fields ADD COLUMN is_critical INTEGER DEFAULT 0");
  } catch (e) { /* column already exists */ }

  // Migration: add priority to notifications if missing
  try {
    db.run("ALTER TABLE notifications ADD COLUMN priority TEXT DEFAULT 'normal'");
  } catch (e) { /* column already exists */ }

  // Migration: add new columns to maintenance_records
  try { db.run("ALTER TABLE maintenance_records ADD COLUMN accuracy REAL"); } catch(e) {}
  try { db.run("ALTER TABLE maintenance_records ADD COLUMN distance_meters REAL"); } catch(e) {}
  try { db.run("ALTER TABLE maintenance_records ADD COLUMN scan_session_id TEXT"); } catch(e) {}
  try { db.run("ALTER TABLE maintenance_records ADD COLUMN verification_status TEXT DEFAULT 'unverified'"); } catch(e) {}
  try { db.run("ALTER TABLE maintenance_records ADD COLUMN photo_path TEXT"); } catch(e) {}
  try { db.run("ALTER TABLE maintenance_records ADD COLUMN status TEXT DEFAULT 'pending'"); } catch(e) {}

  if (result.length === 0) {
    const adminId = uuidv4();
    const engineerId = uuidv4();

    runSql("INSERT INTO users (id,username,password_hash,role,full_name,email) VALUES (?,?,?,?,?,?)",
      [adminId, 'admin', bcrypt.hashSync('admin123', 10), 'admin', 'System Admin', 'admin@company.com']);
    runSql("INSERT INTO users (id,username,password_hash,role,full_name,email) VALUES (?,?,?,?,?,?)",
      [engineerId, 'engineer1', bcrypt.hashSync('engineer123', 10), 'engineer', 'John Engineer', 'engineer@company.com']);

    // ===== Demo Equipment 1: HVAC Unit =====
    const eq1Id = uuidv4();
    const eq1Token = uuidv4();
    runSql(
      `INSERT INTO equipment (id, name, description, location_name, latitude, longitude, radius_meters, is_critical, qr_token, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [eq1Id, 'HVAC Unit #1', 'Central air conditioning unit for Building A. Serves floors 1-3. Regular monthly inspection required.',
       'Building A, Rooftop', 28.6139, 77.2090, 200, 1, eq1Token, adminId]
    );
    // HVAC checklist fields
    const hvacFields = [
      { name: 'Compressor Temperature (°C)', type: 'number', min: 30, max: 75, critical: 1 },
      { name: 'Refrigerant Pressure (PSI)', type: 'number', min: 60, max: 120, critical: 1 },
      { name: 'Air Filter Status', type: 'select', options: 'Clean, Slightly Dirty, Dirty, Damaged', critical: 0 },
      { name: 'Belt Condition', type: 'select', options: 'Good, Worn, Cracked, Broken', critical: 1 },
      { name: 'Vibration Level', type: 'select', options: 'Normal, Slight, Excessive', critical: 0 },
      { name: 'Unusual Noise Detected', type: 'checkbox', critical: 0 },
      { name: 'Coolant Leak Found', type: 'checkbox', critical: 1 },
      { name: 'Fan Motor RPM', type: 'number', min: 800, max: 1500, critical: 0 },
      { name: 'Visual Inspection Notes', type: 'text', critical: 0 },
    ];
    hvacFields.forEach((f, i) => {
      runSql(
        `INSERT INTO maintenance_fields (id, equipment_id, field_name, field_type, options, min_value, max_value, is_required, is_critical, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [uuidv4(), eq1Id, f.name, f.type, f.options || null, f.min ?? null, f.max ?? null, f.critical, i]
      );
    });

    // ===== Demo Equipment 2: Fire Pump =====
    const eq2Id = uuidv4();
    const eq2Token = uuidv4();
    runSql(
      `INSERT INTO equipment (id, name, description, location_name, latitude, longitude, radius_meters, is_critical, qr_token, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [eq2Id, 'Fire Pump System', 'Main fire suppression pump. Weekly inspection mandatory per safety regulations.',
       'Basement B2, Pump Room', 28.6145, 77.2095, 150, 1, eq2Token, adminId]
    );
    // Fire Pump checklist fields
    const pumpFields = [
      { name: 'Suction Pressure (PSI)', type: 'number', min: 10, max: 30, critical: 1 },
      { name: 'Discharge Pressure (PSI)', type: 'number', min: 100, max: 180, critical: 1 },
      { name: 'Pump Status', type: 'select', options: 'Running, Standby, Faulty, Not Working', critical: 1 },
      { name: 'Battery Voltage (V)', type: 'number', min: 24, max: 28, critical: 1 },
      { name: 'Fuel Level (%)', type: 'number', min: 50, max: 100, critical: 0 },
      { name: 'Water Leak Found', type: 'checkbox', critical: 1 },
      { name: 'Engine Oil Level', type: 'select', options: 'Full, Adequate, Low, Critical', critical: 0 },
      { name: 'Alarm Panel Status', type: 'select', options: 'Normal, Trouble, Alarm, Disabled', critical: 1 },
      { name: 'Pipe Corrosion Level', type: 'select', options: 'None, Minor, Moderate, Severe', critical: 0 },
      { name: 'Inspector Remarks', type: 'text', critical: 0 },
    ];
    pumpFields.forEach((f, i) => {
      runSql(
        `INSERT INTO maintenance_fields (id, equipment_id, field_name, field_type, options, min_value, max_value, is_required, is_critical, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [uuidv4(), eq2Id, f.name, f.type, f.options || null, f.min ?? null, f.max ?? null, f.critical, i]
      );
    });
  }

  saveDb();
  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function runSql(sql, params = []) {
  db.run(sql, params);
}

module.exports = { initializeDatabase, saveDb, queryAll, queryOne, runSql, getISTTimestamp };
