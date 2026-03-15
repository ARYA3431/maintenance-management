// ===== Admin Dashboard JS =====

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
      badge.textContent = data.critical_count > 0
        ? `🚨 ${data.count}`
        : data.count;
      badge.style.display = 'inline';
      if (data.critical_count > 0) {
        badge.style.background = '#dc2626';
        badge.style.animation = 'pulse 1s infinite';
      }
    } else {
      badge.style.display = 'none';
    }
    // Update stats card
    if (document.getElementById('statAlerts')) {
      document.getElementById('statAlerts').textContent = data.count;
    }
  } catch (e) { /* ignore */ }
}
loadAlertBadge();
setInterval(loadAlertBadge, 30000);

// ===== Equipment List =====
async function loadEquipment() {
  const res = await fetch('/api/equipment');
  const equipment = await res.json();
  const container = document.getElementById('equipmentList');

  // Update stats
  if (document.getElementById('statTotal')) {
    document.getElementById('statTotal').textContent = equipment.length;
    document.getElementById('statCritical').textContent = equipment.filter(e => e.is_critical).length;
  }

  if (!equipment.length) {
    container.innerHTML = '<div class="card text-center no-data"><p>📦 No equipment registered yet. Click "Add Equipment" to get started.</p></div>';
    return;
  }

  container.innerHTML = equipment.map(eq => `
    <div class="card equipment-card ${eq.is_critical ? 'equipment-critical' : ''}">
      <div class="eq-card-header">
        <h3>⚙️ ${escapeHtml(eq.name)}</h3>
        ${eq.is_critical ? '<span class="tag tag-abnormal">🔴 CRITICAL</span>' : '<span class="tag tag-normal">✅ Standard</span>'}
      </div>
      <p class="subtitle">📍 ${escapeHtml(eq.location_name)}</p>
      <p class="hint">${escapeHtml(eq.description || 'No description')}</p>
      <div class="eq-meta">
        <span>🎯 GPS: ${eq.latitude.toFixed(4)}, ${eq.longitude.toFixed(4)}</span>
        <span>📏 Radius: ${eq.radius_meters}m</span>
      </div>
      <div class="card-actions">
        <button class="btn btn-primary btn-sm" onclick="showQR('${eq.id}')">
          📱 QR Code
        </button>
        <button class="btn btn-secondary btn-sm" onclick="showHistory('${eq.id}')">
          📜 History
        </button>
        <button class="btn btn-danger btn-sm" onclick="deleteEquipment('${eq.id}', '${escapeHtml(eq.name)}')">
          🗑️ Delete
        </button>
      </div>
    </div>
  `).join('');
}
loadEquipment();

// ===== Show QR Code =====
async function showQR(equipmentId) {
  const res = await fetch(`/api/equipment/${encodeURIComponent(equipmentId)}/qr`);
  const data = await res.json();

  document.getElementById('qrContent').innerHTML = `
    <img src="${data.qr_image}" alt="QR Code">
    <p class="scan-url">${escapeHtml(data.scan_url)}</p>
    <button class="btn btn-secondary btn-sm" style="margin-top:0.75rem;" onclick="copyUrl('${escapeHtml(data.scan_url)}', this)">
      📋 Copy URL
    </button>
    <p class="hint" style="margin-top:0.5rem;">Print and place this QR code at the equipment location.</p>
  `;
  document.getElementById('qrModal').style.display = 'flex';
}

function closeQrModal() {
  document.getElementById('qrModal').style.display = 'none';
}

function printQR() {
  window.print();
}

