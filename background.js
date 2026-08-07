/**
 * Garmin FIT → CSV Exporter — Background Service Worker
 * 
 * Orchestrates: parse → CSV → download
 */

// Import libraries
importScripts('lib/unzip.js', 'lib/fit-parser.js');

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
function extractFitBuffer(buffer) {
  try {
    return ZIP.extractFitFromZip(buffer);
  } catch (e) {
    // Maybe it's already a raw FIT file
    const header = new Uint8Array(buffer);
    if (header.length > 12) {
      const sig = String.fromCharCode(header[8], header[9], header[10], header[11]);
      if (sig === '.FIT') return buffer;
    }
    throw new Error(`Could not extract FIT file: ${e.message}`);
  }
}

/**
 * Convert parsed FIT data to CSV string with header comments.
 */
function toCSV(records, session, activityMeta) {
  const lines = [];

  // ---- Header comment block ----
  lines.push('# Garmin Run Export — Parsed for AI Analysis');
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push('#');

  const actName = (activityMeta && (activityMeta.activityName || activityMeta.summaryDTO?.activityName || activityMeta.metadataDTO?.activityName)) || 'Unknown';
  const actId = (activityMeta && (activityMeta.activityId || activityMeta.summaryDTO?.activityId)) || '';
  const actDate = (activityMeta && (activityMeta.startTimeLocal || activityMeta.summaryDTO?.startTimeLocal || activityMeta.startTimeGMT || activityMeta.summaryDTO?.startTimeGMT || activityMeta.metadataDTO?.startTimeLocal || activityMeta.metadataDTO?.startTimeGMT)) || session?.start_time || records?.[0]?.timestamp || '';
  const sport = (activityMeta && (activityMeta.activityType?.typeKey || activityMeta.summaryDTO?.activityType?.typeKey)) || 'running';

  lines.push(`# Activity: ${actName}`);
  lines.push(`# Activity ID: ${actId}`);
  lines.push(`# Date: ${actDate}`);
  lines.push(`# Sport: ${sport}`);

  if (session) {
    if (session.total_distance != null) lines.push(`# Total Distance (m): ${session.total_distance}`);
    if (session.total_timer_time != null) lines.push(`# Total Duration (s): ${session.total_timer_time}`);
    if (session.total_elapsed_time != null) lines.push(`# Total Elapsed Time (s): ${session.total_elapsed_time}`);
    if (session.avg_heart_rate != null) lines.push(`# Avg Heart Rate (bpm): ${session.avg_heart_rate}`);
    if (session.max_heart_rate != null) lines.push(`# Max Heart Rate (bpm): ${session.max_heart_rate}`);
    if (session.avg_cadence != null) lines.push(`# Avg Cadence (spm): ${session.avg_cadence * 2}`);
    if (session.max_cadence != null) lines.push(`# Max Cadence (spm): ${session.max_cadence * 2}`);
    if (session.avg_speed != null) lines.push(`# Avg Speed (m/s): ${session.avg_speed}`);
    if (session.max_speed != null) lines.push(`# Max Speed (m/s): ${session.max_speed}`);
    if (session.total_calories != null) lines.push(`# Calories: ${session.total_calories}`);
    if (session.total_ascent != null) lines.push(`# Total Ascent (m): ${session.total_ascent}`);
    if (session.total_descent != null) lines.push(`# Total Descent (m): ${session.total_descent}`);
    if (session.avg_power != null) lines.push(`# Avg Power (W): ${session.avg_power}`);
    if (session.avg_vertical_oscillation != null) lines.push(`# Avg Vertical Oscillation (cm): ${session.avg_vertical_oscillation}`);
    if (session.avg_stance_time != null) lines.push(`# Avg Ground Contact Time (ms): ${session.avg_stance_time}`);
    if (session.avg_step_length != null) lines.push(`# Avg Step Length (m): ${session.avg_step_length}`);
  } else if (activityMeta) {
    // Fallback to activity metadata if session parsing didn't work
    if (activityMeta.distance != null) lines.push(`# Total Distance (m): ${Math.round(activityMeta.distance * 100) / 100}`);
    if (activityMeta.duration != null) lines.push(`# Total Duration (s): ${Math.round(activityMeta.duration)}`);
    if (activityMeta.averageHR != null) lines.push(`# Avg Heart Rate (bpm): ${activityMeta.averageHR}`);
    if (activityMeta.maxHR != null) lines.push(`# Max HR Rate (bpm): ${activityMeta.maxHR}`);
    if (activityMeta.averageSpeed != null) lines.push(`# Avg Speed (m/s): ${Math.round(activityMeta.averageSpeed * 1000) / 1000}`);
    if (activityMeta.calories != null) lines.push(`# Calories: ${activityMeta.calories}`);
    if (activityMeta.elevationGain != null) lines.push(`# Elevation Gain (m): ${activityMeta.elevationGain}`);
  }

  lines.push('#');

  if (records.length === 0) {
    lines.push('# WARNING: No record data found in FIT file');
    return lines.join('\n');
  }

  // ---- Determine columns from actual data ----
  const DESIRED_COLUMNS = [
    'timestamp', 'heart_rate', 'cadence', 'speed', 'enhanced_speed',
    'distance', 'altitude', 'enhanced_altitude', 'position_lat', 'position_long',
    'temperature', 'power', 'vertical_oscillation', 'stance_time',
    'stance_time_percent', 'step_length', 'vertical_ratio', 'core_temperature'
  ];

  // Only include columns that have at least one non-null value
  const presentColumns = DESIRED_COLUMNS.filter(col =>
    records.some(r => r[col] != null)
  );

  // CSV header row
  lines.push(presentColumns.join(','));

  // ---- Data rows ----
  for (const rec of records) {
    const row = presentColumns.map(col => {
      const val = rec[col];
      if (val == null) return '';
      // Cadence is stored as half-cycles in FIT — double it for steps/min in running
      if (col === 'cadence') return val * 2;
      return val;
    });
    lines.push(row.join(','));
  }

  return lines.join('\n');
}

/**
 * Get MMDD format for a date string.
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
  const { records, session } = FIT.parse(fitBuffer);
  console.log('[GFE] Step 4: Building CSV...', records.length, 'records');

  // Step 4: Convert to CSV
  const csv = toCSV(records, session, activity);
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

