const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { initializeDatabase } = require('./database');
const { loadEmployees, verifyEmployee } = require('./employees');

const authRoutes = require('./routes/auth');
const equipmentRoutes = require('./routes/equipment');
const maintenanceRoutes = require('./routes/maintenance');
const notificationRoutes = require('./routes/notifications');
const auditRoutes = require('./routes/audit');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Session configuration
const sessionSecret = crypto.randomBytes(32).toString('hex');
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false, // Set to true in production with HTTPS
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
  app.listen(PORT, '0.0.0.0', () => {
    const lanIp = getLanIp();
    console.log(`Maintenance Management System running at:`);
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Network: http://${lanIp}:${PORT}`);
    console.log(`Admin login: admin / admin123`);
    console.log(`Engineers: Scan QR → Enter Employee ID from Excel`);
    console.log(`\nUse the Network URL for mobile QR scanning.`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
