// Canonical FIT decoding/export core. AEROLAB vendors this file byte-for-byte.
// Garmin owns the profile, units, invalid sentinels, and developer-field decoding.
import { CrcCalculator, Decoder, Profile, Stream } from '@garmin/fitsdk';
import { unzipSync } from 'fflate';

export const FIT_EXPORT_VERSION = 2;
const EPOCH = Date.UTC(1989, 11, 31) / 1000;
const snake = key => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const date = value => new Date((value + EPOCH) * 1000).toISOString();
const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = value => Math.round(value * 1e6) / 1e6;

export function isFitBuffer(input) {
  const bytes = bytesOf(input);
  return bytes.length >= 12 && bytes[8] === 46 && bytes[9] === 70 && bytes[10] === 73 && bytes[11] === 84;
}

export function isZipBuffer(input) {
  const bytes = bytesOf(input);
  return bytes.length >= 4 && bytes[0] === 80 && bytes[1] === 75 && bytes[2] === 3 && bytes[3] === 4;
}

/** Garmin's single-activity ZIP, extracted only in memory (no filesystem paths). */
export function extractFit(input) {
  const bytes = bytesOf(input);
  if (!isZipBuffer(bytes)) return bytes;
  const limit = 64 * 1024 * 1024;
  if (bytes.length > limit) throw new Error('Garmin ZIP exceeds the 64 MB activity limit');
  let entries = 0;
  let expandedSize = 0;
  let files;
  try {
    files = unzipSync(bytes, { filter(entry) {
      entries++;
      expandedSize += entry.originalSize;
      if (entries > 256 || expandedSize > limit) throw new Error('Garmin ZIP exceeds the activity size limit');
      return /\.fit$/i.test(entry.name);
    } });
  } catch (error) {
    throw new Error(`Invalid Garmin ZIP: ${error.message}`);
  }
  const fits = Object.values(files);
  if (fits.length !== 1) throw new Error('Garmin ZIP must contain exactly one FIT activity');
  return fits[0];
}

function bytesOf(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('FIT input must be an ArrayBuffer or typed array');
}

// The JS SDK does not yet support compressed timestamps. Expand only the framing
// before handing decoding to it, including developer payload sizes and endian order.
// CRC validation happens on the original file before this adapter is used.
function expandTimestamps(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = bytes[0];
  const end = headerSize + view.getUint32(4, true);
  let offset = headerSize;
  let lastTimestamp;
  let changed = false;
  const definitions = new Map();
  const chunks = [];
  const requireBytes = size => {
    if (offset + size > end) throw new Error('Truncated FIT message');
  };
  while (offset < end) {
    const start = offset;
    const header = bytes[offset++];
    const compressed = (header & 0x80) !== 0;
    const local = compressed ? (header >> 5) & 3 : header & 15;
    if (!compressed && (header & 0x40)) {
      requireBytes(5);
      const little = bytes[offset + 1] === 0;
      const count = bytes[offset + 4];
      offset += 5;
      let size = 0;
      let timestampOffset = -1;
      requireBytes(count * 3);
      for (let index = 0; index < count; index++) {
        const field = bytes[offset];
        const fieldSize = bytes[offset + 1];
        if (field === 253 && fieldSize === 4) timestampOffset = size;
        size += fieldSize;
        offset += 3;
      }
      if (header & 0x20) {
        requireBytes(1);
        const countDev = bytes[offset++];
        requireBytes(countDev * 3);
        for (let index = 0; index < countDev; index++) {
          size += bytes[offset + 1];
          offset += 3;
        }
      }
      definitions.set(local, { size, timestampOffset, little });
      chunks.push(bytes.slice(start, offset));
      continue;
    }
    const definition = definitions.get(local);
    if (!definition) throw new Error('FIT data message has no definition');
    const { size, timestampOffset, little } = definition;
    if (compressed) {
      if (lastTimestamp === undefined || timestampOffset < 0) throw new Error('Invalid compressed FIT timestamp');
      requireBytes(size - 4);
      const low = header & 31;
      const previousLow = lastTimestamp & 31;
      lastTimestamp = Math.floor(lastTimestamp / 32) * 32 + low + (low < previousLow ? 32 : 0);
      const expanded = new Uint8Array(size + 1);
      expanded[0] = local;
      expanded.set(bytes.subarray(offset, offset + timestampOffset), 1);
      new DataView(expanded.buffer).setUint32(1 + timestampOffset, lastTimestamp, little);
      expanded.set(bytes.subarray(offset + timestampOffset, offset + size - 4), 5 + timestampOffset);
      chunks.push(expanded);
      offset += size - 4;
      changed = true;
    } else {
      requireBytes(size);
      if (timestampOffset >= 0) lastTimestamp = view.getUint32(offset + timestampOffset, little);
      offset += size;
      chunks.push(bytes.slice(start, offset));
    }
  }
  if (!changed) return bytes;
  const dataSize = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(headerSize + dataSize + 2);
  result.set(bytes.subarray(0, headerSize));
  const output = new DataView(result.buffer);
  output.setUint32(4, dataSize, true);
  if (headerSize === 14) output.setUint16(12, CrcCalculator.calculateCRC(result, 0, 12), true);
  let cursor = headerSize;
  for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.length; }
  output.setUint16(cursor, CrcCalculator.calculateCRC(result, 0, cursor), true);
  return result;
}

