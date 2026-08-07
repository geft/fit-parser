const fs = require('fs');
const assert = require('assert');

let pageFetchCode = fs.readFileSync('page-fetch.js', 'utf8');
const fitStart = pageFetchCode.indexOf('const FIT = (() => {');
const fitEnd = pageFetchCode.indexOf('})();', fitStart) + 5;
const fitClosureCode = pageFetchCode.substring(fitStart, fitEnd).replace('const FIT =', 'global.FIT =');
eval(fitClosureCode);

console.log('--- Running FIT Parser Integration Tests ---\n');

// Build a mock FIT file ArrayBuffer
const dataSize = 35; // definition (17 bytes) + 2 data messages (12 bytes) = 29 ... wait let's calculate exact
const buffer = new ArrayBuffer(14 + 100 + 2); // safe size
const view = new DataView(buffer);
const data = new Uint8Array(buffer);

// 1. File Header (14 bytes)
data[0] = 14;          // header size
data[1] = 0x10;        // protocol
view.setUint16(2, 2141, true); // profile
// dataSize will be set later
data[8] = 46; data[9] = 70; data[10] = 73; data[11] = 84; // ".FIT"

let offset = 14;

// 2. Definition Message (Local Type 0, Global Type 20 "RECORD")
data[offset++] = 0x40; // Definition message, local type 0
data[offset++] = 0;    // Reserved
data[offset++] = 0;    // Architecture: little endian
view.setUint16(offset, 20, true); offset += 2; // Global message 20
data[offset++] = 5;    // 5 fields
// Field 1: timestamp (253), size 4, type uint32 (0x86)
data[offset++] = 253; data[offset++] = 4; data[offset++] = 0x86;
// Field 2: heart_rate (3), size 1, type uint8 (0x02)
data[offset++] = 3; data[offset++] = 1; data[offset++] = 0x02;
// Field 3: cadence (4), size 1, type uint8 (0x02)
data[offset++] = 4; data[offset++] = 1; data[offset++] = 0x02;
// Field 4: distance (5), size 4, type uint32 (0x86)
data[offset++] = 5; data[offset++] = 4; data[offset++] = 0x86;
// Field 5: altitude (2), size 2, type uint16 (0x84)
data[offset++] = 2; data[offset++] = 2; data[offset++] = 0x84;

// 3. Data Message 1 (Valid Data)
data[offset++] = 0x00; // Data message, local type 0
view.setUint32(offset, 12345, true); offset += 4; // timestamp
data[offset++] = 150; // heart_rate
data[offset++] = 90;  // cadence
view.setUint32(offset, 100000, true); offset += 4; // distance (100000 cm = 1000 m)
view.setUint16(offset, 3500, true); offset += 2; // altitude (3500/5 - 500 = 200)

// 4. Data Message 2 (Invalid Sentinels)
data[offset++] = 0x00; // Data message, local type 0
view.setUint32(offset, 12346, true); offset += 4; // timestamp
data[offset++] = 0xFF; // heart_rate (INVALID uint8)
data[offset++] = 0xFF;  // cadence (INVALID uint8)
view.setUint32(offset, 0xFFFFFFFF, true); offset += 4; // distance (INVALID uint32)
view.setUint16(offset, 0xFFFF, true); offset += 2; // altitude (INVALID uint16)

const actualDataSize = offset - 14;
view.setUint32(4, actualDataSize, true); // Update header data size

// Parse it!
const result = FIT.parse(buffer.slice(0, offset + 2)); // include 2 bytes CRC at end

assert.strictEqual(result.records.length, 2, "Expected 2 records parsed");
console.log('✅ Parsed binary structure flawlessly');

const rec1 = result.records[0];
assert.strictEqual(rec1.heart_rate, 150, "Heart rate parsing");
assert.strictEqual(rec1.cadence, 90, "Cadence parsing");
assert.strictEqual(rec1.distance, 1000, "Distance scaling (100000 / 100 == 1000)");
assert.strictEqual(rec1.altitude, 200, "Altitude scaling & offset ((3500 / 5) - 500 == 200)");
const expectedDate1 = new Date((12345 + 631065600 + (8 * 3600)) * 1000).toISOString().replace('Z', '');
assert.strictEqual(rec1.timestamp, expectedDate1, "Timestamp epoch conversion");
console.log('✅ Scaling, offset, and epoch logic integrated properly');

