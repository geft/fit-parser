/**
 * Minimal ZIP extractor for Chrome extension service worker.
 * Only handles Deflate (method 8) and Store (method 0) compressed entries.
 * Extracts the first .fit file found in the archive.
 */

self.ZIP = (() => {
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

  /**
   * Extract the first .fit file from a ZIP archive.
   * @param {ArrayBuffer} buffer - The ZIP file as an ArrayBuffer
   * @returns {ArrayBuffer} - The extracted .fit file contents
   */
  function extractFitFromZip(buffer) {
    const data = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let offset = 0;

    while (offset < data.length - 4) {
      const sig = view.getUint32(offset, true);
      if (sig !== 0x04034b50) break; // Not a local file header

      const method = view.getUint16(offset + 8, true);
      const compSize = view.getUint32(offset + 18, true);
      const uncompSize = view.getUint32(offset + 22, true);
      const nameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);

      const nameBytes = data.slice(offset + 30, offset + 30 + nameLen);
      const fileName = new TextDecoder().decode(nameBytes);

      const dataStart = offset + 30 + nameLen + extraLen;

      if (fileName.toLowerCase().endsWith('.fit')) {
        if (method === 0) {
          // Stored
          return data.slice(dataStart, dataStart + compSize).buffer;
        } else if (method === 8) {
          // Deflate
          const compressed = data.slice(dataStart, dataStart + compSize);
          const decompressed = inflate(compressed);
          return decompressed.buffer;
        } else {
          throw new Error(`Unsupported compression method: ${method}`);
        }
      }

      offset = dataStart + compSize;
    }

    throw new Error('No .fit file found in ZIP archive');
  }

  return { extractFitFromZip };
})();
