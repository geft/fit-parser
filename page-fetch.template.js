(function () {
  'use strict';

/* FIT_CORE */

function extractFitBuffer(buffer) { return FIT.extractFit(buffer); }

function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : null;
  }

  async function garminFetch(url) {
    const headers = { 'Accept': 'application/json' };
    const csrf = getCsrfToken();
    if (csrf) {
      headers['connect-csrf-token'] = csrf;
    }

    console.log('[GFE] Fetching:', url, 'CSRF:', csrf ? 'yes' : 'no');

    const resp = await fetch(url, {
      credentials: 'same-origin',
      headers
    });

    if (!resp.ok) {
      throw new Error(`Garmin API error (HTTP ${resp.status}).`);
    }

    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      throw new Error('Garmin returned HTML. Please sign out and back in.');
    }

    return resp;
  }

  // ---- Message handler ----
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'garmin-fit-exporter') return;

    const { action, requestId } = event.data;

    if (action === 'fetchActivities') {
      try {
        const url = '/gc-api/activitylist-service/activities/search/activities?' +
          new URLSearchParams({
            activityType: 'running',
            limit: '5',
            start: '0',
          });

        const resp = await garminFetch(url);
        const activities = await resp.json();

        window.postMessage({
          source: 'garmin-fit-exporter-response',
          requestId, success: true, data: activities
        }, '*');
      } catch (err) {
        window.postMessage({
          source: 'garmin-fit-exporter-response',
          requestId, success: false, error: err.message
        }, '*');
      }
    }

    if (action === 'fetchActivityDetails') {
      try {
        const url = `/gc-api/activity-service/activity/${event.data.activityId}`;
        const resp = await garminFetch(url);
        const activity = await resp.json();

        window.postMessage({
          source: 'garmin-fit-exporter-response',
          requestId, success: true, data: activity
        }, '*');
      } catch (err) {
        window.postMessage({
          source: 'garmin-fit-exporter-response',
          requestId, success: false, error: err.message
        }, '*');
      }
    }

    if (action === 'downloadFit') {
      let attempts = 0;
      const MAX_ATTEMPTS = 3;
      let lastError = null;

      while (attempts < MAX_ATTEMPTS) {
        try {
          attempts++;
          const url = `/gc-api/download-service/files/activity/${event.data.activityId}`;
          const headers = { 'Accept': '*/*' };
          const csrf = getCsrfToken();
          if (csrf) headers['connect-csrf-token'] = csrf;

          console.log(`[GFE] Download attempt ${attempts}/${MAX_ATTEMPTS}...`);
          const resp = await fetch(url, { credentials: 'same-origin', headers });

          if (!resp.ok) {
            if (resp.status === 403 || resp.status === 401) {
              throw new Error('Garmin session expired. Please refresh and log in again.');
            }
            throw new Error(`Failed to download FIT (HTTP ${resp.status}).`);
          }

          const ct = resp.headers.get('content-type') || '';
          if (ct.includes('text/html')) {
            throw new Error('FIT download failed — got HTML instead of data.');
          }

          const rawBuffer = await resp.arrayBuffer();

          // INSTANT PARSING IN PAGE CONTEXT
          console.log('[GFE] Extracting FIT from ZIP...', rawBuffer.byteLength, 'bytes');
          const fitBuffer = await extractFitBuffer(rawBuffer);

          console.log('[GFE] Parsing FIT file...', fitBuffer.byteLength, 'bytes');
          const parsed = FIT.parse(fitBuffer);
          const { records } = parsed;

          console.log('[GFE] Building CSV...', records.length, 'records');
          const csv = FIT.toCSV(parsed, event.data.activity);

          // Return exactly the CSV text
          window.postMessage({
            source: 'garmin-fit-exporter-response',
            requestId, success: true, data: csv
          }, '*');
          return; // Success!
        } catch (err) {
          lastError = err;
          console.error(`[GFE] Attempt ${attempts} failed:`, err.message);
          if (err.message.includes('expired')) break; // Don't retry if auth is dead
          if (attempts < MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, 1000)); // Wait 1s before retry
          }
        }
      }

      // If we reach here, all attempts failed
      window.postMessage({
        source: 'garmin-fit-exporter-response',
        requestId, success: false, error: lastError.message
      }, '*');
    }

  });

  window.postMessage({ source: 'garmin-fit-exporter-ready' }, '*');
})();
