// ===== Maintenance Form JS (Mobile-First) =====

let currentEquipment = null;
let userLat = null;
let userLng = null;
let userAccuracy = null;
let photoBase64 = null;
let filledCount = 0;
let totalFields = 0;
let selectedTaskType = 'inspection'; // 'inspection' or 'maintenance'
let currentStep = 'employee'; // tracks current step for back button
let employeeName = ''; // store verified employee name

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

    // Success — store employee name and greet
    employeeName = data.fullName || '';
    const greetEl = document.getElementById('employeeGreeting');
    if (greetEl && employeeName) {
      greetEl.textContent = '\u2705 Welcome, ' + employeeName + '!';
      greetEl.style.display = 'block';
    }
    // Update nav title with employee name
    const navTitle = document.getElementById('navTitle');
    if (navTitle && employeeName) {
      navTitle.textContent = '\ud83d\udc4b ' + employeeName.split(' ')[0];
    }

    // Brief delay so user sees greeting before moving on
    await new Promise(r => setTimeout(r, 1000));

    // Hide step and continue to next steps
    document.getElementById('employeeIdStep').style.display = 'none';
    currentStep = 'location';
    if (!(await loadEquipment())) return;
    if (!(await verifyLocation())) return;
    currentStep = 'taskType';
    showTaskTypeChooser();
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

// Show Task Type Chooser
function showTaskTypeChooser() {
  document.getElementById('taskTypeStep').style.display = 'block';
}

// Select task type and proceed to form
function selectTaskType(type) {
  selectedTaskType = type;
  document.getElementById('taskTypeStep').style.display = 'none';
  currentStep = 'form';

  // Update badge
  const badge = document.getElementById('taskTypeBadge');
  if (type === 'maintenance') {
    badge.textContent = '🔧 Maintenance';
    badge.className = 'task-type-badge badge-maintenance';
    document.getElementById('maintenanceExtraFields').style.display = 'block';
  } else {
    badge.textContent = '🔍 Inspection';
    badge.className = 'task-type-badge badge-inspection';
    document.getElementById('maintenanceExtraFields').style.display = 'none';
  }

  renderForm();
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

  // Attach real-time abnormality detection
  setTimeout(attachAbnormalityListeners, 100);
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
    task_type: selectedTaskType,
    values,
    notes: document.getElementById('notes').value.trim(),
    user_lat: userLat,
    user_lng: userLng,
    accuracy: userAccuracy,
    scan_session_id: scanSessionId || null,
    photo: photoBase64 || null
  };

  // Add maintenance-specific fields
  if (selectedTaskType === 'maintenance') {
    body.work_done = document.getElementById('workDone').value.trim();
    body.parts_replaced = document.getElementById('partsReplaced').value.trim();
    body.time_spent_minutes = parseInt(document.getElementById('timeSpent').value) || null;

    if (!body.work_done) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Report';
      alert('Please describe the work done.');
      return;
    }
  }

  // Add evidence fields
  const abnormalReasonEl = document.getElementById('abnormalReason');
  const correctiveActionEl = document.getElementById('correctiveAction');
  if (abnormalReasonEl && abnormalReasonEl.value.trim()) body.abnormal_reason = abnormalReasonEl.value.trim();
  if (correctiveActionEl && correctiveActionEl.value.trim()) body.corrective_action = correctiveActionEl.value.trim();

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

      // If GPS distance rejection (403), show "Submit Always" button
      if (res.status === 403 && result.distance != null) {
        const forceBtn = document.getElementById('forceSubmitBtn');
        const warnMsg = document.getElementById('gpsWarningMsg');
        warnMsg.textContent = result.error || `You are ${result.distance}m away (allowed: ${result.allowed_radius}m)`;
        warnMsg.style.display = 'block';
        forceBtn.style.display = 'block';
      } else {
        alert(result.error || 'Failed to submit report');
      }
      return;
    }

    // Hide force submit on success
    document.getElementById('forceSubmitBtn').style.display = 'none';
    document.getElementById('gpsWarningMsg').style.display = 'none';

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
  } catch (err) {
    // Offline support: save to IndexedDB
    if (!navigator.onLine) {
      try {
        await saveOfflineSubmission(body);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Report';
        document.getElementById('maintenanceSection').style.display = 'none';
        document.getElementById('successSection').style.display = 'block';
        document.getElementById('successMessage').textContent = '📡 Saved offline! Your report will be submitted automatically when connection returns.';
        // Request background sync
        if ('serviceWorker' in navigator && 'SyncManager' in window) {
          const reg = await navigator.serviceWorker.ready;
          await reg.sync.register('submit-maintenance');
        }
        return;
      } catch (offlineErr) {
        console.error('Offline save failed:', offlineErr);
      }
    }
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Report';
    alert('Network error. Please check your connection.');
  }
});

