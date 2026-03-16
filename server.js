const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const os = require('os');
const { initializeDatabase, queryAll, queryOne, runSql, getISTTimestamp } = require('./database');
const { loadEmployees, verifyEmployee, getAllEmployees } = require('./employees');
const { loadStoreList, getStoreItems, searchStore, getStoreLocations } = require('./store');

const authRoutes = require('./routes/auth');
const equipmentRoutes = require('./routes/equipment');
const maintenanceRoutes = require('./routes/maintenance');
const notificationRoutes = require('./routes/notifications');
const auditRoutes = require('./routes/audit');
const scheduleRoutes = require('./routes/schedules');
const { runScheduledTasks } = require('./routes/schedules');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Trust proxy for Render/HTTPS
app.set('trust proxy', 1);

// Session configuration
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 8 * 60 * 60 * 1000 // 8 hours
  }
}));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/equipment', equipmentRoutes);
app.use('/api/maintenance', maintenanceRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/schedules', scheduleRoutes);

// Verify employee ID against Excel data
app.post('/api/verify-employee', (req, res) => {
  const { employee_id } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'Employee ID is required' });

  const emp = verifyEmployee(employee_id);
  if (!emp) return res.status(404).json({ error: 'Employee ID not found. Please check and try again.' });

  // Set session
  req.session.employeeId = emp.employeeId;
  req.session.fullName = emp.fullName;
  req.session.department = emp.department;
  req.session.email = emp.email;
  req.session.role = 'employee';

  res.json(emp);
});

// Store inventory API
app.get('/api/store', (req, res) => {
  const query = req.query.q || '';
  const location = req.query.location || '';
  let items = query ? searchStore(query) : getStoreItems();
  if (location) items = items.filter(i => i.location === location);
  res.json({ items, total: items.length });
});

app.get('/api/store/locations', (req, res) => {
  res.json(getStoreLocations());
});

// Store Transaction: Submit IN/OUT
app.post('/api/store/transaction', (req, res) => {
  const { item_name, item_location, transaction_type, quantity, employee_id, notes } = req.body;
  if (!item_name || !transaction_type || !quantity || !employee_id) {
    return res.status(400).json({ error: 'Item, type, quantity, and employee ID are required' });
  }
  if (!['IN', 'OUT'].includes(transaction_type)) {
    return res.status(400).json({ error: 'Transaction type must be IN or OUT' });
  }
  const qty = parseInt(quantity);
  if (isNaN(qty) || qty < 1) {
    return res.status(400).json({ error: 'Quantity must be a positive number' });
  }

  // Verify employee
  const emp = verifyEmployee(employee_id);
  const empName = emp ? emp.fullName : null;
  const empDept = emp ? emp.department : null;

  const id = uuidv4();
  runSql(
    `INSERT INTO store_transactions (id, item_name, item_location, transaction_type, quantity, employee_id, employee_name, employee_department, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, item_name, item_location || '', transaction_type, qty, employee_id, empName, empDept, notes || '', getISTTimestamp()]
  );
  const { saveDb } = require('./database');
  saveDb();

  res.json({ success: true, id, employee_name: empName });
});

// Store Transaction: Get log
app.get('/api/store/transactions', (req, res) => {
  const { item, type, employee_id, limit: lim } = req.query;
  let sql = 'SELECT * FROM store_transactions WHERE 1=1';
  const params = [];
  if (item) { sql += ' AND item_name LIKE ?'; params.push(`%${item}%`); }
  if (type) { sql += ' AND transaction_type = ?'; params.push(type); }
  if (employee_id) { sql += ' AND employee_id = ?'; params.push(employee_id); }
  sql += ' ORDER BY created_at DESC';
  const maxRows = parseInt(lim) || 500;
  sql += ' LIMIT ?';
  params.push(maxRows);
  const rows = queryAll(sql, params);
  res.json(rows);
});

// Store Transaction: Get summary for an item (net stock change)
app.get('/api/store/transactions/summary', (req, res) => {
  const { item_name } = req.query;
  if (!item_name) return res.status(400).json({ error: 'item_name required' });
  const rows = queryAll(
    `SELECT transaction_type, SUM(quantity) as total FROM store_transactions WHERE item_name = ? GROUP BY transaction_type`,
    [item_name]
  );
  const inQty = (rows.find(r => r.transaction_type === 'IN') || {}).total || 0;
  const outQty = (rows.find(r => r.transaction_type === 'OUT') || {}).total || 0;
  res.json({ item_name, total_in: inQty, total_out: outQty, net: inQty - outQty });
});

// Serve maintenance page for QR scan links
app.get('/scan/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'maintenance.html'));
});

// Fallback
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get LAN IP address
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

// Initialize database then start server
initializeDatabase().then(async () => {
  await loadEmployees();
  await loadStoreList();
  app.listen(PORT, '0.0.0.0', () => {
    const lanIp = getLanIp();
    console.log(`Maintenance Management System running at:`);
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Network: http://${lanIp}:${PORT}`);
    console.log(`Admin login: admin / admin123`);
    console.log(`Engineers: Scan QR → Enter Employee ID from Excel`);
    console.log(`\nUse the Network URL for mobile QR scanning.`);

    // Run scheduled tasks on startup and every hour
    try { runScheduledTasks(); } catch (e) { console.error('Initial schedule run error:', e.message); }
    setInterval(() => {
      try { runScheduledTasks(); } catch (e) { console.error('Scheduled tasks error:', e.message); }
    }, 60 * 60 * 1000); // Every hour
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