function normalize(message, messageNumber) {
  const fields = Profile.messages[messageNumber]?.fields ?? {};
  const fieldByName = new Map(Object.values(fields).map(field => [field.name, field]));
  const result = {};
  for (const [key, value] of Object.entries(message)) {
    if (value === null || value === undefined) continue;
    const field = fieldByName.get(key);
    let normalized = value;
    if (finite(value) && field?.type === 'dateTime') normalized = date(value);
    if (finite(value) && key.startsWith('position')) normalized = round(value * 180 / 2 ** 31);
    result[snake(key)] = normalized;
  }
  return result;
}

export function parseFit(input) {
  const original = extractFit(input);
  if (!isFitBuffer(original)) throw new Error('Not a valid FIT file (signature mismatch)');
  if (![12, 14].includes(original[0]) || original.length < original[0] + 2) throw new Error('Invalid FIT file length');
  const view = new DataView(original.buffer, original.byteOffset, original.byteLength);
  if (view.getUint32(4, true) !== original.length - original[0] - 2) throw new Error('Invalid FIT file length');
  const originalDecoder = new Decoder(Stream.fromByteArray(original));
  if (!originalDecoder.checkIntegrity()) throw new Error('FIT checksum mismatch');
  const bytes = expandTimestamps(original);
  const definitions = {};
  const grouped = {};
  let lastTimestamp = null;
  const decoder = new Decoder(Stream.fromByteArray(bytes));
  const { messages: decoded, errors } = decoder.read({
    convertDateTimesToDates: false,
    convertTypesToStrings: true,
    includeUnknownData: true,
    mesgListener(number, message) {
      const name = snake(Profile.messages[number]?.name ?? `unknown_${number}`);
      const normalized = normalize(message, number);
      if (normalized.developer_fields) {
        normalized.developer_raw_fields = { ...normalized.developer_fields };
        normalized.developer_fields = Object.fromEntries(Object.entries(normalized.developer_fields).map(([key, value]) => {
          const definition = definitions[key];
          const scale = finite(definition?.scale) && definition.scale > 0 ? definition.scale : 1;
          const offset = finite(definition?.offset) ? definition.offset : 0;
          const convert = item => finite(item) ? round(item / scale - offset) : item;
          return [key, Array.isArray(value) ? value.map(convert) : convert(value)];
        }));
      }
      if (normalized.timestamp) lastTimestamp = normalized.timestamp;
      // HRV arrays have no timestamp: retain their position against the preceding
      // timestamped message rather than pretending each RR value is a record.
      if (name === 'hrv') normalized.preceding_timestamp = lastTimestamp;
      (grouped[name] ??= []).push(normalized);
    },
    fieldDescriptionListener(key, developer, description) {
      definitions[key] = {
        ...normalize(description, 206),
        source: normalize(developer, 207),
      };
    },
  });
  if (errors.length) throw new Error(`FIT decode failed: ${errors.map(error => error.message).join('; ')}`);
  const sessions = grouped.session ?? [];
  const records = grouped.record ?? [];
  // The SDK merges store-and-forward HR after invoking the message listener.
  for (let index = 0; index < records.length; index++) {
    if (finite(decoded.recordMesgs?.[index]?.heartRate)) records[index].heart_rate = decoded.recordMesgs[index].heartRate;
  }
  for (const record of records) {
    record.speed = record.enhanced_speed ?? record.speed;
    record.altitude = record.enhanced_altitude ?? record.altitude;
    for (const [key, value] of Object.entries(record.developer_fields ?? {})) {
      const definition = definitions[key];
      if (definition?.native_mesg_num === 20 && definition.native_field_num === 7 && finite(value) && record.power == null) {
        record.power = value;
        record.power_source = `developer:${definition.developer_data_index}:${definition.field_definition_number}`;
      }
    }
    if (record.power != null && !record.power_source) record.power_source = 'native';
    record.respiration_rate = record.enhanced_respiration_rate ?? record.respiration_rate;
  }
  return {
    records, session: sessions.at(-1) ?? null, sessions,
    laps: grouped.lap ?? [], events: grouped.event ?? [],
    workouts: grouped.workout ?? [], workoutSteps: grouped.workout_step ?? [],
    devices: grouped.device_info ?? [], hrv: grouped.hrv ?? [],
    developerFields: definitions, messages: grouped,
    profileVersion: view.getUint16(2, true), sourceFit: original,
  };
}

