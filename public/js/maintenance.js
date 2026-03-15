// ===== Maintenance Form JS (Mobile-First) =====

let currentEquipment = null;
let userLat = null;
let userLng = null;
let userAccuracy = null;
let photoBase64 = null;
let filledCount = 0;
let totalFields = 0;

// Get QR token and scan session from URL
const pathParts = window.location.pathname.split('/');
const qrToken = pathParts[pathParts.length - 1];
const urlParams = new URLSearchParams(window.location.search);
const scanSessionId = urlParams.get('session');

// Step 1: Show Employee ID input
function showEmployeeIdStep() {
  document.getElementById('employeeIdStep').style.display = 'block';
  document.getElementById('employeeIdInput').focus();
}

// Allow Enter key to submit Employee ID
document.getElementById('employeeIdInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); verifyEmployee(); }
});

// Verify Employee ID against Excel data and proceed
async function verifyEmployee() {
  const empId = document.getElementById('employeeIdInput').value.trim();
  const errorEl = document.getElementById('employeeError');
  errorEl.style.display = 'none';

  if (!empId) {
    errorEl.textContent = 'Please enter your Employee ID.';
    errorEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('verifyEmployeeBtn');
  btn.disabled = true;
  btn.textContent = 'Verifying...';

  try {
    const res = await fetch('/api/verify-employee', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: empId })
    });
    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || 'Employee ID not found. Please check and try again.';
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Verify & Continue';
      return;
    }

    // Success — hide step and continue to next steps
    document.getElementById('employeeIdStep').style.display = 'none';
    if (!(await loadEquipment())) return;
    if (!(await verifyLocation())) return;
    renderForm();
  } catch {
    errorEl.textContent = 'Connection error. Please try again.';
    errorEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Verify & Continue';
  }
}

// Step 2: Load equipment data
async function loadEquipment() {
  try {
    const res = await fetch(`/api/equipment/scan/${encodeURIComponent(qrToken)}`);
    if (!res.ok) {
      document.getElementById('locationDenied').style.display = 'block';
      document.getElementById('locationDeniedMsg').textContent = 'Invalid or expired QR code. Please scan a valid QR code.';
      return false;
    }
    currentEquipment = await res.json();
    return true;
  } catch {
    document.getElementById('locationDenied').style.display = 'block';
    document.getElementById('locationDeniedMsg').textContent = 'Could not load equipment data. Please check your connection.';
    return false;
  }
}

// Step 3: Verify location
let locationResolve = null;

function verifyLocation() {
  return new Promise((resolve) => {
    locationResolve = resolve;
    attemptLocation();
  });
}

function attemptLocation() {
  document.getElementById('locationCheck').style.display = 'block';
  document.getElementById('locationDenied').style.display = 'none';

  if (!navigator.geolocation) {
    showLocationError('Your browser does not support GPS location. Please use a modern mobile browser like Chrome or Safari.');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      userLat = position.coords.latitude;
      userLng = position.coords.longitude;
      userAccuracy = position.coords.accuracy;
      document.getElementById('locationCheck').style.display = 'none';
      if (locationResolve) { locationResolve(true); locationResolve = null; }
    },
    (error) => {
      let msg = '';
      if (error.code === error.PERMISSION_DENIED) {
        msg = 'Location permission was denied. Please:\n' +
          '1. Open your phone Settings\n' +
          '2. Go to Apps → Browser (Chrome/Safari)\n' +
          '3. Enable Location permission\n' +
          '4. Tap "Retry Location" below';
      } else if (error.code === error.POSITION_UNAVAILABLE) {
        msg = 'GPS signal not available. Please:\n' +
          '1. Enable Location/GPS in your phone Settings\n' +
          '2. Go outside or near a window for better signal\n' +
          '3. Tap "Retry Location" below';
      } else if (error.code === error.TIMEOUT) {
        msg = 'Location request timed out. Please:\n' +
          '1. Make sure GPS/Location is ON in your phone Settings\n' +
          '2. Wait a few seconds for GPS to lock\n' +
          '3. Tap "Retry Location" below';
      } else {
        msg = 'Could not get your location. Please enable GPS in your phone settings and tap "Retry Location".';
      }
      showLocationError(msg);
    },
    { enableHighAccuracy: true, timeout: 30000, maximumAge: 60000 }
  );
}

