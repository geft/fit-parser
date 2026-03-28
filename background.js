/**
 * Garmin FIT → CSV Exporter — Background Service Worker
 * 
 * Orchestrates: fetch latest run → download FIT → parse → CSV → download
 */

// Import libraries
importScripts('lib/unzip.js', 'lib/fit-parser.js');

const GARMIN_BASE = 'https://connect.garmin.com';

// Activity types that count as "running"
const RUNNING_TYPES = ['running', 'trail_running', 'treadmill_running', 'track_running'];

/**
 * Fetch the latest running activity metadata from Garmin Connect.
 */
async function fetchLatestRun() {
  // The activitylist-service supports activityType filter
  const url = `${GARMIN_BASE}/modern/proxy/activitylist-service/activities/search/activities?` +
    new URLSearchParams({
      activityType: 'running',
      limit: '5',
      start: '0',
    });

  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) {
    throw new Error(`Failed to fetch activities (HTTP ${resp.status}). Are you logged in to Garmin Connect?`);
  }

  const activities = await resp.json();
  if (!activities || activities.length === 0) {
    throw new Error('No running activities found on your Garmin Connect account.');
  }

  // Find the first activity that matches our running types
  const run = activities.find(a => {
    const type = (a.activityType?.typeKey || '').toLowerCase();
    return RUNNING_TYPES.includes(type);
  }) || activities[0];

  return run;
}

/**
 * Download the original FIT file for a given activity.
 * @param {number} activityId
 * @returns {ArrayBuffer} - The raw FIT file bytes
 */
async function downloadFitFile(activityId) {
  const url = `${GARMIN_BASE}/modern/proxy/download-service/files/activity/${activityId}`;
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) {
    throw new Error(`Failed to download FIT file (HTTP ${resp.status}).`);
  }

  const buffer = await resp.arrayBuffer();

  // The response is a ZIP file — extract the .fit from it
  try {
    return ZIP.extractFitFromZip(buffer);
  } catch (e) {
    // Maybe it's already a raw FIT file (some endpoints return raw)
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

  if (activityMeta) {
    lines.push(`# Activity: ${activityMeta.activityName || 'Unknown'}`);
    lines.push(`# Activity ID: ${activityMeta.activityId || ''}`);
    lines.push(`# Date: ${activityMeta.startTimeLocal || ''}`);
    lines.push(`# Sport: ${activityMeta.activityType?.typeKey || 'running'}`);
  }

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
    if (activityMeta.maxHR != null) lines.push(`# Max Heart Rate (bpm): ${activityMeta.maxHR}`);
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
 * Format a date string for filename use.
 */
function formatDateForFilename(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Main export flow.
 */
async function exportLatestRun() {
  // Step 1: Fetch latest run metadata
  const activity = await fetchLatestRun();
  const activityId = activity.activityId;

  // Step 2: Download the FIT file
  const fitBuffer = await downloadFitFile(activityId);

  // Step 3: Parse FIT → records + session
  const { records, session } = FIT.parse(fitBuffer);

  // Step 4: Convert to CSV
  const csv = toCSV(records, session, activity);

  // Step 5: Create download
  const dateStr = formatDateForFilename(activity.startTimeLocal || activity.startTimeGMT);
  const filename = `garmin_run_${dateStr}.csv`;

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  const downloadId = await chrome.downloads.download({
    url: url,
    filename: filename,
    saveAs: false,
  });

  return {
    success: true,
    filename,
    activityName: activity.activityName || 'Run',
    activityId,
    recordCount: records.length,
    date: dateStr,
  };
}

// ---- Message Listener ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'exportLatestRun') {
    exportLatestRun()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open for async response
  }
});
