/**
 * Garmin FIT → CSV Exporter — Content Script
 * 
 * Injects a floating export button on Garmin Connect pages.
 */

(function () {
  'use strict';

  // Prevent double injection
  if (document.getElementById('garmin-fit-exporter-btn')) return;

  // ---- Create floating button ----
  const btn = document.createElement('button');
  btn.id = 'garmin-fit-exporter-btn';
  btn.innerHTML = `
    <span class="gfe-icon">📊</span>
    <span class="gfe-label">Export Run CSV</span>
  `;
  btn.title = 'Export latest run as CSV for AI analysis';
  document.body.appendChild(btn);

  // ---- Create toast container ----
  const toastContainer = document.createElement('div');
  toastContainer.id = 'gfe-toast-container';
  document.body.appendChild(toastContainer);

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `gfe-toast gfe-toast-${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => toast.classList.add('gfe-toast-visible'));

    // Remove after 5s
    setTimeout(() => {
      toast.classList.remove('gfe-toast-visible');
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }

  // ---- Button click handler ----
  let isExporting = false;

  btn.addEventListener('click', async () => {
    if (isExporting) return;
    isExporting = true;
    btn.classList.add('gfe-loading');
    btn.querySelector('.gfe-label').textContent = 'Exporting...';

    try {
      const result = await chrome.runtime.sendMessage({ action: 'exportLatestRun' });

      if (result.success) {
        showToast(
          `✅ Saved ${result.filename} (${result.recordCount} records from "${result.activityName}")`,
          'success'
        );
      } else {
        showToast(`❌ ${result.error}`, 'error');
      }
    } catch (err) {
      showToast(`❌ Extension error: ${err.message}`, 'error');
    } finally {
      isExporting = false;
      btn.classList.remove('gfe-loading');
      btn.querySelector('.gfe-label').textContent = 'Export Run CSV';
    }
  });
})();
