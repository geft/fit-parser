const fs = require('fs');

const unzipSrc = fs.readFileSync('lib/unzip.js', 'utf8').replace(/self\.ZIP\s*=\s*/g, 'const ZIP = ');
const fitParserSrc = fs.readFileSync('lib/fit-parser.js', 'utf8').replace(/self\.FIT\s*=\s*/g, 'const FIT = ');

const csvLogic = `
function toCSV(records, session, activityMeta) {
  const lines = [];
  lines.push('# Garmin Run Export — Parsed for AI Analysis');
  lines.push('# Generated: ' + new Date().toISOString());
  lines.push('#');

  if (activityMeta) {
    if (activityMeta.activityName) lines.push('# Activity: ' + activityMeta.activityName);
    if (activityMeta.activityId) lines.push('# Activity ID: ' + activityMeta.activityId);
    if (activityMeta.startTimeLocal || activityMeta.startTimeGMT) lines.push('# Date: ' + (activityMeta.startTimeLocal || activityMeta.startTimeGMT));
    if (activityMeta.activityType?.typeKey) lines.push('# Sport: ' + activityMeta.activityType.typeKey);
  }

  if (session) {
    if (session.total_distance != null) lines.push('# Total Distance (m): ' + session.total_distance);
    if (session.total_timer_time != null) lines.push('# Total Duration (s): ' + session.total_timer_time);
    if (session.total_elapsed_time != null) lines.push('# Total Elapsed Time (s): ' + session.total_elapsed_time);
    if (session.avg_heart_rate != null) lines.push('# Avg Heart Rate (bpm): ' + session.avg_heart_rate);
    if (session.max_heart_rate != null) lines.push('# Max Heart Rate (bpm): ' + session.max_heart_rate);
    if (session.avg_cadence != null) lines.push('# Avg Cadence (spm): ' + (session.avg_cadence * 2));
    if (session.max_cadence != null) lines.push('# Max Cadence (spm): ' + (session.max_cadence * 2));
    if (session.avg_speed != null) lines.push('# Avg Speed (m/s): ' + session.avg_speed);
    if (session.max_speed != null) lines.push('# Max Speed (m/s): ' + session.max_speed);
    if (session.total_calories != null) lines.push('# Calories: ' + session.total_calories);
    if (session.total_ascent != null) lines.push('# Total Ascent (m): ' + session.total_ascent);
    if (session.total_descent != null) lines.push('# Total Descent (m): ' + session.total_descent);
  } else if (activityMeta) {
    if (activityMeta.distance != null) lines.push('# Total Distance (m): ' + Math.round(activityMeta.distance * 100) / 100);
    if (activityMeta.duration != null) lines.push('# Total Duration (s): ' + Math.round(activityMeta.duration));
    if (activityMeta.averageHR != null) lines.push('# Avg Heart Rate (bpm): ' + activityMeta.averageHR);
    if (activityMeta.maxHR != null) lines.push('# Max Heart Rate (bpm): ' + activityMeta.maxHR);
    if (activityMeta.averageSpeed != null) lines.push('# Avg Speed (m/s): ' + Math.round(activityMeta.averageSpeed * 1000) / 1000);
  }
  lines.push('#');

  if (!records || records.length === 0) {
    lines.push('# WARNING: No record data found in FIT file');
    return lines.join('\\n');
  }

  const DESIRED_COLUMNS = [
    'timestamp', 'heart_rate', 'cadence', 'speed', 'enhanced_speed',
    'distance', 'altitude', 'enhanced_altitude', 'position_lat', 'position_long',
    'temperature', 'power', 'vertical_oscillation', 'stance_time',
    'stance_time_percent', 'step_length', 'vertical_ratio', 'core_temperature'
  ];

  const presentColumns = DESIRED_COLUMNS.filter(col => records.some(r => r[col] != null));
  lines.push(presentColumns.join(','));

  for (const rec of records) {
    const row = presentColumns.map(col => {
      const val = rec[col];
      if (val == null) return '';
      if (col === 'cadence') return val * 2;
      return val;
    });
    lines.push(row.join(','));
  }

  return lines.join('\\n');
}

function extractFitBuffer(buffer) {
  try {
    return ZIP.extractFitFromZip(buffer);
  } catch (e) {
    const header = new Uint8Array(buffer);
    if (header.length > 12) {
      const sig = String.fromCharCode(header[8], header[9], header[10], header[11]);
      if (sig === '.FIT') return buffer;
    }
    throw new Error('Could not extract FIT file: ' + e.message);
  }
}
`;

const pageFetchSrc = fs.readFileSync('page-fetch.js', 'utf8');

const updatedDownloadLogic = `
    if (action === 'downloadFit') {
      try {
        const url = \`/gc-api/download-service/files/activity/\${event.data.activityId}\`;
        const headers = { 'Accept': '*/*' };
        const csrf = getCsrfToken();
        if (csrf) headers['connect-csrf-token'] = csrf;

        const resp = await fetch(url, { credentials: 'same-origin', headers });
        if (!resp.ok) throw new Error(\`Failed to download FIT (HTTP \${resp.status}).\`);
        
        const ct = resp.headers.get('content-type') || '';
        if (ct.includes('text/html')) {
          throw new Error('FIT download failed — got HTML instead of data.');
        }

        const rawBuffer = await resp.arrayBuffer();
        
        // INSTANT PARSING IN PAGE CONTEXT
        console.log('[GFE] Extracting FIT from ZIP...', rawBuffer.byteLength, 'bytes');
        const fitBuffer = extractFitBuffer(rawBuffer);
        
        console.log('[GFE] Parsing FIT file...', fitBuffer.byteLength, 'bytes');
        const { records, session } = FIT.parse(fitBuffer);
        
        console.log('[GFE] Building CSV...', records.length, 'records');
        const csv = toCSV(records, session, event.data.activity);
        
        // Return exactly the CSV text
        window.postMessage({
          source: 'garmin-fit-exporter-response',
          requestId, success: true, csv: csv
        }, '*');
      } catch (err) {
        window.postMessage({
          source: 'garmin-fit-exporter-response',
          requestId, success: false, error: err.message
        }, '*');
      }
    }
`;

// Replace the downloadFit action entirely
let newPageFetch = pageFetchSrc.replace(/if\s*\(\s*action === 'downloadFit'\s*\)\s*\{[\s\S]*?\n\s*\}\n\s*\}\);\s*window\.postMessage/, updatedDownloadLogic + '\n  });\n\n  window.postMessage');

// Inject the unzip, fitParser, and csvLogic right after 'use strict';
newPageFetch = newPageFetch.replace(/(\(\s*function\s*\(\)\s*\{\s*'use strict';\s*)/, "$1\n\n" + unzipSrc + "\n\n" + fitParserSrc + "\n\n" + csvLogic + "\n\n");

fs.writeFileSync('page-fetch-bundled.js', newPageFetch);
console.log('Successfully bundled to page-fetch-bundled.js');
