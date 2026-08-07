/**
 * Garmin FIT Exporter — Page-level script (MAIN world)
 * 
 * Runs in the page context. Uses the correct /gc-api/ endpoint
 * with connect-csrf-token header for authentication.
 */
(function () {
  'use strict';

  

/**
 * Minimal ZIP extractor for Chrome extension service worker.
 * Only handles Deflate (method 8) and Store (method 0) compressed entries.
 * Extracts the first .fit file found in the archive.
 */

const ZIP = (() => {
  // ---- tiny inflate (RFC 1951) ----
  // Lookup tables built once
  const FIXED_LIT = new Uint8Array(288);
  for (let i = 0; i <= 143; i++) FIXED_LIT[i] = 8;
  for (let i = 144; i <= 255; i++) FIXED_LIT[i] = 9;
  for (let i = 256; i <= 279; i++) FIXED_LIT[i] = 7;
  for (let i = 280; i <= 287; i++) FIXED_LIT[i] = 8;

  const FIXED_DIST = new Uint8Array(32);
  FIXED_DIST.fill(5);

  const LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const LEN_EXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const DIST_EXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  const CL_ORDER  = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

  class BitReader {
    constructor(data) {
      this.data = data;
      this.pos = 0;   // byte position
      this.bit = 0;   // bit position within current byte
    }
    readBits(n) {
      let val = 0;
      for (let i = 0; i < n; i++) {
        val |= ((this.data[this.pos] >> this.bit) & 1) << i;
        this.bit++;
        if (this.bit === 8) { this.bit = 0; this.pos++; }
      }
      return val;
    }
    readByte() {
      if (this.bit !== 0) { this.bit = 0; this.pos++; }
      return this.data[this.pos++];
    }
  }

  function buildTree(lengths) {
    const maxBits = Math.max(...lengths);
    const count = new Uint16Array(maxBits + 1);
    for (const l of lengths) if (l) count[l]++;
    const nextCode = new Uint16Array(maxBits + 1);
    for (let bits = 1; bits <= maxBits; bits++) {
      nextCode[bits] = (nextCode[bits - 1] + count[bits - 1]) << 1;
    }
    // Build simple lookup: { code: { sym, bits } }
    // For efficiency, build an array-based lookup
    const tree = [];
    for (let sym = 0; sym < lengths.length; sym++) {
      const len = lengths[sym];
      if (len === 0) continue;
      let code = nextCode[len]++;
      // Reverse bits for the reader (LSB first)
      let rev = 0;
      for (let i = 0; i < len; i++) rev = (rev << 1) | ((code >> i) & 1);
      tree.push({ sym, bits: len, code: rev });
    }
    // Build fast lookup table (up to 15 bits)
    const table = new Int16Array(1 << Math.min(maxBits, 15)).fill(-1);
    const tableBits = Math.min(maxBits, 15);
    for (const entry of tree) {
      if (entry.bits <= tableBits) {
        const fill = 1 << entry.bits;
        for (let i = entry.code; i < (1 << tableBits); i += fill) {
          table[i] = (entry.sym << 4) | entry.bits;
        }
      }
    }
    return { table, tableBits, entries: tree, maxBits };
  }

  function readSym(br, tree) {
    // Peek bits
    let val = 0;
    const avail = Math.min(tree.tableBits, (br.data.length - br.pos) * 8 - br.bit);
    for (let i = 0; i < avail; i++) {
      val |= ((br.data[br.pos + ((br.bit + i) >> 3)] >> ((br.bit + i) & 7)) & 1) << i;
    }
    const entry = tree.table[val & ((1 << tree.tableBits) - 1)];
    if (entry >= 0) {
      const bits = entry & 0xF;
      const sym = entry >> 4;
      // Advance
      br.bit += bits;
      while (br.bit >= 8) { br.bit -= 8; br.pos++; }
      return sym;
    }
    // Fallback: slow path for codes longer than table
    let code = 0;
    for (let i = 0; i < tree.maxBits; i++) {
      code |= br.readBits(1) << i;
      for (const e of tree.entries) {
        if (e.bits === i + 1 && e.code === (code & ((1 << (i + 1)) - 1))) {
          return e.sym;
        }
      }
    }
    throw new Error('Invalid Huffman code');
  }

  function inflate(compressed) {
    const br = new BitReader(compressed);
    const output = [];
    let done = false;

    while (!done) {
      const bfinal = br.readBits(1);
      const btype = br.readBits(2);

      if (btype === 0) {
        // Stored
        br.bit = 0; if (br.pos % 1 !== 0) br.pos++;
        // Align to byte
        if (br.bit !== 0) { br.bit = 0; br.pos++; }
        const len = br.data[br.pos] | (br.data[br.pos + 1] << 8);
        br.pos += 4; // skip len and nlen
        for (let i = 0; i < len; i++) output.push(br.data[br.pos++]);
      } else {
        let litTree, distTree;
        if (btype === 1) {
          litTree = buildTree(FIXED_LIT);
          distTree = buildTree(FIXED_DIST);
        } else if (btype === 2) {
          const hlit = br.readBits(5) + 257;
          const hdist = br.readBits(5) + 1;
          const hclen = br.readBits(4) + 4;
          const clLengths = new Uint8Array(19);
          for (let i = 0; i < hclen; i++) {
            clLengths[CL_ORDER[i]] = br.readBits(3);
          }
          const clTree = buildTree(clLengths);
          const allLengths = new Uint8Array(hlit + hdist);
          let idx = 0;
          while (idx < hlit + hdist) {
            const sym = readSym(br, clTree);
            if (sym < 16) {
              allLengths[idx++] = sym;
            } else if (sym === 16) {
              const rep = br.readBits(2) + 3;
              const val = allLengths[idx - 1];
              for (let i = 0; i < rep; i++) allLengths[idx++] = val;
            } else if (sym === 17) {
              const rep = br.readBits(3) + 3;
              for (let i = 0; i < rep; i++) allLengths[idx++] = 0;
            } else {
              const rep = br.readBits(7) + 11;
              for (let i = 0; i < rep; i++) allLengths[idx++] = 0;
            }
          }
          litTree = buildTree(allLengths.slice(0, hlit));
          distTree = buildTree(allLengths.slice(hlit));
        } else {
          throw new Error('Invalid block type');
        }

        while (true) {
          const sym = readSym(br, litTree);
          if (sym === 256) break;
          if (sym < 256) {
            output.push(sym);
          } else {
            const lengthIdx = sym - 257;
            const length = LEN_BASE[lengthIdx] + br.readBits(LEN_EXT[lengthIdx]);
            const distSym = readSym(br, distTree);
            const dist = DIST_BASE[distSym] + br.readBits(DIST_EXT[distSym]);
            for (let i = 0; i < length; i++) {
              output.push(output[output.length - dist]);
            }
          }
        }
      }

      if (bfinal) done = true;
    }
    return new Uint8Array(output);
  }

  async function extractFitFromZip(buffer) {
    const data = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let offset = 0;

    console.log('[GFE] ZIP Buffer size:', data.length);

    while (offset < data.length - 30) {
      const sig = view.getUint32(offset, true);
      if (sig !== 0x04034b50) {
        // Not a local file header, might be the end or another signature?
        console.log('[GFE] Found unknown signature at offset', offset, ':', sig.toString(16));
        break; 
      }

      const flags = view.getUint16(offset + 6, true);
      const method = view.getUint16(offset + 8, true);
      const hasDataDescriptor = (flags & 0x08) !== 0;

      let compSize = view.getUint32(offset + 18, true);
      const uncompSize = view.getUint32(offset + 22, true);
      const nameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);

      const nameBytes = data.slice(offset + 30, offset + 30 + nameLen);
      const fileName = new TextDecoder().decode(nameBytes);
      const dataStart = offset + 30 + nameLen + extraLen;

      console.log('[GFE] ZIP Entry:', fileName, 'Method:', method, 'CompSize:', compSize, 'Flags:', flags.toString(16));

      if (fileName.toLowerCase().endsWith('.fit')) {
        // If it has a data descriptor (bit 3), compSize in header is likely 0.
        // We must find the next signature to determine the real compSize.
        if (hasDataDescriptor || compSize === 0) {
          console.log('[GFE] Scan required for bit-3 Data Descriptor...');
          let scan = dataStart;
          while (scan < data.length - 4) {
             // Look for Data Descriptor signature (0x08074b50) or next header (0x04034b50)
             const s = view.getUint32(scan, true);
             if (s === 0x08074b50 || s === 0x04034b50 || s === 0x02014b50) {
               compSize = scan - dataStart;
               break;
             }
             scan++;
          }
          if (compSize === 0) compSize = data.length - dataStart;
          console.log('[GFE] Determined compSize after scan:', compSize);
        }

        const compressed = data.slice(dataStart, dataStart + compSize);

        if (method === 0) { // Stored
          return compressed.buffer;
        } else if (method === 8) { // Deflate
          try {
            const ds = new DecompressionStream('deflate-raw');
            const writer = ds.writable.getWriter();
            writer.write(compressed);
            writer.close();
            
            const reader = ds.readable.getReader();
            const chunks = [];
            
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
              }
            } catch (e) {
              if (e.message.includes('truncated')) {
                console.warn('[GFE] Ignoring truncation error in Deflate stream. Proceeding with partial data.');
              } else {
                throw e;
              }
            }
            
            const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
            const merged = new Uint8Array(totalLen);
            let pos = 0;
            for (const c of chunks) {
              merged.set(c, pos);
              pos += c.length;
            }
            return merged.buffer;
          } catch (e) {
            throw new Error(`Decompression failed: ${e.message}`);
          }
        } else {
          throw new Error(`Unsupported compression method: ${method}`);
        }
      }

      // Move to next entry
      // If bit 3 was set, we might not have a reliable compSize yet unless we scanned.
      // But for Garmin, the FIT file is usually the only file.
      offset = dataStart + compSize;
       // Check for Data Descriptor footer (12 or 16 bytes) if bit 3 set
      if (hasDataDescriptor) offset += 16; 
    }

    throw new Error('No .fit file found in ZIP archive');
  }

  return { extractFitFromZip };
})();


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

