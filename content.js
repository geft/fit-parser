/**
 * Garmin FIT → CSV Exporter — Content Script
 * 
 * Injects page-fetch.js immediately (to intercept Garmin's auth),
 * then sets up UI when DOM is ready.
 */

(function () {
  'use strict';

  const RUNNING_TYPES = ['running', 'trail_running', 'treadmill_running', 'track_running'];

  // ---- postMessage helper ----
  let requestCounter = 0;
  const pendingRequests = new Map();

  function pageRequest(action, extra = {}) {
    return new Promise((resolve, reject) => {
      const requestId = `gfe-${++requestCounter}`;
      pendingRequests.set(requestId, { resolve, reject });

      window.postMessage({
        source: 'garmin-fit-exporter',
        action,
        requestId,
        ...extra
      }, '*');

      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          reject(new Error('Request timed out (30s). Try refreshing the page.'));
        }
      }, 30000);
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'garmin-fit-exporter-response') return;

    const { requestId, success, data, error } = event.data;
    const pending = pendingRequests.get(requestId);
    if (!pending) return;
    pendingRequests.delete(requestId);

    if (success) {
      pending.resolve(data);
    } else {
      pending.reject(new Error(error));
    }
  });

  // ---- Set up UI when DOM is ready ----
  function initUI() {
    if (document.getElementById('garmin-fit-exporter-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'garmin-fit-exporter-btn';
    btn.innerHTML = `
      <span class="gfe-icon">📊</span>
      <span class="gfe-label">Export Run CSV</span>
    `;
    btn.title = 'Export latest run as CSV for AI analysis';
    document.body.appendChild(btn);

    const toastContainer = document.createElement('div');
    toastContainer.id = 'gfe-toast-container';
    document.body.appendChild(toastContainer);

    function showToast(message, type = 'info') {
      const toast = document.createElement('div');
      toast.className = `gfe-toast gfe-toast-${type}`;
      toast.textContent = message;
      toastContainer.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add('gfe-toast-visible'));
      setTimeout(() => {
        toast.classList.remove('gfe-toast-visible');
        setTimeout(() => toast.remove(), 300);
      }, 5000);
    }

    let isExporting = false;

    btn.addEventListener('click', async () => {
      if (isExporting) return;
      isExporting = true;
      btn.classList.add('gfe-loading');
      btn.querySelector('.gfe-label').textContent = 'Exporting...';

      try {
        showToast('Fetching latest run...', 'info');
        const activities = await pageRequest('fetchActivities');

        if (!activities || !Array.isArray(activities) || activities.length === 0) {
          throw new Error('No running activities found in your Garmin Connect account.');
        }

        const activity = activities.find(a => {
          const type = (a.activityType?.typeKey || '').toLowerCase();
          return RUNNING_TYPES.includes(type);
        }) || activities[0];

        showToast('Processing FIT file...', 'info');
        // pageRequest now returns the parsed CSV string directly
        const resultPayload = await pageRequest('downloadFit', { 
          activityId: activity.activityId,
          activity: activity // Pass metadata so parser can add it to CSV
        });

        // The page script returns { success: true, csv: '...' } in its payload
        // But our pageRequest function resolves with the `data` property.
        // I noticed in bundle.js I returned it as `csv: csv`, so let me handle both
        const csvText = typeof resultPayload === 'string' ? resultPayload : resultPayload.csv || resultPayload.data;
        
        if (!csvText || typeof csvText !== 'string' || !csvText.includes('\n')) {
          console.error('[GFE] Payload validation failed. Received payload:', resultPayload);
          throw new Error('Failed to generate CSV data.');
        }

        // ---- Create MMDD [type].csv filename ----
        let mmdd = '';
        try {
          const d = new Date(activity.startTimeLocal || activity.startTimeGMT || Date.now());
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          mmdd = `${mm}${dd}`;
        } catch { mmdd = '0000'; }

        const nameLower = (activity.activityName || '').toLowerCase();
        let workoutType = 'unknown';
        if (nameLower.includes('hill')) workoutType = 'hill';
        else if (nameLower.includes('threshold')) workoutType = 'threshold';
        else if (nameLower.includes('medium')) workoutType = 'medium';
        else if (nameLower.includes('long')) workoutType = 'long';

        const filename = `${mmdd} ${workoutType}.csv`;

        // ---- Trigger Download ----
        const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);

        showToast(`✅ Saved ${filename}`, 'success');
      } catch (err) {
        console.error('[GFE] Export error:', err);
        showToast(`❌ ${err.message}`, 'error');
      } finally {
        isExporting = false;
        btn.classList.remove('gfe-loading');
        btn.querySelector('.gfe-label').textContent = 'Export Run CSV';
      }
    });
  }

  // Wait for body to exist before adding UI
  if (document.body) {
    initUI();
  } else {
    document.addEventListener('DOMContentLoaded', initUI);
  }
})();
