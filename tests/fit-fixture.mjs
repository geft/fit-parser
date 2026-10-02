import { CrcCalculator } from '@garmin/fitsdk';
import { Buffer } from 'node:buffer';

export const START = 1150000000;
const sizes = { 0: 1, 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 8: 4, 9: 8, 10: 1, 11: 2, 12: 4, 13: 1 };

/** Fields use published numeric FIT IDs and raw binary values, independently of Encoder. */
export function message(number, fields, { local = 0, bigEndian = false, developer = [] } = {}) {
  const encoded = fields.map(([id, base, value]) => {
    const type = base & 31;
    const values = Array.isArray(value) ? value : [value];
    if (type === 7) return { id, base, bytes: Buffer.from(String(value) + '\0') };
    const size = sizes[type];
    const bytes = Buffer.alloc(size * values.length);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    values.forEach((val, index) => {
      const offset = index * size;
      if (size === 1) bytes[offset] = val;
      else if (type === 3) view.setInt16(offset, val, !bigEndian);
      else if (type === 5) view.setInt32(offset, val, !bigEndian);
      else if (type === 8) view.setFloat32(offset, val, !bigEndian);
      else if (type === 9) view.setFloat64(offset, val, !bigEndian);
      else if (size === 2) view.setUint16(offset, val, !bigEndian);
      else view.setUint32(offset, val, !bigEndian);
    });
    return { id, base, bytes };
  });
  const definition = Buffer.from([64 | local | (developer.length ? 32 : 0), 0, bigEndian ? 1 : 0,
    bigEndian ? number >> 8 : number & 255, bigEndian ? number & 255 : number >> 8,
    fields.length, ...encoded.flatMap(field => [field.id, field.bytes.length, field.base]),
    ...(developer.length ? [developer.length, ...developer.flatMap(field => [field.id, field.bytes.length, field.index])] : []),
  ]);
  return Buffer.concat([definition, Buffer.from([local]), ...encoded.map(field => field.bytes), ...developer.map(field => field.bytes)]);
}

export function sealFit(input) {
  const dataEnd = input[0] + input.readUInt32LE(4);
  const bytes = Buffer.alloc(dataEnd + 2);
  input.copy(bytes, 0, 0, dataEnd);
  if (bytes[0] === 14) bytes.writeUInt16LE(CrcCalculator.calculateCRC(bytes, 0, 12), 12);
  bytes.writeUInt16LE(CrcCalculator.calculateCRC(bytes, 0, dataEnd), dataEnd);
  return bytes;
}

export function fitFile(chunks) {
  const data = Buffer.concat(chunks);
  const header = Buffer.alloc(14);
  header[0] = 14; header[1] = 32;
  header.writeUInt16LE(21217, 2);
  header.writeUInt32LE(data.length, 4);
  header.write('.FIT', 8);
  return sealFit(Buffer.concat([header, data]));
}

export function richFit() {
  return fitFile([
    message(0, [[0, 0, 4], [1, 0x84, 1], [3, 0x8c, 123456], [4, 0x86, START]]),
    message(207, [[0, 13, Array(16).fill(1)], [1, 13, Array(16).fill(2)], [3, 2, 0], [4, 0x86, 3]]),
    message(206, [[0, 2, 0], [1, 2, 0], [2, 2, 0x84], [3, 7, 'Sensor Power'], [6, 2, 10], [8, 7, 'W'], [14, 0x84, 20], [15, 2, 7]]),
    message(26, [[4, 7, '6 x 1 min'], [5, 0x84, 2], [6, 0, 1]]),
    message(27, [[254, 0x84, 0], [0, 7, 'Work'], [1, 0, 0], [2, 0x86, 60000], [3, 0, 0], [4, 0x86, 3000], [7, 0, 0]]),
    message(23, [[253, 0x86, START], [0, 2, 0], [2, 0x84, 1], [3, 0x8c, 123456], [4, 0x84, 65535], [5, 0x84, 1234], [27, 7, 'Test watch']]),
    message(21, [[253, 0x86, START], [0, 0, 0], [1, 0, 0]]),
    message(20, [[253, 0x86, START], [0, 0x85, 12345678], [1, 0x85, 123456789],
      [3, 2, 140], [4, 2, 85], [53, 2, 32], [5, 0x86, 0], [73, 0x86, 3000], [78, 0x86, 2600],
      [39, 0x84, 820], [41, 0x84, 2450], [83, 0x84, 750], [84, 0x84, 5020], [85, 0x84, 11000],
      [108, 0x84, 2850], [139, 0x84, 3810], [249, 2, 42]],
      { developer: [{ id: 0, index: 0, bytes: Buffer.from([184, 11]) }] }),
    message(78, [[0, 0x84, [800, 810, 790]]]),
    message(21, [[253, 0x86, START + 30], [0, 0, 0], [1, 0, 4]]),
    message(21, [[253, 0x86, START + 40], [0, 0, 0], [1, 0, 0]]),
    message(20, [[253, 0x86, START + 60], [3, 2, 150], [4, 2, 90], [5, 0x86, 18000], [73, 0x86, 3000], [78, 0x86, 2600], [7, 0x84, 310], [85, 0x84, 10000]]),
    message(19, [[254, 0x84, 0], [253, 0x86, START + 60], [2, 0x86, START], [7, 0x86, 60000], [8, 0x86, 50000], [9, 0x86, 18000], [24, 0, 0], [71, 0x84, 0]]),
    message(21, [[253, 0x86, START + 60], [0, 0, 0], [1, 0, 4]]),
    message(18, [[253, 0x86, START + 60], [2, 0x86, START], [5, 0, 1], [6, 0, 0], [7, 0x86, 60000], [8, 0x86, 50000],
      [9, 0x86, 18000], [16, 2, 145], [17, 2, 150], [18, 2, 87], [92, 2, 32], [24, 2, 32], [137, 2, 12],
      [89, 0x84, 820], [91, 0x84, 2450], [134, 0x84, 11000], [192, 2, 75], [193, 2, 60]]),
    message(34, [[253, 0x86, START + 60], [5, 0x86, START + 60 + 28800], [1, 0x84, 1]]),
  ]);
}