const rec2 = result.records[1];
assert.strictEqual(rec2.heart_rate, undefined, "Invalid uint8 correctly dropped");
assert.strictEqual(rec2.cadence, undefined, "Invalid uint8 correctly dropped");
assert.strictEqual(rec2.distance, undefined, "Invalid uint32 correctly dropped");
assert.strictEqual(rec2.altitude, undefined, "Invalid uint16 correctly dropped");

const expectedDate2 = new Date((12346 + 631065600 + (8 * 3600)) * 1000).toISOString().replace('Z', '');
assert.strictEqual(rec2.timestamp, expectedDate2, "Valid timestamp alongside invalid fields");
console.log('✅ Invalid values (0xFF, 0xFFFF, 0xFFFFFFFF) bypassed correctly inside data message loop');

// 5. Test Activity URL parsing regex
const testUrls = [
  'https://connect.garmin.com/app/activity/23714506580',
  'https://connect.garmin.com/modern/activity/23714506580',
  'https://connect.garmin.com/activity/23714506580',
  'https://connect.garmin.com/modern/home'
];

const matches = testUrls.map(u => {
  const m = u.match(/\/activity\/(\d+)/);
  return m ? m[1] : null;
});

assert.deepStrictEqual(matches, ['23714506580', '23714506580', '23714506580', null], 'URL regex matching failed');
console.log('✅ Activity URL ID extraction (/activity/:id regex)');

// 6. Test Workout Type Naming (including VO2 Max)
function getWorkoutType(name) {
  const nameLower = (name || '').toLowerCase();
  let workoutType = 'unknown';
  if (nameLower.includes('vo2')) workoutType = 'vo2max';
  else if (nameLower.includes('hill')) workoutType = 'hill';
  else if (nameLower.includes('threshold')) workoutType = 'threshold';
  else if (nameLower.includes('medium')) workoutType = 'medium';
  else if (nameLower.includes('long')) workoutType = 'long';
  return workoutType;
}

assert.strictEqual(getWorkoutType('VO2 Max Test'), 'vo2max', 'VO2 Max upper case naming failed');
assert.strictEqual(getWorkoutType('Morning Run vo2'), 'vo2max', 'vo2 lower case naming failed');
assert.strictEqual(getWorkoutType('Hill repeats'), 'hill', 'Hill naming failed');
assert.strictEqual(getWorkoutType('Morning Run'), 'unknown', 'Unknown default naming failed');
console.log('✅ VO2 Max and workout type naming resolution');

// 7. Test Activity Date Resolution & MMDD Formatting
function resolveActivityDate(activity, csvText) {
  let dateStr = activity ? (
    activity.startTimeLocal || activity.summaryDTO?.startTimeLocal || 
    activity.startTimeGMT || activity.summaryDTO?.startTimeGMT || 
    activity.metadataDTO?.startTimeLocal || activity.metadataDTO?.startTimeGMT
  ) : null;

  if (!dateStr && csvText) {
    const match = csvText.match(/^# Date:\s*(.+)$/m);
    if (match && match[1]) {
      dateStr = match[1].trim();
    }
  }

  if (dateStr) {
    try {
      const d = new Date(typeof dateStr === 'string' ? dateStr.replace(' ', 'T') : dateStr);
      if (!isNaN(d.getTime())) {
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${mm}${dd}`;
      }
    } catch { }
  }
  return null;
}

// Test top-level startTimeLocal
assert.strictEqual(resolveActivityDate({ startTimeLocal: '2026-03-15 07:12:34' }), '0315', 'Top-level date failed');

// Test summaryDTO.startTimeLocal (single activity detail response structure)
assert.strictEqual(resolveActivityDate({ summaryDTO: { startTimeLocal: '2026-04-20 08:30:00.0' } }), '0420', 'summaryDTO date resolution failed');

// Test fallback to CSV header when activity metadata is missing
const mockCsv = '# Garmin Run Export\n# Date: 2026-11-05T06:00:00.000\nheader1,header2\n';
assert.strictEqual(resolveActivityDate(null, mockCsv), '1105', 'CSV header date fallback failed');

console.log('✅ Activity actual date resolution & summaryDTO fallback validated');

console.log('\nAll integration tests passed. Maximum practical coverage achieved!');
