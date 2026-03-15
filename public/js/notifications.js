// ===== Notifications Page JS =====

// Auth check
fetch('/api/auth/me').then(r => {
  if (!r.ok) window.location.href = '/';
  return r.json();
}).then(user => {
  if (user.role !== 'admin') window.location.href = '/dashboard.html';
}).catch(() => window.location.href = '/');

// Logout
document.getElementById('logoutBtn').addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
});

// Load notifications
async function loadNotifications() {
  const res = await fetch('/api/notifications');
  const notifications = await res.json();
  const container = document.getElementById('notificationsList');

  // Update badge
  const unreadCount = notifications.filter(n => !n.is_read).length;
  const criticalCount = notifications.filter(n => !n.is_read && n.priority === 'critical').length;
  const badge = document.getElementById('alertBadge');
  if (unreadCount > 0) {
    badge.textContent = unreadCount;
    badge.style.display = 'inline';
  } else {
    badge.style.display = 'none';
  }

  // Update stats
  if (document.getElementById('statCriticalAlerts'))
    document.getElementById('statCriticalAlerts').textContent = criticalCount;
  if (document.getElementById('statTotalUnread'))
    document.getElementById('statTotalUnread').textContent = unreadCount;
  if (document.getElementById('statTotalAlerts'))
    document.getElementById('statTotalAlerts').textContent = notifications.length;

  if (!notifications.length) {
    container.innerHTML = `
      <div class="no-data">
        <div style="font-size:3rem;">🔕</div>
        <p>No abnormality alerts yet. Alerts will appear here when engineers report issues.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = notifications.map(n => `
    <div class="notification-item ${n.is_read ? 'read' : ''} ${n.priority === 'critical' ? 'critical-notif' : ''}" id="notif-${n.id}">
      <div class="notif-content">
        <h4>
          ${n.priority === 'critical' ? '🚨' : (n.is_read ? '🔕' : '⚠️')}
          ${escapeHtml(n.equipment_name)} — ${escapeHtml(n.location_name)}
          ${n.priority === 'critical' ? '<span class="tag tag-abnormal">CRITICAL</span>' : ''}
        </h4>
        <p>${escapeHtml(n.message)}</p>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.5rem;">
        <span class="notif-time">${timeAgo(n.created_at)}</span>
        ${!n.is_read ? `<button class="btn btn-sm btn-secondary" onclick="markRead('${n.id}')">
          ✔ Read
        </button>` : ''}
      </div>
    </div>
  `).join('');
}

loadNotifications();

// Auto-refresh every 15 seconds
setInterval(loadNotifications, 15000);

// Mark as read
async function markRead(id) {
  await fetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'PUT' });
  loadNotifications();
}

// Mark all read
document.getElementById('markAllReadBtn').addEventListener('click', async () => {
  await fetch('/api/notifications/read-all', { method: 'PUT' });
  loadNotifications();
});

// Helpers
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function timeAgo(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);

  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}
