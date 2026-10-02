/**
 * Lightweight FIT file parser for Chrome extension service worker.
 * Parses the binary FIT protocol to extract record and session messages.
 * 
 * Reference: https://developer.garmin.com/fit/protocol/
 * 
 * The FIT format uses:
 *  - A 14-byte file header
 *  - Definition messages (describe field layout)
 *  - Data messages (contain actual values)
 *  - A 2-byte CRC footer
 */

self.FIT = (() => {
  // Garmin epoch: Dec 31, 1989 00:00:00 UTC
  const GARMIN_EPOCH = Date.UTC(1989, 11, 31, 0, 0, 0) / 1000;

  // Global message numbers we care about
  const MESG_NUM = {
    FILE_ID: 0,
    SESSION: 18,
    LAP: 19,
    RECORD: 20,
    EVENT: 21,
    DEVICE_INFO: 23,
    ACTIVITY: 34,
    SPORT: 12,
  };

  // Field definitions for RECORD messages (Global Message Number 20)
  const RECORD_FIELDS = {
    253: 'timestamp',
    0: 'position_lat',
    1: 'position_long',
    2: 'altitude',         // with scale 5, offset 500
    3: 'heart_rate',
    4: 'cadence',
    5: 'distance',         // with scale 100
    6: 'speed',            // with scale 1000
    7: 'power',
    13: 'temperature',
    39: 'vertical_oscillation',  // scale 10
    40: 'stance_time_percent',   // scale 100
    41: 'stance_time',           // scale 10
    78: 'enhanced_speed',        // scale 1000
    73: 'enhanced_altitude',     // scale 5, offset 500
    87: 'vertical_ratio',        // scale 100
    88: 'stance_time_balance',   // scale 100
    89: 'step_length',           // scale 10
    114: 'core_temperature',     // scale 100
  };

  // Field definitions for SESSION messages (Global Message Number 18)
  const SESSION_FIELDS = {
    253: 'timestamp',
    2: 'start_time',
    7: 'total_elapsed_time',   // scale 1000
    8: 'total_timer_time',     // scale 1000
    9: 'total_distance',       // scale 100
    11: 'total_calories',
    14: 'avg_speed',           // scale 1000
    15: 'max_speed',           // scale 1000
    16: 'avg_heart_rate',
    17: 'max_heart_rate',
    18: 'avg_cadence',
    19: 'max_cadence',
    20: 'avg_power',
    21: 'max_power',
    22: 'total_ascent',
    23: 'total_descent',
    5: 'sport',
    6: 'sub_sport',
    25: 'first_lap_index',
    26: 'num_laps',
    28: 'event',
    29: 'event_type',
    34: 'sport_profile_name',
    44: 'avg_vertical_oscillation',  // scale 10
    45: 'avg_stance_time_percent',   // scale 100
    46: 'avg_stance_time',           // scale 10
    110: 'sport_profile_name',
    168: 'avg_step_length',          // scale 10
    181: 'total_training_effect',
    182: 'total_anaerobic_training_effect',
  };

  // Scaling factors for specific fields
  const FIELD_SCALES = {
    altitude: { scale: 5, offset: 500 },
    enhanced_altitude: { scale: 5, offset: 500 },
    distance: { scale: 100 },
    total_distance: { scale: 100 },
    speed: { scale: 1000 },
    enhanced_speed: { scale: 1000 },
    avg_speed: { scale: 1000 },
    max_speed: { scale: 1000 },
    vertical_oscillation: { scale: 10 },
    avg_vertical_oscillation: { scale: 10 },
    stance_time: { scale: 10 },
    avg_stance_time: { scale: 10 },
    stance_time_percent: { scale: 100 },
    avg_stance_time_percent: { scale: 100 },
    vertical_ratio: { scale: 100 },
    stance_time_balance: { scale: 100 },
    step_length: { scale: 10 },
    avg_step_length: { scale: 10 },
    total_elapsed_time: { scale: 1000 },
    total_timer_time: { scale: 1000 },
    core_temperature: { scale: 100 },
  };

  // Base type sizes
  const BASE_TYPE_SIZES = {
    0x00: 1,  // enum
    0x01: 1,  // sint8
    0x02: 1,  // uint8
    0x83: 2,  // sint16
    0x84: 2,  // uint16
    0x85: 4,  // sint32
    0x86: 4,  // uint32
    0x07: 1,  // string
    0x88: 4,  // float32
    0x89: 8,  // float64
    0x0A: 1,  // uint8z
    0x8B: 2,  // uint16z
    0x8C: 4,  // uint32z
    0x0D: 1,  // byte
    0x8E: 8,  // sint64
    0x8F: 8,  // uint64
    0x90: 8,  // uint64z
  };

  // Invalid values per base type (sentinel values meaning "no data")
  const INVALID_VALUES = {
    0x00: 0xFF,
    0x01: 0x7F,
    0x02: 0xFF,
    0x83: 0x7FFF,
    0x84: 0xFFFF,
    0x85: 0x7FFFFFFF,
    0x86: 0xFFFFFFFF,
    0x07: null,
    0x88: null,
    0x89: null,
    0x0A: 0x00,
    0x8B: 0x0000,
    0x8C: 0x00000000,
    0x0D: 0xFF,
    0x8E: null,
    0x8F: null,
    0x90: null,
  };

  function readField(view, offset, baseType, size) {
    try {
      switch (baseType & 0x1F) {  // Mask to get base type number
        case 0x00: // enum
        case 0x02: // uint8
        case 0x0A: // uint8z
        case 0x0D: // byte
          return view.getUint8(offset);
        case 0x01: // sint8
          return view.getInt8(offset);
        case 0x03: // sint16
          return view.getInt16(offset, true);
        case 0x04: // uint16
        case 0x0B: // uint16z
          return view.getUint16(offset, true);
        case 0x05: // sint32
          return view.getInt32(offset, true);
        case 0x06: // uint32
        case 0x0C: // uint32z
          return view.getUint32(offset, true);
        case 0x07: // string
          const bytes = new Uint8Array(view.buffer, offset, size);
          const nullIdx = bytes.indexOf(0);
          return new TextDecoder().decode(bytes.slice(0, nullIdx >= 0 ? nullIdx : size));
        case 0x08: // float32
          return view.getFloat32(offset, true);
        case 0x09: // float64
          return view.getFloat64(offset, true);
        default:
          return view.getUint8(offset);
      }
    } catch (e) {
      return null;
    }
  }

  function isInvalid(value, baseType) {
    const key = baseType & 0x1F;
    // Handle by checking known invalid sentinel values
    if (key === 0x00 || key === 0x02 || key === 0x0D) return value === 0xFF;
    if (key === 0x01) return value === 0x7F;
    if (key === 0x03) return value === 0x7FFF;
    if (key === 0x04) return value === 0xFFFF;
    if (key === 0x05) return value === 0x7FFFFFFF;
    if (key === 0x06 || key === 0x0C) return value === 0xFFFFFFFF;
    if (key === 0x0A) return value === 0;
    if (key === 0x0B) return value === 0;
    return false;
  }

  function applyScale(fieldName, rawValue) {
    const s = FIELD_SCALES[fieldName];
    if (!s) return rawValue;
    let val = rawValue / s.scale;
    if (s.offset) val -= s.offset;
    return Math.round(val * 10000) / 10000; // Avoid floating-point noise
  }

  function convertTimestamp(garminTs) {
    return new Date((garminTs + GARMIN_EPOCH) * 1000).toISOString();
  }

  function convertSemicircles(semi) {
    return Math.round((semi * (180 / Math.pow(2, 31))) * 1000000) / 1000000;
  }

  /**
   * Parse a FIT file from an ArrayBuffer.
   * @param {ArrayBuffer} buffer
   * @returns {{ records: Object[], session: Object|null }}
   */
  function parse(buffer) {
    const data = new Uint8Array(buffer);
    const view = new DataView(buffer);

    // ---- File Header ----
    const headerSize = data[0];
    const protocolVersion = data[1];
    const profileVersion = view.getUint16(2, true);
    const dataSize = view.getUint32(4, true);
    const dataSig = String.fromCharCode(data[8], data[9], data[10], data[11]);

    if (dataSig !== '.FIT') {
      throw new Error('Not a valid FIT file (signature mismatch)');
    }

    // ---- Parse Messages ----
    const definitions = {};   // local message type -> definition
    const records = [];
    let session = null;
    let offset = headerSize;
    const end = headerSize + dataSize;
    let lastTimestamp = 0;
    let timeOffset = 0;

    console.log('[GFE] FIT parsing started. Data size:', dataSize, 'bytes');
    let loopCount = 0;
    const MAX_LOOPS = 500000; // Safety valve

    while (offset < end) {
      if (++loopCount > MAX_LOOPS) {
        console.error('[GFE] FIT parser safety limit reached at offset', offset, '/', end);
        break;
      }
      const recordHeader = data[offset++];

      // Compressed timestamp header
      if (recordHeader & 0x80) {
        const localMesgType = (recordHeader >> 5) & 0x3;
        const tsOffset = recordHeader & 0x1F;

        // Apply compressed timestamp
        lastTimestamp = (lastTimestamp & 0xFFFFFFE0) + tsOffset;
        if (tsOffset < (lastTimestamp & 0x1F)) {
          lastTimestamp += 0x20;
        }

        const def = definitions[localMesgType];
        if (!def) {
          // No definition for this compressed-timestamp message — skip safely
          // We can't know the size, so just skip this byte and hope for the best
          continue;
        }
        // Advance offset for the data message
        // (offset is advanced AFTER readDataMessage below)

        // Read data message with compressed timestamp
        const msg = readDataMessage(view, offset, def, lastTimestamp);
        offset += def.totalSize;

        if (def.globalMesgNum === MESG_NUM.RECORD) {
          records.push(msg);
        } else if (def.globalMesgNum === MESG_NUM.SESSION) {
          session = msg;
        }
        continue;
      }

      const isDefinition = (recordHeader & 0x40) !== 0;
      const localMesgType = recordHeader & 0x0F;

      if (isDefinition) {
        // Definition message
        const reserved = data[offset++];
        const arch = data[offset++]; // 0 = little endian, 1 = big endian
        const globalMesgNum = view.getUint16(offset, true); offset += 2;
        const numFields = data[offset++];
        const fields = [];
        let totalSize = 0;

        for (let i = 0; i < numFields; i++) {
          const fieldDefNum = data[offset++];
          const size = data[offset++];
          const baseType = data[offset++];
          fields.push({ fieldDefNum, size, baseType });
          totalSize += size;
        }

        // Check for developer fields (bit 5 of record header)
        let devFields = [];
        if (recordHeader & 0x20) {
          const numDevFields = data[offset++];
          for (let i = 0; i < numDevFields; i++) {
            const fieldNum = data[offset++];
            const size = data[offset++];
            const devDataIdx = data[offset++];
            devFields.push({ fieldNum, size, devDataIdx });
            totalSize += size;
          }
        }

        definitions[localMesgType] = { globalMesgNum, fields, devFields, totalSize, arch };
      } else {
        // Data message
        const def = definitions[localMesgType];
        if (!def) {
          // Can't process without definition — we don't know the size
          // Try to find next valid record header by scanning forward
          console.warn('[GFE] Unknown local message type', localMesgType, 'at offset', offset);
          continue;
        }

        const msg = readDataMessage(view, offset, def, null);
        offset += def.totalSize;

        // Track timestamp for compressed headers
        if (msg.timestamp) {
          // Convert ISO back to garmin ts for tracking
          const d = new Date(msg.timestamp);
          lastTimestamp = Math.floor(d.getTime() / 1000) - GARMIN_EPOCH;
        }

        if (def.globalMesgNum === MESG_NUM.RECORD) {
          records.push(msg);
        } else if (def.globalMesgNum === MESG_NUM.SESSION) {
          session = msg;
        }
      }
    }

    console.log('[GFE] FIT parsing complete. Records:', records.length, 'Session:', !!session);
    return { records, session };
  }

  function readDataMessage(view, offset, def, compressedTimestamp) {
    const fieldMap = def.globalMesgNum === MESG_NUM.RECORD ? RECORD_FIELDS :
                     def.globalMesgNum === MESG_NUM.SESSION ? SESSION_FIELDS : null;

    const msg = {};
    let fieldOffset = offset;

    for (const field of def.fields) {
      if (fieldMap && fieldMap[field.fieldDefNum]) {
        const fieldName = fieldMap[field.fieldDefNum];
        const rawValue = readField(view, fieldOffset, field.baseType, field.size);

        if (rawValue !== null && !isInvalid(rawValue, field.baseType)) {
          if (fieldName === 'timestamp' || fieldName === 'start_time') {
            msg[fieldName] = convertTimestamp(rawValue);
          } else if (fieldName === 'position_lat' || fieldName === 'position_long') {
            msg[fieldName] = convertSemicircles(rawValue);
          } else {
            msg[fieldName] = applyScale(fieldName, rawValue);
          }
        }
      }
      fieldOffset += field.size;
    }

    // Apply compressed timestamp if provided
    if (compressedTimestamp !== null && !msg.timestamp) {
      msg.timestamp = convertTimestamp(compressedTimestamp);
    }

    return msg;
  }

  return { parse };
})();
