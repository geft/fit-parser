# Garmin FIT → CSV Exporter

Chrome extension that exports your Garmin Connect activity (current activity page or latest run) as a parsed CSV — optimized for AI analysis.

## Features

- 🏃 **Smart Activity Export**: Exports the current activity when viewing an activity page (e.g. `connect.garmin.com/app/activity/:id`), or your latest run when on home
- 🏷️ **Smart Filename Categorization**: Automatically categorizes workout filenames (`MMDD vo2max.csv`, `MMDD hill.csv`, `MMDD threshold.csv`, `MMDD long.csv`, etc.) based on activity title
- 📊 Parses binary FIT files directly in the browser (no server needed)  
- 📥 Saves CSV to Downloads folder with session metadata + time-series records
- 🧠 AI-friendly format with `#`-prefixed header comments
- ⚡ Zero dependencies — self-contained FIT parser and ZIP extractor

## Install

1. Clone this repo
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** → select this folder
5. Navigate to [connect.garmin.com](https://connect.garmin.com) and log in
6. Click the **📊 Export Run CSV** button at the bottom-right

## CSV Output

```csv
# Garmin Run Export — Parsed for AI Analysis
# Activity: Morning Run
# Date: 2026-03-28T08:15:00
# Total Distance (m): 10234.5
# Avg Heart Rate (bpm): 152
#
timestamp,heart_rate,cadence,speed,distance,altitude,position_lat,position_long,...
```

## Tech

- Chrome Extension Manifest V3
- Garmin's pinned FIT SDK, bundled for offline browser use
- In-memory single-activity ZIP extraction, including data-descriptor archives
- Canonical `lib/fit-core.mjs` shared byte-for-byte with AEROLAB
- Records include power, running dynamics, respiration/core temperature, and developer fields when recorded
- CSV metadata preserves laps, pauses, workout steps, devices, RR arrays, zones and session metrics

AEROLAB users can import Garmin's original FIT or single-activity ZIP directly without this extension. The **Export Run CSV** button remains available for AI analysis. Exported step length is in metres, vertical oscillation in millimetres, GCT in milliseconds, and cadence in total steps/minute including fractions. Additional messages and units are stored in the `# FIT Metadata:` JSON comment. Session/lap values in that JSON retain Garmin SDK units.

Install build dependencies with `npm ci`, then run `npm run build`. The page script and service-worker bundle are generated from the same core; edit `page-fetch.template.js` for authentication/download behavior rather than editing the generated `page-fetch.js`.

## Testing

Tests use synthetic binary FIT messages with published numeric field IDs, ZIP fixtures, compressed timestamps, byte order, checksums, and browser bundle parity:

```bash
npm test
node bundle.js --check
node scripts/check-parity.mjs C:/path/to/AEROLAB
```

## License

Extension code: MIT. Garmin SDK: [FIT Protocol License](licenses/Garmin-FIT-SDK.txt). ZIP library: [MIT](licenses/fflate.txt).