function showLocationError(msg) {
  document.getElementById('locationCheck').style.display = 'none';
  document.getElementById('locationDenied').style.display = 'block';
  document.getElementById('locationDeniedMsg').textContent = msg;
}

function skipLocation() {
  document.getElementById('locationDenied').style.display = 'none';
  if (locationResolve) { locationResolve(true); locationResolve = null; }
}

// Step 4: Render form as mobile-friendly cards
function renderForm() {
  document.getElementById('eqName').textContent = currentEquipment.name;
  document.getElementById('eqLocation').textContent = currentEquipment.location_name || '';
  document.getElementById('eqDescription').textContent = currentEquipment.description || '';

  // GPS chip
  const badge = document.getElementById('locationBadge');
  if (userLat && userLng) {
    badge.textContent = '📍 GPS Verified';
    badge.className = 'gps-chip verified';
  } else {
    badge.textContent = '⚠ No GPS';
    badge.className = 'gps-chip unverified';
  }
  badge.style.display = 'inline-flex';

  const container = document.getElementById('fieldsContainer');
  container.innerHTML = '';

  if (!currentEquipment.fields || currentEquipment.fields.length === 0) {
    container.innerHTML = '<p class="muted" style="padding:1rem;">No check fields defined. Add notes below.</p>';
    document.getElementById('maintenanceSection').style.display = 'block';
    return;
  }

  totalFields = currentEquipment.fields.length;
  updateProgress();

  currentEquipment.fields.forEach((field, index) => {
    const fieldId = `field_${field.id}`;
    const card = document.createElement('div');
    card.className = 'field-card' + (field.is_critical ? ' field-card-critical' : '');
    card.id = `card_${field.id}`;

    let inputHtml = '';
    let rangeHint = '';

    switch (field.field_type) {
      case 'number':
        if (field.min_value != null || field.max_value != null) {
          rangeHint = `Range: ${field.min_value ?? '—'} to ${field.max_value ?? '—'}`;
        }
        inputHtml = `<input type="number" id="${fieldId}" data-field-id="${field.id}"
          class="mobile-input" inputmode="decimal" step="any"
          ${field.is_required ? 'required' : ''} placeholder="Enter value"
          onfocus="scrollToField(this)" oninput="trackField(this)">`;
        break;

      case 'text':
        inputHtml = `<input type="text" id="${fieldId}" data-field-id="${field.id}"
          class="mobile-input" autocomplete="off"
          ${field.is_required ? 'required' : ''} placeholder="Enter observation"
          onfocus="scrollToField(this)" oninput="trackField(this)">`;
        break;

      case 'select': {
        const options = (field.options || '').split(',').map(o => o.trim()).filter(Boolean);
        rangeHint = options.join(' / ');
        inputHtml = `<div class="select-pills" id="${fieldId}_pills" data-field-id="${field.id}">
          ${options.map(opt => `<button type="button" class="pill" data-value="${escapeHtml(opt)}" onclick="selectPill(this)">${escapeHtml(opt)}</button>`).join('')}
        </div>
        <input type="hidden" id="${fieldId}" data-field-id="${field.id}" ${field.is_required ? 'required' : ''}>`;
        break;
      }

      case 'checkbox':
        inputHtml = `<label class="toggle-switch">
          <input type="checkbox" id="${fieldId}" data-field-id="${field.id}" onchange="trackField(this)">
          <span class="toggle-slider"></span>
          <span class="toggle-label-text">No</span>
        </label>`;
        break;
    }

    card.innerHTML = `
      <div class="field-card-top">
        <span class="field-number">${index + 1}</span>
        <div class="field-card-label">
          <span class="field-name">${escapeHtml(field.field_name)}</span>
          ${field.is_critical ? '<span class="critical-dot"></span>' : ''}
          ${field.is_required ? '<span class="required-star">*</span>' : ''}
        </div>
      </div>
      ${rangeHint ? `<p class="field-range">${rangeHint}</p>` : ''}
      <div class="field-input-area">${inputHtml}</div>
    `;

    container.appendChild(card);
  });

  document.getElementById('maintenanceSection').style.display = 'block';
}

