/**
 * Garmin FIT → CSV Exporter — Background Service Worker
 * 
 * Orchestrates: parse → CSV → download
 */

// Import libraries
importScripts('lib/fit-parser.js');

function base64ToBuffer(base64) {
  const binary_string = atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Extract or return the FIT file buffer
 */
function extractFitBuffer(buffer) { return FIT.extractFit(buffer); }

/**
 * Convert parsed FIT data to CSV string with header comments.
 */
function getMMDD(dateInput) {
  if (dateInput) {
    try {
      const d = new Date(typeof dateInput === 'string' ? dateInput.replace(' ', 'T') : dateInput);
      if (!isNaN(d.getTime())) {
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${mm}${dd}`;
      }
    } catch { }
  }
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}${dd}`;
}

/**
 * Determine the workout type from activity name.
 */
function determineWorkoutType(activityName) {
  if (!activityName) return 'unknown';
  const name = activityName.toLowerCase();
  if (name.includes('vo2')) return 'vo2max';
  if (name.includes('hill')) return 'hill';
  if (name.includes('threshold')) return 'threshold';
  if (name.includes('medium')) return 'medium';
  if (name.includes('long')) return 'long';
  return 'unknown';
}

/**
 * Main export flow.
 */
async function parseAndExportRun(activity, fitDataBase64) {
  console.log('[GFE] Step 1: Decoding base64...', fitDataBase64.length, 'chars');
  // Step 1: Decode base64 to ArrayBuffer
  const rawBuffer = base64ToBuffer(fitDataBase64);
  console.log('[GFE] Step 2: Extracting FIT from ZIP...', rawBuffer.byteLength, 'bytes');

  // Step 2: Extract FIT file from ZIP
  const fitBuffer = extractFitBuffer(rawBuffer);
  console.log('[GFE] Step 3: Parsing FIT file...', fitBuffer.byteLength, 'bytes');

  // Step 3: Parse FIT → records + session
  const parsed = FIT.parse(fitBuffer);
  const { records, session } = parsed;
  console.log('[GFE] Step 4: Building CSV...', records.length, 'records');

  // Step 4: Convert to CSV
  const csv = FIT.toCSV(parsed, activity);
  console.log('[GFE] Step 5: Creating download...');

  // Step 5: Create download
  const dateStr = (activity && (activity.startTimeLocal || activity.summaryDTO?.startTimeLocal || activity.startTimeGMT || activity.summaryDTO?.startTimeGMT || activity.metadataDTO?.startTimeLocal || activity.metadataDTO?.startTimeGMT)) || session?.start_time || records?.[0]?.timestamp;
  const mmdd = getMMDD(dateStr);
  const actName = (activity && (activity.activityName || activity.summaryDTO?.activityName || activity.metadataDTO?.activityName)) || '';
  const workoutType = determineWorkoutType(actName);
  const filename = `${mmdd} ${workoutType}.csv`;

  // Use base64 data URI for download to avoid Blob URL cross-origin issues in Chrome MV3
  const csvBase64 = btoa(unescape(encodeURIComponent(csv)));
  const url = `data:text/csv;base64,${csvBase64}`;

  const downloadId = await chrome.downloads.download({
    url: url,
    filename: filename,
    saveAs: false,
  });

  return {
    success: true,
    filename,
    activityName: activity.activityName || 'Run',
    activityId: activity.activityId,
    recordCount: records.length,
    date: mmdd,
  };
}

// ---- Message Listener ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'parseAndExportRun') {
    parseAndExportRun(message.activity, message.fitDataBase64)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open for async response
  }
});

