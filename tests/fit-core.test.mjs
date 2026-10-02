import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { zipSync } from 'fflate';
import { parseFit, prepareFitExport, toCSV, extractFit } from '../lib/fit-core.mjs';
import { fitFile, message, richFit, START } from './fit-fixture.mjs';

test('published field IDs, units, cadence fractions, developer overrides and all message types', () => {
  const parsed = parseFit(richFit());
  assert.equal(parsed.records[0].speed, 3);
  assert.equal(parsed.records[0].altitude, 20);
  assert.equal(parsed.records[0].stance_time, 245);
  assert.equal(parsed.records[0].vertical_ratio, 7.5);
  assert.equal(parsed.records[0].stance_time_balance, 50.2);
  assert.equal(parsed.records[0].step_length, 1100);
  assert.equal(parsed.records[0].core_temperature, 38.1);
  assert.equal(parsed.records[0].power, 300);
  assert.equal(parsed.records[0].power_source, 'developer:0:0');
  assert.equal(parsed.records[1].power_source, 'native');
  assert.equal(parsed.session.total_training_effect, 3.2);
  assert.equal(parsed.session.total_anaerobic_training_effect, 1.2);
  assert.equal(parsed.session.avg_step_length, 1100);
  assert.equal(parsed.laps.length, 1);
  assert.equal(parsed.events.length, 4);
  assert.equal(parsed.workoutSteps.length, 1);
  assert.equal(parsed.devices[0].product_name, 'Test watch');
  assert.deepEqual(parsed.hrv[0].time, [0.8, 0.81, 0.79]);
  assert.equal(parsed.hrv[0].preceding_timestamp, parsed.records[0].timestamp);
  assert.equal(parsed.records[0]['249'], 42);
  const output = prepareFitExport(parsed);
  assert.equal(output.records[0].step_length, 1.1);
  assert.equal(output.records[0].cadence, 170.5);
  assert.equal(output.metadata.units.vertical_oscillation, 'mm');
  const csv = toCSV(parsed);
  assert.match(csv, /# Avg Vertical Oscillation \(cm\): 8.2/);
  assert.match(csv, /# Avg Step Length \(m\): 1.1/);
  assert.match(csv, /developer_fields/);
  assert.match(csv, /""0"":300/);
});

test('single-activity ZIP equals FIT; rejects bad ZIP, oversized entries, multiple FITs and missing FIT', () => {
  const fit = richFit();
  const zip = zipSync({ 'nested/activity.FIT': fit, 'readme.txt': new Uint8Array([65]) });
  assert.deepEqual(extractFit(zip), new Uint8Array(fit));
  assert.equal(toCSV(parseFit(zip)), toCSV(parseFit(fit)));
  assert.throws(() => parseFit(zipSync({ 'readme.txt': new Uint8Array([65]) })), /exactly one FIT/);
  assert.throws(() => parseFit(zipSync({ 'a.fit': fit, 'b.fit': fit })), /exactly one FIT/);
  assert.throws(() => parseFit(new Uint8Array([80, 75, 3, 4])), /Invalid Garmin ZIP/);
  const oversized = Buffer.from(zip);
  const central = oversized.indexOf(Buffer.from([80, 75, 1, 2]));
  oversized.writeUInt32LE(70 * 1024 * 1024, central + 24);
  assert.throws(() => extractFit(oversized), /size limit/);
});

test('compressed timestamp wraps correctly and handles developer payload alignment', () => {
  const timestamp = Math.floor(START / 32) * 32 + 30;
  const initial = message(20, [[3, 2, 140], [253, 0x86, timestamp], [73, 0x86, 3000]],
    { local: 1, developer: [{ id: 0, index: 0, bytes: Buffer.from([184, 11]) }] });
  const file = fitFile([
    message(207, [[3, 2, 0]]),
    message(206, [[0, 2, 0], [1, 2, 0], [2, 2, 0x84], [3, 7, 'Power'], [6, 2, 10], [14, 0x84, 20], [15, 2, 7]]),
    initial, Buffer.from([0xa1, 150, 184, 11, 0, 0, 28, 12]),
    message(18, [[2, 0x86, timestamp], [5, 0, 1], [7, 0x86, 3000]]),
  ]);
  const parsed = parseFit(file);
  assert.equal(Date.parse(parsed.records[1].timestamp) - Date.parse(parsed.records[0].timestamp), 3000);
  assert.equal(parsed.records[1].heart_rate, 150);
  assert.equal(parsed.records[1].power, 310);
  assert.equal(parsed.records[1].speed, 3);
  assert.equal(parsed.session.sport, 'running');
});

test('big endian fields, invalid sentinel values, checksum and truncation', () => {
  const file = fitFile([message(20, [[253, 0x86, START], [73, 0x86, 3500], [3, 2, 255], [41, 0x84, 65535]], { bigEndian: true })]);
  const parsed = parseFit(file);
  assert.equal(parsed.records[0].speed, 3.5);
  assert.equal(parsed.records[0].heart_rate, undefined);
  assert.equal(parsed.records[0].stance_time, undefined);
  const corrupted = Buffer.from(file); corrupted[corrupted.length - 1] ^= 1;
  assert.throws(() => parseFit(corrupted), /checksum/);
  assert.throws(() => parseFit(file.subarray(0, file.length - 1)), /length/);
});

test('service-worker and page bundles produce exactly the canonical CSV', () => {
  const context = { self: {}, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, DataView, console };
  vm.runInNewContext(fs.readFileSync('lib/fit-parser.js', 'utf8'), context);
  const input = richFit();
  assert.equal(context.self.FIT.toCSV(context.self.FIT.parse(input)), toCSV(parseFit(input)));
  const page = fs.readFileSync('page-fetch.js', 'utf8');
  assert.ok(page.includes(fs.readFileSync('lib/fit-parser.js', 'utf8')));
  assert.ok(page.includes('FIT.toCSV(parsed, event.data.activity)'));
});
