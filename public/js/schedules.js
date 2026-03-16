// ===== Schedules Admin JS =====

// Auth check
fetch('/api/auth/me').then(r => {
  if (!r.ok) { window.location.href = '/?returnTo=' + encodeURIComponent(window.location.pathname); return Promise.reject(); }
  return r.json();
}).then(user => {
  if (user && user.role !== 'admin') window.location.href = '/dashboard.html';
}).catch(() => {});

// Logout
document.getElementById('logoutBtn').addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
});

// Alert badge
async function loadAlertBadge() {
  try {
    const res = await fetch('/api/notifications/unread-count');
    const data = await res.json();
    const badge = document.getElementById('alertBadge');
    if (data.count > 0) {
      badge.textContent = data.critical_count > 0 ? `🚨 ${data.count}` : data.count;
      badge.style.display = 'inline';
    } else { badge.style.display = 'none'; }
  } catch (e) {}
}
loadAlertBadge();

// ===== Tabs =====
function switchTab(tab) {
  document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + tab).style.display = 'block';
  document.querySelector(`.tab-btn[data-tab="${tab}"]`).classList.add('active');
  if (tab === 'calendar') loadCalendar();
  if (tab === 'compliance') loadCompliance();
}

// ===== Load Compliance Stats =====
async function loadStats() {
  try {
    const res = await fetch('/api/schedules/compliance');
    const data = await res.json();
    document.getElementById('statTotal').textContent = data.total;
    document.getElementById('statCompleted').textContent = data.completed;
    document.getElementById('statDueToday').textContent = data.due_today;
    document.getElementById('statOverdue').textContent = data.overdue + data.missed;
    document.getElementById('statCompliance').textContent = data.compliance_rate + '%';
  } catch (e) {}
}
loadStats();

// ===== Load Schedules List =====
async function loadSchedules() {
  try {
    const res = await fetch('/api/schedules');
    const schedules = await res.json();
    const container = document.getElementById('schedulesList');

    if (!schedules.length) {
      container.innerHTML = '<div class="card no-data"><p>📅 No schedules created yet. Click "Create Schedule" to get started.</p></div>';
      return;
    }

    container.innerHTML = '<div class="card-grid">' + schedules.map(s => {
      const typeIcon = (s.task_type || 'inspection') === 'maintenance' ? '🔧' : '🔍';
      const typeLabel = capitalize(s.task_type || 'inspection');
      return `
      <div class="card ${!s.is_active ? 'schedule-inactive' : ''}">
        <div class="eq-card-header">
          <h3>⚙️ ${escapeHtml(s.equipment_name)}</h3>
          <div style="display:flex;gap:6px;align-items:center;">
            <span class="tag ${(s.task_type || 'inspection') === 'maintenance' ? 'tag-maintenance' : 'tag-inspection'}">${typeIcon} ${typeLabel}</span>
            <span class="tag ${s.is_active ? 'tag-normal' : 'tag-warning'}">${s.is_active ? '✅ Active' : '⏸ Paused'}</span>
          </div>
        </div>
        <p class="subtitle">📍 ${escapeHtml(s.location_name)}</p>
        <div class="eq-meta" style="margin-top:0.75rem;">
          <span>🔄 ${escapeHtml(capitalize(s.frequency))}</span>
          <span>📅 Start: ${formatDate(s.start_date)}</span>
          ${s.end_date ? `<span>🏁 End: ${formatDate(s.end_date)}</span>` : ''}
          <span>⏰ Grace: ${s.grace_period_hours}h</span>
        </div>
        <div class="eq-meta" style="margin-top:0.5rem;">
          <span>👤 ${s.assigned_employee_id ? 'Employee: ' + escapeHtml(s.assigned_employee_id) : s.assigned_department ? 'Dept: ' + escapeHtml(s.assigned_department) : 'Unassigned'}</span>
          <span>📋 Next: ${s.next_due_date ? formatDate(s.next_due_date) : '—'}</span>
        </div>
        <div class="card-actions">
          <button class="btn btn-primary btn-sm" onclick="viewInstances('${s.id}')">📋 View Tasks</button>
          <button class="btn btn-secondary btn-sm" onclick="toggleSchedule('${s.id}', ${s.is_active ? 0 : 1})">${s.is_active ? '⏸ Pause' : '▶ Resume'}</button>
          <button class="btn btn-danger btn-sm" onclick="deleteSchedule('${s.id}', '${escapeHtml(s.equipment_name)}')">🗑️ Delete</button>
        </div>
      </div>
    `}).join('') + '</div>';
  } catch (e) { console.error('Failed to load schedules:', e); }
}
loadSchedules();

