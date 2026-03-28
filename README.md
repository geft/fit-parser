# Garmin FIT → CSV Exporter

Chrome extension that exports your latest Garmin Connect run as a parsed CSV — optimized for AI analysis.

## Features

- 🏃 One-click export of latest running activity from Garmin Connect
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
- Custom FIT protocol parser (zero-dependency)
- Native `DecompressionStream` ZIP extractor
- Resilient bit-3 Data Descriptor recovery

## Testing

The project includes a mathematically-proven test suite. To run them (requires Node.js):

```bash
# Test math formulas, epochs, and bitwise invalid sentinels
node test_math.js

# Test full binary integration (mocks a real .fit file structure)
node test_integration.js
```

## License

MIT