// "Submit Always" — force submit overriding GPS check
document.getElementById('forceSubmitBtn').addEventListener('click', async () => {
  const submitBtn = document.getElementById('submitBtn');
  const forceBtn = document.getElementById('forceSubmitBtn');
  forceBtn.disabled = true;
  forceBtn.textContent = 'Submitting...';
  submitBtn.disabled = true;

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
    task_type: selectedTaskType,
    values,
    notes: document.getElementById('notes').value.trim(),
    user_lat: userLat,
    user_lng: userLng,
    accuracy: userAccuracy,
    scan_session_id: scanSessionId || null,
    photo: photoBase64 || null,
    force_submit: true
  };

  if (selectedTaskType === 'maintenance') {
    body.work_done = document.getElementById('workDone').value.trim();
    body.parts_replaced = document.getElementById('partsReplaced').value.trim();
    body.time_spent_minutes = parseInt(document.getElementById('timeSpent').value) || null;
  }
  const abnormalReasonEl = document.getElementById('abnormalReason');
  const correctiveActionEl = document.getElementById('correctiveAction');
  if (abnormalReasonEl && abnormalReasonEl.value.trim()) body.abnormal_reason = abnormalReasonEl.value.trim();
  if (correctiveActionEl && correctiveActionEl.value.trim()) body.corrective_action = correctiveActionEl.value.trim();

  try {
    const res = await fetch('/api/maintenance/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await res.json();

    if (!res.ok) {
      forceBtn.disabled = false;
      forceBtn.textContent = '⚠️ Submit Always (Override GPS)';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Report';
      alert(result.error || 'Failed to submit report');
      return;
    }

    forceBtn.style.display = 'none';
    document.getElementById('gpsWarningMsg').style.display = 'none';
    document.getElementById('maintenanceSection').style.display = 'none';
    document.getElementById('successSection').style.display = 'block';

    let msg = result.message || 'Report submitted.';
    if (result.verification_status === 'override') msg += ' | GPS Override ⚠️';
    else if (result.verification_status === 'verified') msg += ' | GPS ✓';
    else msg += ' | GPS unverified';
    if (result.dwell_time_minutes > 0) msg += ` | ${result.dwell_time_minutes} min on site`;
    document.getElementById('successMessage').textContent = msg;

    if (result.has_abnormality) {
      const isCritical = result.has_critical_abnormality;
      document.getElementById('abnormalTitle').textContent = isCritical
        ? '🚨 Critical Abnormality' : '⚠️ Abnormality Detected';
      document.getElementById('abnormalityMessage').textContent = isCritical
        ? 'A CRITICAL field abnormality was found. Admin has been urgently notified.'
        : 'An abnormality was found. Admin has been notified.';
      document.getElementById('abnormalityPopup').style.display = 'flex';
    }
  } catch (err) {
    forceBtn.disabled = false;
    forceBtn.textContent = '⚠️ Submit Always (Override GPS)';
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

// Offline save
async function saveOfflineSubmission(data) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('MaintenanceMMS', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('pending_submissions')) {
        db.createObjectStore('pending_submissions', { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('pending_submissions', 'readwrite');
      tx.objectStore('pending_submissions').add({ data, timestamp: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

// Show evidence fields when abnormality is detected in real-time
function checkForAbnormalities() {
  if (!currentEquipment || !currentEquipment.fields) return;
  let hasAbnormal = false;

  currentEquipment.fields.forEach(field => {
    const el = document.getElementById(`field_${field.id}`);
    if (!el) return;

    if (field.field_type === 'number' && el.value !== '') {
      const num = parseFloat(el.value);
      if (!isNaN(num)) {
        if ((field.min_value != null && num < field.min_value) || (field.max_value != null && num > field.max_value)) {
          hasAbnormal = true;
          el.closest('.field-card')?.classList.add('field-abnormal');
        } else {
          el.closest('.field-card')?.classList.remove('field-abnormal');
        }
      }
    }
    if (field.field_type === 'select' && el.value) {
      const lower = el.value.toLowerCase();
      if (['abnormal','faulty','bad','critical','not working','damaged','broken','severe','disabled'].includes(lower)) {
        hasAbnormal = true;
        el.closest('.field-card')?.classList.add('field-abnormal');
      } else {
        el.closest('.field-card')?.classList.remove('field-abnormal');
      }
    }
    if (field.field_type === 'checkbox' && el.checked) {
      const name = field.field_name.toLowerCase();
      if (name.includes('abnormal') || name.includes('issue') || name.includes('fault') || name.includes('leak') || name.includes('damage')) {
        hasAbnormal = true;
        el.closest('.field-card')?.classList.add('field-abnormal');
      }
    }
  });

  const evidenceFields = document.getElementById('evidenceFields');
  if (evidenceFields) {
    evidenceFields.style.display = hasAbnormal ? 'block' : 'none';
  }
}

// Attach listeners for real-time abnormality detection
function attachAbnormalityListeners() {
  if (!currentEquipment || !currentEquipment.fields) return;
  currentEquipment.fields.forEach(field => {
    const el = document.getElementById(`field_${field.id}`);
    if (!el) return;
    el.addEventListener('change', checkForAbnormalities);
    el.addEventListener('input', checkForAbnormalities);
  });
}

// Init — show Employee ID step first
currentStep = 'employee';
showEmployeeIdStep();

// Back button logic — navigate steps
function goBack() {
  if (currentStep === 'form') {
    document.getElementById('maintenanceSection').style.display = 'none';
    document.getElementById('taskTypeStep').style.display = 'block';
    currentStep = 'taskType';
  } else if (currentStep === 'taskType') {
    document.getElementById('taskTypeStep').style.display = 'none';
    resetEmployeeStep();
    currentStep = 'employee';
  } else if (currentStep === 'location') {
    document.getElementById('locationCheck').style.display = 'none';
    document.getElementById('locationDenied').style.display = 'none';
    resetEmployeeStep();
    currentStep = 'employee';
  } else {
    window.location.href = '/dashboard.html';
  }
}

function resetEmployeeStep() {
  document.getElementById('employeeIdStep').style.display = 'block';
  const btn = document.getElementById('verifyEmployeeBtn');
  btn.disabled = false;
  btn.textContent = 'Verify & Continue';
  document.getElementById('employeeError').style.display = 'none';
  document.getElementById('employeeGreeting').style.display = 'none';
}