// ===== Load dropdown options =====
async function loadFormOptions() {
  try {
    const [eqRes, deptRes, empRes] = await Promise.all([
      fetch('/api/equipment'), fetch('/api/schedules/departments'), fetch('/api/schedules/employees')
    ]);
    const equipment = await eqRes.json();
    const departments = await deptRes.json();
    const employees = await empRes.json();

    const eqSelect = document.getElementById('scEquipment');
    eqSelect.innerHTML = '<option value="">— Select Equipment —</option>' +
      equipment.map(e => `<option value="${e.id}">${escapeHtml(e.name)} — ${escapeHtml(e.location_name)}</option>`).join('');

    const deptSelect = document.getElementById('scDepartment');
    deptSelect.innerHTML = '<option value="">— No department —</option>' +
      departments.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');

    // Store employees globally for searchable dropdown
    window._allEmployees = employees;
    setupEmployeeSearch(employees);
  } catch (e) {}
}
loadFormOptions();

// ===== Searchable Employee Dropdown =====
function setupEmployeeSearch(employees) {
  const searchInput = document.getElementById('scEmployeeSearch');
  const hiddenInput = document.getElementById('scEmployee');
  const dropdown = document.getElementById('empDropdown');
  const selectedDiv = document.getElementById('empSelected');
  if (!searchInput) return;

  function renderDropdown(filter) {
    let filtered = employees;
    if (filter) {
      const q = filter.toLowerCase();
      filtered = employees.filter(e =>
        (e.employee_name || '').toLowerCase().includes(q) ||
        (e.employee_id || '').toLowerCase().includes(q) ||
        (e.employee_department || '').toLowerCase().includes(q)
      );
    }
    if (filtered.length === 0) {
      dropdown.innerHTML = '<div style="padding:12px;color:#94a3b8;text-align:center;">No employees found</div>';
    } else {
      dropdown.innerHTML = '<div style="padding:6px 12px;color:#94a3b8;font-size:11px;border-bottom:1px solid #f1f5f9;">'+filtered.length+' employees</div>' +
        filtered.slice(0, 100).map(e =>
          `<div class="emp-option" data-id="${escapeHtml(e.employee_id)}" data-name="${escapeHtml(e.employee_name)}" style="padding:10px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid #f8fafc;transition:background 0.1s;" onmouseover="this.style.background='#eff6ff'" onmouseout="this.style.background='white'">`+
          `<strong>${escapeHtml(e.employee_name)}</strong> <span style="color:#6366f1;">(${escapeHtml(e.employee_id)})</span>`+
          `<span style="color:#94a3b8;font-size:11px;"> — ${escapeHtml(e.employee_department || '')}</span></div>`
        ).join('');
    }
    dropdown.style.display = 'block';

    // Attach click handlers
    dropdown.querySelectorAll('.emp-option').forEach(opt => {
      opt.onclick = () => {
        hiddenInput.value = opt.dataset.id;
        searchInput.value = opt.dataset.name + ' (' + opt.dataset.id + ')';
        selectedDiv.textContent = '✅ ' + opt.dataset.name + ' selected';
        selectedDiv.style.display = 'block';
        dropdown.style.display = 'none';
      };
    });
  }

  searchInput.addEventListener('focus', () => renderDropdown(searchInput.value));
  searchInput.addEventListener('input', () => {
    hiddenInput.value = '';
    selectedDiv.style.display = 'none';
    renderDropdown(searchInput.value);
  });

  // Clear button behavior
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { dropdown.style.display = 'none'; searchInput.blur(); }
  });

  // Close dropdown when clicking elsewhere
  document.addEventListener('click', (e) => {
    if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  });
}

// ===== Create Schedule =====
function openCreateModal() {
  document.getElementById('createModal').style.display = 'flex';
  // Set default start date to today
  const today = new Date();
  today.setMinutes(today.getMinutes() + 330); // IST offset
  document.getElementById('scStartDate').value = today.toISOString().slice(0, 10);
}
function closeCreateModal() { document.getElementById('createModal').style.display = 'none'; }