const FIT = (() => {
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
    73: 'enhanced_speed',        // scale 1000
    78: 'enhanced_altitude',     // scale 5, offset 500
    119: 'vertical_ratio',       // scale 100
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
    // Handle by checking known invalid sentinel values based on lower 5 bits of baseType
    if (key === 0x00 || key === 0x02 || key === 0x0D) return value === 0xFF; // enum, uint8, byte
    if (key === 0x01) return value === 0x7F; // sint8
    if (key === 0x03) return value === 0x7FFF; // sint16
    if (key === 0x04) return value === 0xFFFF; // uint16
    if (key === 0x05) return value === 0x7FFFFFFF; // sint32
    if (key === 0x06) return value === 0xFFFFFFFF; // uint32
    if (key === 0x0A || key === 0x0B || key === 0x0C) return value === 0; // uint8z, uint16z, uint32z
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
    const shifted = new Date((garminTs + GARMIN_EPOCH + (8 * 3600)) * 1000);
    return shifted.toISOString().replace('Z', '');
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



function toCSV(records, session, activityMeta) {
  const lines = [];
  lines.push('# Garmin Run Export — Parsed for AI Analysis');
  lines.push('# Generated: ' + new Date().toISOString());
  lines.push('#');

  const actName = activityMeta ? (activityMeta.activityName || activityMeta.summaryDTO?.activityName || activityMeta.metadataDTO?.activityName) : null;
  const actId = activityMeta ? (activityMeta.activityId || activityMeta.summaryDTO?.activityId) : null;
  const actDate = (activityMeta ? (activityMeta.startTimeLocal || activityMeta.summaryDTO?.startTimeLocal || activityMeta.startTimeGMT || activityMeta.summaryDTO?.startTimeGMT || activityMeta.metadataDTO?.startTimeLocal || activityMeta.metadataDTO?.startTimeGMT) : null) || session?.start_time || records?.[0]?.timestamp;
  const sport = activityMeta ? (activityMeta.activityType?.typeKey || activityMeta.summaryDTO?.activityType?.typeKey) : null;

  if (actName) lines.push('# Activity: ' + actName);
  if (actId) lines.push('# Activity ID: ' + actId);
  if (actDate) lines.push('# Date: ' + actDate);
  if (sport) lines.push('# Sport: ' + sport);

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
    return lines.join('\n');
  }

  const DESIRED_COLUMNS = [
    'timestamp', 'heart_rate', 'cadence', 'speed', 'enhanced_speed',
    'distance', 'altitude', 'enhanced_altitude', 'position_lat', 'position_long',
    'temperature', 'power', 'vertical_oscillation', 'stance_time',
    'stance_time_percent', 'step_length', 'vertical_ratio', 'core_temperature'
  ];

  const presentColumns = DESIRED_COLUMNS.filter(col => records.some(r => r[col] != null));
  const headers = presentColumns.map(col => col === 'cadence' ? 'cadence (spm)' : col);
  lines.push(headers.join(','));

  for (const rec of records) {
    const row = presentColumns.map(col => {
      const val = rec[col];
      if (val == null) return '';
      if (col === 'cadence') return val * 2;
      return val;
    });
    lines.push(row.join(','));
  }

  return lines.join('\n');
}

async function extractFitBuffer(buffer) {
  try {
    return await ZIP.extractFitFromZip(buffer);
  } catch (e) {
    const header = new Uint8Array(buffer);
    if (header.length > 12) {
      const sig = String.fromCharCode(header[8], header[9], header[10], header[11]);
      if (sig === '.FIT') return buffer;
    }
    throw new Error('Could not extract FIT file: ' + e.message);
  }
}


function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : null;
  }

  async function garminFetch(url) {
    const headers = { 'Accept': 'application/json' };
    const csrf = getCsrfToken();
    if (csrf) {
      headers['connect-csrf-token'] = csrf;
    }

    console.log('[GFE] Fetching:', url, 'CSRF:', csrf ? 'yes' : 'no');

    const resp = await fetch(url, {
      credentials: 'same-origin',
      headers
    });

    if (!resp.ok) {
      throw new Error(`Garmin API error (HTTP ${resp.status}).`);
    }

    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      throw new Error('Garmin returned HTML. Please sign out and back in.');
    }

    return resp;
  }

  // ---- Message handler ----
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'garmin-fit-exporter') return;

    const { action, requestId } = event.data;

    if (action === 'fetchActivities') {
      try {
        const url = '/gc-api/activitylist-service/activities/search/activities?' +
          new URLSearchParams({
            activityType: 'running',
            limit: '5',
            start: '0',
          });

        const resp = await garminFetch(url);
        const activities = await resp.json();

        window.postMessage({
          source: 'garmin-fit-exporter-response',
          requestId, success: true, data: activities
        }, '*');
      } catch (err) {
        window.postMessage({
          source: 'garmin-fit-exporter-response',
          requestId, success: false, error: err.message
        }, '*');
      }
    }

    if (action === 'fetchActivityDetails') {
      try {
        const url = `/gc-api/activity-service/activity/${event.data.activityId}`;
        const resp = await garminFetch(url);
        const activity = await resp.json();

        window.postMessage({
          source: 'garmin-fit-exporter-response',
          requestId, success: true, data: activity
        }, '*');
      } catch (err) {
        window.postMessage({
          source: 'garmin-fit-exporter-response',
          requestId, success: false, error: err.message
        }, '*');
      }
    }

    if (action === 'downloadFit') {
      let attempts = 0;
      const MAX_ATTEMPTS = 3;
      let lastError = null;

      while (attempts < MAX_ATTEMPTS) {
        try {
          attempts++;
          const url = `/gc-api/download-service/files/activity/${event.data.activityId}`;
          const headers = { 'Accept': '*/*' };
          const csrf = getCsrfToken();
          if (csrf) headers['connect-csrf-token'] = csrf;

          console.log(`[GFE] Download attempt ${attempts}/${MAX_ATTEMPTS}...`);
          const resp = await fetch(url, { credentials: 'same-origin', headers });
          
          if (!resp.ok) {
            if (resp.status === 403 || resp.status === 401) {
              throw new Error('Garmin session expired. Please refresh and log in again.');
            }
            throw new Error(`Failed to download FIT (HTTP ${resp.status}).`);
          }
          
          const ct = resp.headers.get('content-type') || '';
          if (ct.includes('text/html')) {
            throw new Error('FIT download failed — got HTML instead of data.');
          }

          const rawBuffer = await resp.arrayBuffer();
          
          // INSTANT PARSING IN PAGE CONTEXT
          console.log('[GFE] Extracting FIT from ZIP...', rawBuffer.byteLength, 'bytes');
          const fitBuffer = await extractFitBuffer(rawBuffer);
          
          console.log('[GFE] Parsing FIT file...', fitBuffer.byteLength, 'bytes');
          const { records, session } = FIT.parse(fitBuffer);
          
          console.log('[GFE] Building CSV...', records.length, 'records');
          const csv = toCSV(records, session, event.data.activity);
          
          // Return exactly the CSV text
          window.postMessage({
            source: 'garmin-fit-exporter-response',
            requestId, success: true, data: csv
          }, '*');
          return; // Success!
        } catch (err) {
          lastError = err;
          console.error(`[GFE] Attempt ${attempts} failed:`, err.message);
          if (err.message.includes('expired')) break; // Don't retry if auth is dead
          if (attempts < MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, 1000)); // Wait 1s before retry
          }
        }
      }

      // If we reach here, all attempts failed
      window.postMessage({
        source: 'garmin-fit-exporter-response',
        requestId, success: false, error: lastError.message
      }, '*');
    }

  });

  window.postMessage({ source: 'garmin-fit-exporter-ready' }, '*');
})();