function selectSession(parsed, selected) {
  const session = selected ?? parsed.session;
  if (!session || parsed.sessions.length <= 1) return { ...parsed, session };
  const start = Date.parse(session.start_time);
  const end = start + session.total_elapsed_time * 1000;
  const within = message => {
    const time = Date.parse(message.start_time ?? message.timestamp ?? message.preceding_timestamp);
    return time >= start && time <= end;
  };
  return { ...parsed, session, records: parsed.records.filter(within), laps: parsed.laps.filter(within), events: parsed.events.filter(within), hrv: parsed.hrv.filter(within) };
}

const BASE_COLUMNS = [
  'timestamp', 'heart_rate', 'cadence', 'speed', 'distance', 'altitude',
  'position_lat', 'position_long', 'temperature', 'power', 'power_source',
  'vertical_oscillation', 'stance_time', 'stance_time_percent', 'step_length',
  'vertical_ratio', 'stance_time_balance', 'fractional_cadence',
  'respiration_rate', 'core_temperature', 'gps_accuracy',
];
const escapeCsv = value => {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const cleanCopy = value => String(value ?? '').replace(/[\r\n]+/g, ' ');

export function prepareFitExport(parsedInput, activityMeta = {}, options = {}) {
  const parsed = selectSession(parsedInput, options.session);
  const session = parsed.session ?? {};
  const summary = activityMeta.summaryDTO ?? {};
  const activity = parsed.messages.activity?.[0];
  // local_timestamp uses localDateTime (not UTC dateTime) in the profile.
  let utcOffsetSeconds = options.utcOffsetSeconds ?? 8 * 3600;
  if (finite(activity?.local_timestamp) && activity.timestamp) {
    utcOffsetSeconds = activity.local_timestamp - (Date.parse(activity.timestamp) / 1000 - EPOCH);
  }
  const localMeta = activityMeta.startTimeLocal ?? summary.startTimeLocal ?? activityMeta.metadataDTO?.startTimeLocal;
  if (localMeta && session.start_time) {
    const inferred = (Date.parse(String(localMeta).replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(localMeta) ? '' : 'Z')) - Date.parse(session.start_time)) / 1000;
    if (Number.isFinite(inferred) && Math.abs(inferred) <= 14 * 3600) utcOffsetSeconds = inferred;
  }
  const localDate = value => new Date(Date.parse(value) + utcOffsetSeconds * 1000).toISOString().replace('Z', '');
  const name = options.name ?? activityMeta.activityName ?? summary.activityName ?? 'Running';
  const file = parsed.messages.file_id?.[0];
  const id = options.id ?? activityMeta.activityId ?? summary.activityId ??
    (file?.serial_number != null && file?.time_created ? `garmin_${file.serial_number}_${Date.parse(file.time_created) / 1000 - EPOCH}` : '');
  const start = session.start_time ?? parsed.records[0]?.timestamp;
  if (!start) throw new Error('FIT run has no valid start timestamp');
  const metadataFields = {
    'Total Distance (m)': session.total_distance,
    'Total Duration (s)': session.total_timer_time,
    'Total Elapsed Time (s)': session.total_elapsed_time,
    'Avg Heart Rate (bpm)': session.avg_heart_rate, 'Max Heart Rate (bpm)': session.max_heart_rate,
    'Avg Cadence (spm)': finite(session.avg_cadence) ? round((session.avg_cadence + (session.avg_fractional_cadence ?? 0)) * 2) : null,
    'Max Cadence (spm)': finite(session.max_cadence) ? round((session.max_cadence + (session.max_fractional_cadence ?? 0)) * 2) : null,
    'Avg Speed (m/s)': session.enhanced_avg_speed ?? session.avg_speed,
    'Max Speed (m/s)': session.enhanced_max_speed ?? session.max_speed,
    'Calories': session.total_calories, 'Total Ascent (m)': session.total_ascent, 'Total Descent (m)': session.total_descent,
    'Avg Power (W)': session.avg_power, 'Max Power (W)': session.max_power,
    'Avg Vertical Oscillation (cm)': finite(session.avg_vertical_oscillation) ? round(session.avg_vertical_oscillation / 10) : null,
    'Avg Ground Contact Time (ms)': session.avg_stance_time,
    'Avg Step Length (m)': finite(session.avg_step_length) ? round(session.avg_step_length / 1000) : null,
    'Aerobic Training Effect': session.total_training_effect,
    'Anaerobic Training Effect': session.total_anaerobic_training_effect,
  };
  const metadata = {
    version: FIT_EXPORT_VERSION, profileVersion: parsed.profileVersion, utcOffsetSeconds,
    units: { cadence: 'spm', fractional_cadence: 'cycles/min', vertical_oscillation: 'mm', step_length: 'm', stance_time: 'ms' },
    session: parsed.session, sessions: parsed.sessions, laps: parsed.laps, events: parsed.events,
    workouts: parsed.workouts, workoutSteps: parsed.workoutSteps, devices: parsed.devices,
    hrv: parsed.hrv, developerFields: parsed.developerFields,
    otherMessages: Object.fromEntries(Object.entries(parsed.messages).filter(([key]) => !['record', 'session', 'lap', 'event', 'workout', 'workout_step', 'device_info', 'hrv'].includes(key))),
  };
  const records = parsed.records.map(record => {
    const result = { ...record, timestamp: localDate(record.timestamp) };
    if (finite(record.cadence)) result.cadence = round((record.cadence + (record.fractional_cadence ?? 0)) * 2);
    if (finite(record.step_length)) result.step_length = round(record.step_length / 1000);
    return result;
  });
  return { id: String(id), name, date: localDate(start).replace('T', ' ').replace('.000', ''), sport: session.sport ?? 'running', metadataFields, metadata, records, session };
}

export function toCSV(parsed, activityMeta = {}, options = {}) {
  const output = prepareFitExport(parsed, activityMeta, options);
  const lines = [
    '# Garmin Run Export — Parsed for AI Analysis',
    `# FIT Export Version: ${FIT_EXPORT_VERSION}`,
    `# Activity: ${cleanCopy(output.name)}`, `# Activity ID: ${cleanCopy(output.id)}`,
    `# Date: ${output.date}`, `# Sport: ${cleanCopy(output.sport)}`,
  ];
  for (const [key, value] of Object.entries(output.metadataFields)) if (value != null) lines.push(`# ${key}: ${value}`);
  lines.push(`# FIT Metadata: ${JSON.stringify(output.metadata)}`, '#');
  const columns = new Set(BASE_COLUMNS);
  for (const record of output.records) for (const key of Object.keys(record)) columns.add(key);
  const headers = [...columns].filter(key => key === 'timestamp' || output.records.some(record => record[key] != null));
  lines.push(headers.join(','));
  for (const record of output.records) lines.push(headers.map(key => escapeCsv(record[key])).join(','));
  return lines.join('\n');
}

export { parseFit as parse };