async function createSchedule(e) {
  e.preventDefault();
  const body = {
    equipment_id: document.getElementById('scEquipment').value,
    task_type: document.getElementById('scTaskType').value,
    frequency: document.getElementById('scFrequency').value,
    start_date: document.getElementById('scStartDate').value,
    end_date: document.getElementById('scEndDate').value || null,
    grace_period_hours: parseInt(document.getElementById('scGrace').value) || 24,
    assigned_employee_id: document.getElementById('scEmployee').value || null,
    assigned_department: document.getElementById('scDepartment').value || null
  };

  try {
    const res = await fetch('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.ok) {
      closeCreateModal();
      document.getElementById('scheduleForm').reset();
      loadSchedules();
      loadStats();
    } else {
      const err = await res.json();
      alert(err.error || 'Failed to create schedule');
    }
  } catch (err) { alert('Error: ' + err.message); }
  return false;
}

// ===== Toggle/Delete Schedule =====
async function toggleSchedule(id, active) {
  await fetch(`/api/schedules/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_active: active })
  });
  loadSchedules();
  loadStats();
}

async function deleteSchedule(id, name) {
  if (!confirm(`Delete schedule for "${name}"? This will also remove all task instances.`)) return;
  await fetch(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
  loadSchedules();
  loadStats();
}

// ===== View Instances =====
function closeInstancesModal() { document.getElementById('instancesModal').style.display = 'none'; }

async function viewInstances(scheduleId) {
  const res = await fetch(`/api/schedules/instances?schedule_id=${encodeURIComponent(scheduleId)}`);
  const instances = await res.json();
  const container = document.getElementById('instancesContent');

  if (!instances.length) {
    container.innerHTML = '<div class="no-data"><p>No task instances generated yet.</p></div>';
  } else {
    container.innerHTML = `
      <div class="table-responsive">
        <table class="report-table">
          <thead>
            <tr>
              <th>Due Date</th>
              <th>Equipment</th>
              <th>Status</th>
              <th>Completed By</th>
              <th>Completed At</th>
            </tr>
          </thead>
          <tbody>
            ${instances.map(inst => `
              <tr class="${inst.status === 'overdue' || inst.status === 'missed' ? 'row-abnormal' : ''}">
                <td>${formatDate(inst.due_date)}</td>
                <td>${escapeHtml(inst.equipment_name)}</td>
                <td>${statusTag(inst.status)}</td>
                <td>${escapeHtml(inst.completed_by || '—')}</td>
                <td>${inst.completed_at ? formatIST(inst.completed_at) : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }
  document.getElementById('instancesModal').style.display = 'flex';
}

// ===== Process Schedules =====
async function processSchedules() {
  const res = await fetch('/api/schedules/process', { method: 'POST' });
  if (res.ok) {
    loadSchedules();
    loadStats();
    alert('Schedules processed successfully.');
  }
}

// ===== Calendar =====
let calYear, calMonth;
(function initCalendar() {
  const now = new Date();
  now.setMinutes(now.getMinutes() + 330);
  calYear = now.getFullYear();
  calMonth = now.getMonth() + 1;
})();

function changeMonth(delta) {
  calMonth += delta;
  if (calMonth > 12) { calMonth = 1; calYear++; }
  if (calMonth < 1) { calMonth = 12; calYear--; }
  loadCalendar();
}

async function loadCalendar() {
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('calendarMonth').textContent = `${monthNames[calMonth - 1]} ${calYear}`;

  const res = await fetch(`/api/schedules/calendar?year=${calYear}&month=${calMonth}`);
  const instances = await res.json();

  // Group by date
  const byDate = {};
  instances.forEach(inst => {
    if (!byDate[inst.due_date]) byDate[inst.due_date] = [];
    byDate[inst.due_date].push(inst);
  });

  const firstDay = new Date(calYear, calMonth - 1, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const todayStr = getTodayLocal();

  let html = '<div class="cal-header"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div>';
  html += '<div class="cal-body">';

  // Empty cells for days before month starts
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-cell cal-empty"></div>';

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${calYear}-${String(calMonth).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const dayInstances = byDate[dateStr] || [];
    const isToday = dateStr === todayStr;

    html += `<div class="cal-cell ${isToday ? 'cal-today' : ''}">
      <span class="cal-day">${day}</span>
      <div class="cal-dots">`;

    dayInstances.forEach(inst => {
      const cls = inst.status === 'completed' ? 'dot-completed' : inst.status === 'overdue' ? 'dot-overdue' : inst.status === 'missed' ? 'dot-missed' : 'dot-pending';
      html += `<span class="cal-dot ${cls}" title="${escapeHtml(inst.equipment_name)} — ${inst.status}"></span>`;
    });

    html += '</div></div>';
  }
  html += '</div>';
  document.getElementById('calendarGrid').innerHTML = html;
}

// ===== Compliance Tab =====
async function loadCompliance() {
  try {
    const res = await fetch('/api/schedules/compliance');
    const data = await res.json();

    // Equipment compliance table
    const eqTable = document.getElementById('equipmentComplianceTable');
    if (data.equipment_compliance.length === 0) {
      eqTable.innerHTML = '<p class="muted">No schedule data yet.</p>';
    } else {
      eqTable.innerHTML = `
        <div class="table-responsive">
          <table class="report-table">
            <thead><tr><th>Equipment</th><th>Location</th><th>Total</th><th>Completed</th><th>Overdue</th><th>Missed</th><th>Compliance</th></tr></thead>
            <tbody>
              ${data.equipment_compliance.map(eq => {
                const rate = eq.total_instances > 0 ? Math.round((eq.completed_instances / eq.total_instances) * 100) : 0;
                return `<tr>
                  <td>${escapeHtml(eq.name)}</td>
                  <td>${escapeHtml(eq.location_name)}</td>
                  <td>${eq.total_instances}</td>
                  <td>${eq.completed_instances}</td>
                  <td class="${eq.overdue_instances > 0 ? 'text-danger' : ''}">${eq.overdue_instances}</td>
                  <td class="${eq.missed_instances > 0 ? 'text-danger' : ''}">${eq.missed_instances}</td>
                  <td><div class="compliance-bar"><div class="compliance-fill ${rate >= 80 ? 'fill-good' : rate >= 50 ? 'fill-warn' : 'fill-bad'}" style="width:${rate}%"></div><span>${rate}%</span></div></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;
    }

    // Engineer compliance table
    const engTable = document.getElementById('engineerComplianceTable');
    if (data.engineer_compliance.length === 0) {
      engTable.innerHTML = '<p class="muted">No engineer data yet.</p>';
    } else {
      engTable.innerHTML = `
        <div class="table-responsive">
          <table class="report-table">
            <thead><tr><th>Employee ID</th><th>Total Assigned</th><th>Completed</th><th>Overdue</th><th>Missed</th><th>Compliance</th></tr></thead>
            <tbody>
              ${data.engineer_compliance.map(eng => {
                const rate = eng.total_assigned > 0 ? Math.round((eng.completed / eng.total_assigned) * 100) : 0;
                return `<tr>
                  <td>${escapeHtml(eng.employee_id)}</td>
                  <td>${eng.total_assigned}</td>
                  <td>${eng.completed}</td>
                  <td class="${eng.overdue > 0 ? 'text-danger' : ''}">${eng.overdue}</td>
                  <td class="${eng.missed > 0 ? 'text-danger' : ''}">${eng.missed}</td>
                  <td><div class="compliance-bar"><div class="compliance-fill ${rate >= 80 ? 'fill-good' : rate >= 50 ? 'fill-warn' : 'fill-bad'}" style="width:${rate}%"></div><span>${rate}%</span></div></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;
    }
  } catch (e) { console.error('Failed to load compliance:', e); }
}

// ===== Helpers =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00+05:30');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

function formatIST(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr.replace(' ', 'T') + '+05:30');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) +
    ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
}

function statusTag(status) {
  switch (status) {
    case 'completed': return '<span class="tag tag-normal">✅ Completed</span>';
    case 'overdue': return '<span class="tag tag-abnormal">⚠️ Overdue</span>';
    case 'missed': return '<span class="tag tag-abnormal">❌ Missed</span>';
    default: return '<span class="tag tag-warning">⏳ Pending</span>';
  }
}

function getTodayLocal() {
  const now = new Date();
  now.setMinutes(now.getMinutes() + 330);
  return now.toISOString().slice(0, 10);
}
