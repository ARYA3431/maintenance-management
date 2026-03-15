// ===== Reports Page JS =====

// Auth check
fetch('/api/auth/me').then(r => {
  if (!r.ok) {
    window.location.href = '/?returnTo=' + encodeURIComponent(window.location.pathname);
    return Promise.reject('not authenticated');
  }
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

// Load alert badge
async function loadAlertBadge() {
  try {
    const res = await fetch('/api/notifications/unread-count');
    const data = await res.json();
    const badge = document.getElementById('alertBadge');
    if (data.count > 0) {
      badge.textContent = data.count;
      badge.style.display = 'inline';
    } else {
      badge.style.display = 'none';
    }
  } catch (e) {}
}
loadAlertBadge();

// Load stats
async function loadStats() {
  try {
    const res = await fetch('/api/maintenance/stats');
    const data = await res.json();
    document.getElementById('statTotal').textContent = data.total;
    document.getElementById('statPending').textContent = data.pending;
    document.getElementById('statAbnormal').textContent = data.abnormal;
    document.getElementById('statVerified').textContent = data.verified;
    document.getElementById('statToday').textContent = data.today;
  } catch (e) {}
}
loadStats();

// Load filter options
async function loadFilterOptions() {
  try {
    const res = await fetch('/api/maintenance/filter-options');
    const data = await res.json();

    const eqSelect = document.getElementById('filterEquipment');
    data.equipment.forEach(eq => {
      const opt = document.createElement('option');
      opt.value = eq.id;
      opt.textContent = eq.name + ' — ' + eq.location_name;
      eqSelect.appendChild(opt);
    });

    const engSelect = document.getElementById('filterEngineer');
    data.engineers.forEach(eng => {
      const opt = document.createElement('option');
      opt.value = eng.id;
      opt.textContent = eng.full_name + ' (' + eng.username + ')';
      engSelect.appendChild(opt);
    });
  } catch (e) {}
}
loadFilterOptions();

// Build filter query string
function getFilterParams() {
  const params = new URLSearchParams();
  const equipment_id = document.getElementById('filterEquipment').value;
  const engineer_id = document.getElementById('filterEngineer').value;
  const status = document.getElementById('filterStatus').value;
  const verification = document.getElementById('filterVerification').value;
  const has_abnormality = document.getElementById('filterAbnormality').value;
  const date_from = document.getElementById('filterDateFrom').value;
  const date_to = document.getElementById('filterDateTo').value;

  if (equipment_id) params.set('equipment_id', equipment_id);
  if (engineer_id) params.set('engineer_id', engineer_id);
  if (status) params.set('status', status);
  if (verification) params.set('verification', verification);
  if (has_abnormality) params.set('has_abnormality', has_abnormality);
  if (date_from) params.set('date_from', date_from);
  if (date_to) params.set('date_to', date_to);

  return params.toString();
}

// Load reports
async function loadReports() {
  const params = getFilterParams();
  const res = await fetch('/api/maintenance/reports?' + params);
  const reports = await res.json();

  document.getElementById('reportCount').textContent = reports.length;

  const tbody = document.getElementById('reportsBody');
  const noData = document.getElementById('noReports');

  if (!reports.length) {
    tbody.innerHTML = '';
    noData.style.display = 'block';
    return;
  }
  noData.style.display = 'none';

  tbody.innerHTML = reports.map((r, i) => {
    const gpsIcon = r.verification_status === 'verified'
      ? '<span class="tag tag-normal">✅ Verified</span>'
      : '<span class="tag tag-warning">❌ Unverified</span>';

    const statusTag = getStatusTag(r.status);
    const resultTag = r.has_abnormality
      ? '<span class="tag tag-abnormal">⚠️ Abnormal</span>'
      : '<span class="tag tag-normal">✅ Normal</span>';

    const photoIcon = r.photo_path
      ? '<span class="tag tag-normal" title="Photo attached">📷 Yes</span>'
      : '<span class="tag" style="background:var(--gray-100);color:var(--gray-400);">No</span>';

    return `
      <tr class="${r.has_abnormality ? 'row-abnormal' : ''} ${r.verification_status !== 'verified' ? 'row-unverified' : ''}">
        <td>${i + 1}</td>
        <td>${formatDate(r.submitted_at)}</td>
        <td>
          <strong>${escapeHtml(r.equipment_name)}</strong>
          ${r.eq_is_critical ? ' <span class="tag tag-abnormal" style="font-size:0.65rem;">CRITICAL</span>' : ''}
          <br><small class="hint">${escapeHtml(r.location_name)}</small>
        </td>
        <td>${escapeHtml(r.employee_name)}</td>
        <td>${gpsIcon}</td>
        <td>${r.distance_meters != null ? r.distance_meters + 'm' : '—'}</td>
        <td>
          <select class="status-select" onchange="updateStatus('${r.id}', this.value)" data-current="${r.status || 'pending'}">
            <option value="pending" ${(r.status || 'pending') === 'pending' ? 'selected' : ''}>⏳ Pending</option>
            <option value="reviewed" ${r.status === 'reviewed' ? 'selected' : ''}>👁️ Reviewed</option>
            <option value="resolved" ${r.status === 'resolved' ? 'selected' : ''}>✅ Resolved</option>
          </select>
        </td>
        <td>${resultTag}</td>
        <td>${photoIcon}</td>
        <td>
          <button class="btn btn-primary btn-sm" onclick="viewDetail('${r.id}')">🔍 View</button>
        </td>
      </tr>
    `;
  }).join('');
}
loadReports();

// View detailed report
async function viewDetail(id) {
  const res = await fetch('/api/maintenance/reports/' + encodeURIComponent(id));
  if (!res.ok) { alert('Could not load report'); return; }
  const r = await res.json();

  const gpsSection = r.verification_status === 'verified'
    ? `<div class="detail-gps verified">
        <h4>📍 GPS Verification: <span class="tag tag-normal">✅ VERIFIED</span></h4>
        <div class="gps-grid">
          <div><strong>Engineer Location:</strong> ${r.latitude?.toFixed(6)}, ${r.longitude?.toFixed(6)}</div>
          <div><strong>Equipment Location:</strong> ${r.eq_lat?.toFixed(6)}, ${r.eq_lng?.toFixed(6)}</div>
          <div><strong>Distance:</strong> ${r.distance_meters != null ? r.distance_meters + ' meters' : 'N/A'}</div>
          <div><strong>Allowed Radius:</strong> ${r.radius_meters} meters</div>
          <div><strong>GPS Accuracy:</strong> ${r.accuracy ? '±' + Math.round(r.accuracy) + 'm' : 'N/A'}</div>
        </div>
       </div>`
    : `<div class="detail-gps unverified">
        <h4>📍 GPS Verification: <span class="tag tag-warning">❌ UNVERIFIED</span></h4>
        <p class="hint">Engineer's GPS location was not captured. This may be due to HTTP connection or GPS being blocked.</p>
       </div>`;

  let scanSessionHtml = '';
  if (r.scan_session) {
    const s = r.scan_session;
    const scanTime = new Date(s.scanned_at);
    const submitTime = new Date(r.submitted_at);
    const dwellMin = ((submitTime - scanTime) / 60000).toFixed(1);
    scanSessionHtml = `
      <div class="detail-section">
        <h4>🔐 Scan Session</h4>
        <div class="gps-grid">
          <div><strong>QR Scanned At:</strong> ${formatDate(s.scanned_at)}</div>
          <div><strong>Submitted At:</strong> ${formatDate(r.submitted_at)}</div>
          <div><strong>Dwell Time:</strong> ${dwellMin} minutes</div>
          <div><strong>Scan GPS:</strong> ${s.scan_lat ? s.scan_lat.toFixed(6) + ', ' + s.scan_lng.toFixed(6) : 'N/A'}</div>
          <div><strong>Scan Accuracy:</strong> ${s.scan_accuracy ? '±' + Math.round(s.scan_accuracy) + 'm' : 'N/A'}</div>
        </div>
      </div>`;
  }

  const abnormalValues = r.values.filter(v => v.is_abnormal);
  const normalValues = r.values.filter(v => !v.is_abnormal);

  let checklistHtml = `
    <div class="detail-section">
      <h4>📋 Checklist Results (${r.values.length} items, ${abnormalValues.length} abnormal)</h4>
      <table class="report-table compact">
        <thead>
          <tr>
            <th>#</th>
            <th>Check Item</th>
            <th>Value</th>
            <th>Expected Range</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          ${r.values.map((v, i) => {
            const range = (v.min_value != null || v.max_value != null)
              ? `${v.min_value ?? '—'} to ${v.max_value ?? '—'}` : '—';
            return `
              <tr class="${v.is_abnormal ? 'row-abnormal' : ''} ${v.field_is_critical ? 'row-critical-field' : ''}">
                <td>${i + 1}</td>
                <td>${escapeHtml(v.field_name)} ${v.field_is_critical ? '<span class="tag tag-abnormal" style="font-size:0.65rem;">CRITICAL</span>' : ''}</td>
                <td><strong>${escapeHtml(v.value)}</strong></td>
                <td>${range}</td>
                <td>${v.is_abnormal ? '<span class="tag tag-abnormal">⚠️ ABNORMAL</span>' : '<span class="tag tag-normal">✅ OK</span>'}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  const photoHtml = r.photo_path
    ? `<div class="detail-section">
        <h4>📷 Photo Evidence</h4>
        <img src="${escapeHtml(r.photo_path)}" alt="Site Photo" class="report-photo" onclick="window.open('${escapeHtml(r.photo_path)}')">
       </div>` : '';

  const statusHtml = `
    <div class="detail-section">
      <h4>📌 Workflow Status</h4>
      <div style="display:flex;align-items:center;gap:1rem;">
        ${getStatusTag(r.status)}
        <select class="status-select" onchange="updateStatus('${r.id}', this.value); viewDetail('${r.id}');">
          <option value="pending" ${(r.status || 'pending') === 'pending' ? 'selected' : ''}>⏳ Pending</option>
          <option value="reviewed" ${r.status === 'reviewed' ? 'selected' : ''}>👁️ Reviewed</option>
          <option value="resolved" ${r.status === 'resolved' ? 'selected' : ''}>✅ Resolved</option>
        </select>
      </div>
    </div>`;

  document.getElementById('detailContent').innerHTML = `
    <div class="report-detail">
      <div class="detail-header">
        <div>
          <h3>⚙️ ${escapeHtml(r.equipment_name)} ${r.eq_is_critical ? '<span class="tag tag-abnormal">CRITICAL EQUIPMENT</span>' : ''}</h3>
          <p class="subtitle">📍 ${escapeHtml(r.location_name)}</p>
          <p class="hint">${escapeHtml(r.equipment_description || '')}</p>
        </div>
        <div class="detail-meta">
          <div><strong>Engineer:</strong> ${escapeHtml(r.employee_name)} (${escapeHtml(r.employee_id)})</div>
          <div><strong>Date:</strong> ${formatDate(r.submitted_at)}</div>
          <div><strong>Report ID:</strong> <code>${r.id.slice(0, 8)}...</code></div>
        </div>
      </div>

      ${gpsSection}
      ${scanSessionHtml}
      ${checklistHtml}

      ${r.notes ? `<div class="detail-section"><h4>📝 Notes</h4><p>${escapeHtml(r.notes)}</p></div>` : ''}
      ${photoHtml}
      ${statusHtml}
    </div>
  `;

  document.getElementById('detailModal').style.display = 'flex';
}

function closeDetailModal() {
  document.getElementById('detailModal').style.display = 'none';
}

// Update status
async function updateStatus(id, status) {
  await fetch('/api/maintenance/records/' + encodeURIComponent(id) + '/status', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  loadReports();
  loadStats();
}

// Export Excel
function exportExcel() {
  const params = getFilterParams();
  window.location.href = '/api/maintenance/export/excel?' + params;
}

// Clear filters
function clearFilters() {
  document.getElementById('filterEquipment').value = '';
  document.getElementById('filterEngineer').value = '';
  document.getElementById('filterStatus').value = '';
  document.getElementById('filterVerification').value = '';
  document.getElementById('filterAbnormality').value = '';
  document.getElementById('filterDateFrom').value = '';
  document.getElementById('filterDateTo').value = '';
  loadReports();
}

// Helpers
function getStatusTag(status) {
  switch (status) {
    case 'reviewed': return '<span class="tag tag-warning">👁️ Reviewed</span>';
    case 'resolved': return '<span class="tag tag-normal">✅ Resolved</span>';
    default: return '<span class="tag" style="background:var(--warning-light);color:var(--warning);">⏳ Pending</span>';
  }
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  // Timestamps are stored in IST — parse as local time (append IST offset to avoid UTC conversion)
  const d = new Date(dateStr.replace(' ', 'T') + '+05:30');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) +
    ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