// Pill selector for dropdown replacement
function selectPill(btn) {
  const pills = btn.parentElement;
  pills.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  // Set hidden input value
  const fieldId = pills.dataset.fieldId;
  document.getElementById(`field_${fieldId}`).value = btn.dataset.value;
  trackField(btn);
}

// Toggle switch label
document.addEventListener('change', (e) => {
  if (e.target.closest('.toggle-switch')) {
    const label = e.target.closest('.toggle-switch').querySelector('.toggle-label-text');
    if (label) label.textContent = e.target.checked ? 'Yes' : 'No';
  }
});

// Scroll field into view on focus (avoids keyboard overlap)
function scrollToField(el) {
  setTimeout(() => {
    el.closest('.field-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 300);
}

// Track filled fields for progress
function trackField(el) {
  updateProgress();
}

function updateProgress() {
  if (!currentEquipment || !currentEquipment.fields) return;
  filledCount = 0;
  currentEquipment.fields.forEach(field => {
    const el = document.getElementById(`field_${field.id}`);
    if (!el) return;
    if (field.field_type === 'checkbox') {
      filledCount++; // checkboxes always count
    } else if (el.value && el.value.trim() !== '') {
      filledCount++;
    }
  });
  const pct = totalFields > 0 ? Math.round((filledCount / totalFields) * 100) : 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressText').textContent = `${filledCount} of ${totalFields} completed`;
}

// Photo handling
function handlePhoto(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const canvas = document.createElement('canvas');
      const maxDim = 1024;
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
        else { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      photoBase64 = canvas.toDataURL('image/jpeg', 0.7);
      document.getElementById('photoImg').src = photoBase64;
      document.getElementById('photoPreview').style.display = 'block';
      document.getElementById('photoCaptureBtn').style.display = 'none';
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function removePhoto() {
  photoBase64 = null;
  document.getElementById('photoPreview').style.display = 'none';
  document.getElementById('photoCaptureBtn').style.display = 'flex';
  document.getElementById('photoInput').value = '';
}

// Submit
document.getElementById('maintenanceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = document.getElementById('submitBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting...';

  const values = [];
  currentEquipment.fields.forEach(field => {
    const el = document.getElementById(`field_${field.id}`);
    let value = '';
    if (field.field_type === 'checkbox') {
      value = el.checked ? 'true' : 'false';
    } else {
      value = el.value;
    }
    values.push({ field_id: field.id, value });
  });

  const body = {
    equipment_id: currentEquipment.id,
    values,
    notes: document.getElementById('notes').value.trim(),
    user_lat: userLat,
    user_lng: userLng,
    accuracy: userAccuracy,
    scan_session_id: scanSessionId || null,
    photo: photoBase64 || null
  };

  try {
    const res = await fetch('/api/maintenance/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await res.json();

    if (!res.ok) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Report';
      alert(result.error || 'Failed to submit report');
      return;
    }

    document.getElementById('maintenanceSection').style.display = 'none';
    document.getElementById('successSection').style.display = 'block';

    let msg = result.message || 'Report submitted.';
    if (result.verification_status === 'verified') msg += ' | GPS ✓';
    else msg += ' | GPS unverified';
    if (result.dwell_time_minutes > 0) msg += ` | ${result.dwell_time_minutes} min on site`;
    document.getElementById('successMessage').textContent = msg;

    if (result.has_abnormality) {
      const isCritical = result.has_critical_abnormality;
      document.getElementById('abnormalTitle').textContent = isCritical
        ? '🚨 Critical Abnormality' : '⚠️ Abnormality Detected';
      document.getElementById('abnormalityMessage').textContent = isCritical
        ? 'A CRITICAL field abnormality was found. Admin has been urgently notified. Please take immediate action.'
        : 'An abnormality was found. Admin has been notified. Please take necessary precautions.';
      document.getElementById('abnormalityPopup').style.display = 'flex';
    }
  } catch {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Report';
    alert('Network error. Please check your connection.');
  }
});

// Helpers
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Init — show Employee ID step first
showEmployeeIdStep();