// ===== History =====
async function showHistory(equipmentId) {
  const res = await fetch(`/api/maintenance/history/${encodeURIComponent(equipmentId)}`);
  const records = await res.json();
  const container = document.getElementById('historyContent');

  if (!records.length) {
    container.innerHTML = '<div class="no-data">📋<p>No maintenance records yet.</p></div>';
  } else {
    container.innerHTML = `
      <table class="history-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Engineer</th>
            <th>GPS</th>
            <th>Distance</th>
            <th>Status</th>
            <th>Result</th>
            <th>Photo</th>
            <th>Details</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          ${records.map(r => `
            <tr class="${r.has_abnormality ? 'row-abnormal' : ''}">
              <td>${formatIST(r.submitted_at)}</td>
              <td>${escapeHtml(r.employee_name)}</td>
              <td>${(r.verification_status || 'unverified') === 'verified'
                ? '<span class="tag tag-normal">✅</span>'
                : '<span class="tag tag-warning">❌</span>'}</td>
              <td>${r.distance_meters != null ? r.distance_meters + 'm' : '—'}</td>
              <td>${getStatusTag(r.status)}</td>
              <td>${r.has_abnormality
                ? '<span class="tag tag-abnormal">⚠️ Abnormal</span>'
                : '<span class="tag tag-normal">✅ Normal</span>'}</td>
              <td>${r.photo_path ? '<a href="' + escapeHtml(r.photo_path) + '" target="_blank" class="tag tag-normal">📷</a>' : '—'}</td>
              <td>${r.values.map(v =>
                `<strong>${escapeHtml(v.field_name)}:</strong> ${escapeHtml(v.value)}${v.is_abnormal ? ' <span class="tag tag-abnormal">!</span>' : ''}`
              ).join('<br>')}</td>
              <td>${escapeHtml(r.notes || '-')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div style="margin-top:1rem;text-align:right;">
        <a href="/reports.html?equipment_id=${equipmentId}" class="btn btn-primary btn-sm">📊 Full Report View</a>
      </div>
    `;
  }
  document.getElementById('historyModal').style.display = 'flex';
}

function getStatusTag(status) {
  switch (status) {
    case 'reviewed': return '<span class="tag tag-warning">👁️ Reviewed</span>';
    case 'resolved': return '<span class="tag tag-normal">✅ Resolved</span>';
    default: return '<span class="tag" style="background:var(--warning-light);color:var(--warning);">⏳ Pending</span>';
  }
}

function closeHistoryModal() {
  document.getElementById('historyModal').style.display = 'none';
}

// ===== Delete Equipment =====
async function deleteEquipment(id, name) {
  if (!confirm(`Are you sure you want to delete "${name}"? This will remove all maintenance records.`)) return;
  await fetch(`/api/equipment/${encodeURIComponent(id)}`, { method: 'DELETE' });
  loadEquipment();
}

// ===== Add Equipment Modal =====
document.getElementById('addEquipmentBtn').addEventListener('click', () => {
  document.getElementById('addModal').style.display = 'flex';
  // Add one default field
  if (document.getElementById('fieldsContainer').children.length === 0) {
    addField();
  }
});

function closeModal() {
  document.getElementById('addModal').style.display = 'none';
}

// Use current location
document.getElementById('useMyLocationBtn').addEventListener('click', () => {
  if (!navigator.geolocation) {
    alert('Geolocation not supported by your browser');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      document.getElementById('eqLat').value = pos.coords.latitude.toFixed(6);
      document.getElementById('eqLng').value = pos.coords.longitude.toFixed(6);
    },
    err => alert('Could not get location: ' + err.message),
    { enableHighAccuracy: true }
  );
});

// ===== Dynamic Fields =====
let fieldCounter = 0;

function addField() {
  fieldCounter++;
  const container = document.getElementById('fieldsContainer');
  const div = document.createElement('div');
  div.className = 'field-row';
  div.id = `field-${fieldCounter}`;
  div.innerHTML = `
    <button type="button" class="remove-field" onclick="removeField(${fieldCounter})" title="Remove field">&times;</button>
    <div class="form-row">
      <div class="form-group">
        <label>Field Name</label>
        <input type="text" class="field-name" required placeholder="e.g., Temperature">
      </div>
      <div class="form-group">
        <label>Type</label>
        <select class="field-type" onchange="toggleFieldOptions(${fieldCounter})">
          <option value="number">Number</option>
          <option value="text">Text</option>
          <option value="select">Dropdown</option>
          <option value="checkbox">Checkbox</option>
        </select>
      </div>
    </div>
    <div class="form-row field-options" id="field-options-${fieldCounter}">
      <div class="form-group">
        <label>Min Value (normal range)</label>
        <input type="number" class="field-min" step="any" placeholder="e.g., 20">
      </div>
      <div class="form-group">
        <label>Max Value (normal range)</label>
        <input type="number" class="field-max" step="any" placeholder="e.g., 80">
      </div>
    </div>
    <div class="form-group field-select-options" id="field-select-${fieldCounter}" style="display:none;">
      <label>Options (comma-separated)</label>
      <input type="text" class="field-options-list" placeholder="e.g., Normal, Abnormal, Critical">
    </div>
    <label class="checkbox-label">
      <input type="checkbox" class="field-required" checked> Required
    </label>
    <label class="checkbox-label" style="margin-top:0.5rem;color:var(--danger);">
      <input type="checkbox" class="field-critical"> 🔴 Critical (admin will be alerted if abnormal)
    </label>
  `;
  container.appendChild(div);
}

document.getElementById('addFieldBtn').addEventListener('click', addField);

function removeField(id) {
  const el = document.getElementById(`field-${id}`);
  if (el) el.remove();
}

function toggleFieldOptions(id) {
  const row = document.getElementById(`field-${id}`);
  const type = row.querySelector('.field-type').value;
  const numOptions = document.getElementById(`field-options-${id}`);
  const selectOptions = document.getElementById(`field-select-${id}`);

  numOptions.style.display = type === 'number' ? 'grid' : 'none';
  selectOptions.style.display = type === 'select' ? 'block' : 'none';
}

// ===== Submit Equipment Form =====
document.getElementById('equipmentForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const fields = [];
  document.querySelectorAll('.field-row').forEach(row => {
    const name = row.querySelector('.field-name').value.trim();
    const type = row.querySelector('.field-type').value;
    const min = row.querySelector('.field-min')?.value;
    const max = row.querySelector('.field-max')?.value;
    const options = row.querySelector('.field-options-list')?.value.trim();
    const required = row.querySelector('.field-required').checked;

    const critical = row.querySelector('.field-critical').checked;
    if (name) {
      fields.push({
        field_name: name,
        field_type: type,
        min_value: min ? parseFloat(min) : null,
        max_value: max ? parseFloat(max) : null,
        options: options || null,
        is_required: required,
        is_critical: critical
      });
    }
  });

  const body = {
    name: document.getElementById('eqName').value.trim(),
    description: document.getElementById('eqDescription').value.trim(),
    location_name: document.getElementById('eqLocation').value.trim(),
    latitude: parseFloat(document.getElementById('eqLat').value),
    longitude: parseFloat(document.getElementById('eqLng').value),
    radius_meters: parseInt(document.getElementById('eqRadius').value) || 100,
    is_critical: document.getElementById('eqCritical').checked,
    fields
  };

  const res = await fetch('/api/equipment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (res.ok) {
    closeModal();
    document.getElementById('equipmentForm').reset();
    document.getElementById('fieldsContainer').innerHTML = '';
    fieldCounter = 0;
    loadEquipment();
  } else {
    const err = await res.json();
    alert(err.error || 'Failed to create equipment');
  }
});

// ===== Copy URL =====
function copyUrl(url, btn) {
  navigator.clipboard.writeText(url).then(() => {
    btn.textContent = '✅ Copied!';
    setTimeout(() => { btn.textContent = '📋 Copy URL'; }, 2000);
  }).catch(() => {
    const input = document.createElement('input');
    input.value = url;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
    btn.textContent = '✅ Copied!';
    setTimeout(() => { btn.textContent = '📋 Copy URL'; }, 2000);
  });
}

// ===== Equipment Excel Import/Export =====

// Download template
document.getElementById('downloadTemplateBtn').addEventListener('click', () => {
  window.location.href = '/api/equipment/excel/template';
});

// Export existing equipment
document.getElementById('exportExcelBtn').addEventListener('click', () => {
  window.location.href = '/api/equipment/excel/export';
});

// Import from Excel
document.getElementById('importExcelBtn').addEventListener('click', () => {
  document.getElementById('excelFileInput').click();
});

document.getElementById('excelFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  const btn = document.getElementById('importExcelBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Importing...';

  try {
    const res = await fetch('/api/equipment/excel/import', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (res.ok) {
      let msg = data.message;
      if (data.errors && data.errors.length > 0) {
        msg += '\n\nWarnings:\n' + data.errors.join('\n');
      }
      alert(msg);
      loadEquipment();
    } else {
      alert('Import failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Import failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '📤 Import Excel';
    e.target.value = ''; // Reset file input
  }
});

// ===== Helpers =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatIST(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr.replace(' ', 'T') + '+05:30');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) +
    ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
}
