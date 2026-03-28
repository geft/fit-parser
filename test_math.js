const fs = require('fs');
const assert = require('assert');

// Load page-fetch.js but expose the hidden internal functions for testing
let pageFetchCode = fs.readFileSync('page-fetch.js', 'utf8');

// We intercept the FIT closure to expose internal functions
pageFetchCode = pageFetchCode.replace(
  'return { parse };',
  'return { parse, isInvalid, applyScale, convertTimestamp, convertSemicircles };'
);

// Only keep the FIT closure code
const fitStart = pageFetchCode.indexOf('const FIT = (() => {');
const fitEnd = pageFetchCode.indexOf('})();', fitStart) + 5;
const fitClosureCode = pageFetchCode.substring(fitStart, fitEnd).replace('const FIT =', 'global.FIT =');

// Extremely hacky but effective 0-dependency way to load the module
eval(fitClosureCode);

console.log('--- Running FIT Parser Math Unit Tests ---\n');

// 1. Math: Garmin Epoch Timestamp Conversion
const testGarminTs = 1111111111; // Some timestamp since 1989
const expectedDate = new Date((testGarminTs + 631065600) * 1000).toISOString();
assert.strictEqual(FIT.convertTimestamp(testGarminTs), expectedDate, "Epoch conversion failed");
console.log('✅ Timestamp Epoch (+631065600)');

// 2. Math: Semicircles to Degrees
// 180 / 2^31 is roughly 0.000000083819
const testSemicircles = 504543210;
const expectedDegrees = Math.round((testSemicircles * (180 / Math.pow(2, 31))) * 1000000) / 1000000;
assert.strictEqual(FIT.convertSemicircles(testSemicircles), expectedDegrees, "Semicircles scale failed");
console.log('✅ Semicircle Coordinates Scale (180 / 2^31)');

// 3. Math: Scale and Offset application
assert.strictEqual(FIT.applyScale('distance', 50000), 500, "Distance scale failed");
assert.strictEqual(FIT.applyScale('enhanced_speed', 3500), 3.5, "Speed scale failed");
assert.strictEqual(FIT.applyScale('altitude', 2600), 20, "Altitude scale/offset failed (2600 / 5) - 500 = 20");
console.log('✅ Field Specific Divisions and Offsets');

// 4. Invalid Value Bitmasking (the bug that caused this!)
// Old bug: baseType & 0x9F didn't mask out the 8th bit correctly.
// New fix: baseType & 0x1F works perfectly.
assert.strictEqual(FIT.isInvalid(0xFF, 0x02), true, "uint8 0xFF should be invalid");
assert.strictEqual(FIT.isInvalid(0x7F, 0x01), true, "sint8 0x7F should be invalid");

// The exact values that were slipping through:
assert.strictEqual(FIT.isInvalid(0xFFFF, 0x84), true, "uint16 0xFFFF should be invalid (Masking test)");
assert.strictEqual(FIT.isInvalid(0x7FFF, 0x83), true, "sint16 0x7FFF should be invalid");
assert.strictEqual(FIT.isInvalid(0xFFFFFFFF, 0x86), true, "uint32 0xFFFFFFFF should be invalid");
assert.strictEqual(FIT.isInvalid(0x0000, 0x8B), true, "uint16z 0x0000 should be invalid");

// Valid values should NOT be marked invalid
assert.strictEqual(FIT.isInvalid(12345, 0x84), false, "12345 is valid uint16");
assert.strictEqual(FIT.isInvalid(0, 0x84), false, "0 is valid uint16");

console.log('✅ Invalid Value 16-bit / 32-bit Bitmasking (The 0xFFFF bug)');

console.log('\nAll 11 Math and Bitwise tests passed successfully!');
