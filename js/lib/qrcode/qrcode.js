// qrcode.js — Vendored, dependency-free QR code generator.
//
// Pure-JS QR code generator (Model 2). Generates a boolean matrix you can
// render however you like (canvas, SVG, etc.). No external dependencies, no
// runtime npm install, no .npmrc concern.
//
// Adapted from Kazuhiko Arase's qrcode-generator (public domain / MIT,
// https://github.com/kazuhikoarase/qrcode-generator). Trimmed to the byte
// mode + ECC level M path that Bookish needs for its invite URLs (URLs are
// ASCII, well under the 2331-byte byte-mode capacity at version 40 / level L,
// and well under the level-M capacity we use here for in-person scanning).
//
// Usage:
//   import { makeQR } from './lib/qrcode/qrcode.js';
//   const matrix = makeQR(text, { ecc: 'M' });
//   // matrix.size is the side length in modules; matrix.isDark(row, col) is true for dark cells.

// ---------- Galois Field math (GF(256), polynomial 0x11d) ----------

const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 256; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] + LOG[b]) % 255];
}

// ---------- Polynomial helpers ----------

class Polynomial {
  constructor(num, shift = 0) {
    let offset = 0;
    while (offset < num.length && num[offset] === 0) offset++;
    const arr = new Uint8Array(num.length - offset + shift);
    for (let i = 0; i < num.length - offset; i++) arr[i] = num[i + offset];
    this.num = arr;
  }
  get(i) { return this.num[i]; }
  get length() { return this.num.length; }
  multiply(other) {
    const out = new Uint8Array(this.length + other.length - 1);
    for (let i = 0; i < this.length; i++) {
      for (let j = 0; j < other.length; j++) {
        out[i + j] ^= gfMul(this.num[i], other.num[j]);
      }
    }
    return new Polynomial(out);
  }
  mod(other) {
    if (this.length - other.length < 0) return this;
    const ratio = LOG[this.num[0]] - LOG[other.num[0]];
    const out = new Uint8Array(this.length);
    for (let i = 0; i < this.length; i++) out[i] = this.num[i];
    for (let i = 0; i < other.length; i++) {
      out[i] ^= EXP[(LOG[other.num[i]] + ratio + 255) % 255];
    }
    return new Polynomial(out).mod(other);
  }
}

// ---------- Reed-Solomon generator polynomial ----------

function rsGenPoly(degree) {
  let p = new Polynomial([1]);
  for (let i = 0; i < degree; i++) {
    p = p.multiply(new Polynomial([1, EXP[i]]));
  }
  return p;
}

// ---------- Capacity / EC tables (subset for byte mode, ECC M) ----------
//
// For each version 1..40, tuple is:
//   [totalCodewords, ecCodewordsPerBlock, blocks_group1, dataCodewords_group1, blocks_group2, dataCodewords_group2]
// Source: ISO/IEC 18004:2015 Annex D / standard references.

const RS_BLOCKS_M = [
  // v1
  [26, 10, 1, 16, 0, 0],
  [44, 16, 1, 28, 0, 0],
  [70, 26, 1, 44, 0, 0],
  [100, 18, 2, 32, 0, 0],
  [134, 24, 2, 43, 0, 0],
  [172, 16, 4, 27, 0, 0],
  [196, 18, 4, 31, 0, 0],
  [242, 22, 2, 38, 2, 39],
  [292, 22, 3, 36, 2, 37],
  [346, 26, 4, 43, 1, 44],
  // v11
  [404, 30, 1, 50, 4, 51],
  [466, 22, 6, 36, 2, 37],
  [532, 22, 8, 37, 1, 38],
  [581, 24, 4, 40, 5, 41],
  [655, 24, 5, 41, 5, 42],
  [733, 28, 7, 45, 3, 46],
  [815, 28, 10, 46, 1, 47],
  [901, 26, 9, 43, 4, 44],
  [991, 26, 3, 44, 11, 45],
  [1085, 26, 3, 41, 13, 42],
  // v21
  [1156, 26, 17, 42, 0, 0],
  [1258, 28, 17, 46, 0, 0],
  [1364, 28, 4, 47, 14, 48],
  [1474, 28, 6, 45, 14, 46],
  [1588, 28, 8, 47, 13, 48],
  [1706, 28, 19, 46, 4, 47],
  [1828, 28, 22, 45, 3, 46],
  [1921, 28, 3, 45, 23, 46],
  [2051, 28, 21, 45, 7, 46],
  [2185, 28, 19, 47, 10, 48],
  // v31
  [2323, 28, 2, 46, 29, 47],
  [2465, 28, 10, 46, 23, 47],
  [2611, 28, 14, 46, 21, 47],
  [2761, 28, 14, 46, 23, 47],
  [2876, 28, 12, 47, 26, 48],
  [3034, 28, 6, 47, 34, 48],
  [3196, 28, 29, 46, 14, 47],
  [3362, 28, 13, 46, 32, 47],
  [3532, 28, 40, 47, 7, 48],
  [3706, 28, 18, 47, 31, 48],
];

// Number of data bits available for byte mode at each version, ECC M.
// Data codewords per version = totalCodewords - ecCodewords (sum across blocks).
function dataCapacityBitsM(version) {
  const t = RS_BLOCKS_M[version - 1];
  const total = t[0];
  const ec = t[1];
  const blocksTotal = t[2] + t[4];
  const dataCodewords = total - ec * blocksTotal;
  return dataCodewords * 8;
}

// Bits needed for byte-mode encoding: 4 (mode) + N (char count indicator) + 8*len + 4 (terminator)
function byteModeBitsRequired(version, byteLen) {
  const charCountBits = version <= 9 ? 8 : 16;
  return 4 + charCountBits + 8 * byteLen + 4;
}

function chooseVersion(byteLen) {
  for (let v = 1; v <= 40; v++) {
    const required = byteModeBitsRequired(v, byteLen);
    const available = dataCapacityBitsM(v);
    if (required <= available) return v;
  }
  throw new Error(`QR: data too long for ECC level M (${byteLen} bytes)`);
}

// ---------- Bit buffer ----------

class BitBuffer {
  constructor() {
    this.bytes = [];
    this.length = 0;
  }
  put(num, len) {
    for (let i = 0; i < len; i++) {
      this.putBit(((num >>> (len - i - 1)) & 1) === 1);
    }
  }
  putBit(bit) {
    const idx = this.length >>> 3;
    if (this.bytes.length <= idx) this.bytes.push(0);
    if (bit) this.bytes[idx] |= 0x80 >>> (this.length & 7);
    this.length++;
  }
}

// ---------- Encode data + ECC ----------

function encodeData(text, version) {
  const utf8 = new TextEncoder().encode(text);
  const bb = new BitBuffer();
  // Mode: byte = 0b0100
  bb.put(4, 4);
  // Character count indicator
  bb.put(utf8.length, version <= 9 ? 8 : 16);
  for (let i = 0; i < utf8.length; i++) bb.put(utf8[i], 8);
  // Terminator (up to 4 zero bits, but never past capacity)
  const capBits = dataCapacityBitsM(version);
  for (let i = 0; i < 4 && bb.length < capBits; i++) bb.putBit(false);
  // Pad to byte boundary
  while (bb.length % 8 !== 0) bb.putBit(false);
  // Pad bytes 0xEC, 0x11 alternating until full
  const capBytes = capBits / 8;
  let pad = false;
  while (bb.bytes.length < capBytes) {
    bb.bytes.push(pad ? 0x11 : 0xEC);
    pad = !pad;
  }

  // Split into blocks per RS table
  const t = RS_BLOCKS_M[version - 1];
  const ecLen = t[1];
  const blocks = [];
  for (let i = 0; i < t[2]; i++) blocks.push({ dataLen: t[3] });
  for (let i = 0; i < t[4]; i++) blocks.push({ dataLen: t[5] });

  let offset = 0;
  for (const blk of blocks) {
    blk.data = bb.bytes.slice(offset, offset + blk.dataLen);
    offset += blk.dataLen;
    const gen = rsGenPoly(ecLen);
    const padded = new Uint8Array(blk.dataLen + ecLen);
    for (let i = 0; i < blk.dataLen; i++) padded[i] = blk.data[i];
    const rem = new Polynomial(padded).mod(gen);
    blk.ec = new Uint8Array(ecLen);
    const offsetEc = ecLen - rem.length;
    for (let i = 0; i < rem.length; i++) blk.ec[offsetEc + i] = rem.get(i);
  }

  // Interleave data
  const maxData = Math.max(...blocks.map(b => b.dataLen));
  const out = [];
  for (let i = 0; i < maxData; i++) {
    for (const blk of blocks) {
      if (i < blk.dataLen) out.push(blk.data[i]);
    }
  }
  for (let i = 0; i < ecLen; i++) {
    for (const blk of blocks) out.push(blk.ec[i]);
  }
  return out;
}

// ---------- Matrix construction ----------

function modulesPerSide(version) {
  return 17 + 4 * version;
}

function makeMatrix(version) {
  const n = modulesPerSide(version);
  const cells = new Uint8Array(n * n); // 0=light, 1=dark, set in `placed`
  const placed = new Uint8Array(n * n); // 1 if reserved/written
  const at = (r, c) => r * n + c;

  function set(r, c, dark) {
    cells[at(r, c)] = dark ? 1 : 0;
    placed[at(r, c)] = 1;
  }

  // Finder patterns (3 corners, 7x7)
  function placeFinder(r0, c0) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
        let dark;
        if (r >= 0 && r <= 6 && (c === 0 || c === 6)) dark = true;
        else if (c >= 0 && c <= 6 && (r === 0 || r === 6)) dark = true;
        else if (r >= 2 && r <= 4 && c >= 2 && c <= 4) dark = true;
        else dark = false;
        set(rr, cc, dark);
      }
    }
  }
  placeFinder(0, 0);
  placeFinder(0, n - 7);
  placeFinder(n - 7, 0);

  // Timing patterns
  for (let i = 8; i < n - 8; i++) {
    if (!placed[at(6, i)]) set(6, i, i % 2 === 0);
    if (!placed[at(i, 6)]) set(i, 6, i % 2 === 0);
  }

  // Alignment patterns (none for v1; positions table for v2..v40)
  if (version >= 2) {
    const positions = alignmentPositions(version);
    for (const r of positions) {
      for (const c of positions) {
        if (placed[at(r, c)]) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const rr = r + dr, cc = c + dc;
            const isOuter = Math.abs(dr) === 2 || Math.abs(dc) === 2;
            const isCenter = dr === 0 && dc === 0;
            set(rr, cc, isOuter || isCenter);
          }
        }
      }
    }
  }

  // Reserve format-info and version-info regions
  for (let i = 0; i < 9; i++) {
    if (!placed[at(8, i)]) { placed[at(8, i)] = 1; }
    if (!placed[at(i, 8)]) { placed[at(i, 8)] = 1; }
  }
  for (let i = 0; i < 8; i++) {
    if (!placed[at(8, n - 1 - i)]) { placed[at(8, n - 1 - i)] = 1; }
    if (!placed[at(n - 1 - i, 8)]) { placed[at(n - 1 - i, 8)] = 1; }
  }
  // Dark module
  set(n - 8, 8, true);

  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3);
      const c = i % 3 + n - 8 - 3;
      placed[at(r, c)] = 1;
      placed[at(c, r)] = 1;
    }
  }

  return { n, cells, placed };
}

function alignmentPositions(version) {
  // Standard table from ISO/IEC 18004
  const table = [
    [],                              // v1 (no alignment patterns)
    [6, 18],                          // v2
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],                      // v7
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
    [6, 30, 54],
    [6, 32, 58],
    [6, 34, 62],
    [6, 26, 46, 66],                  // v14
    [6, 26, 48, 70],
    [6, 26, 50, 74],
    [6, 30, 54, 78],
    [6, 30, 56, 82],
    [6, 30, 58, 86],
    [6, 34, 62, 90],
    [6, 28, 50, 72, 94],              // v21
    [6, 26, 50, 74, 98],
    [6, 30, 54, 78, 102],
    [6, 28, 54, 80, 106],
    [6, 32, 58, 84, 110],
    [6, 30, 58, 86, 114],
    [6, 34, 62, 90, 118],
    [6, 26, 50, 74, 98, 122],         // v28
    [6, 30, 54, 78, 102, 126],
    [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134],
    [6, 34, 60, 86, 112, 138],
    [6, 30, 58, 86, 114, 142],
    [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150],   // v35
    [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158],
    [6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166],
    [6, 30, 58, 86, 114, 142, 170],
  ];
  return table[version - 1];
}

// ---------- Place data + apply mask ----------

function placeData(matrix, dataBytes) {
  const { n, cells, placed } = matrix;
  const at = (r, c) => r * n + c;
  let bitIndex = 0;
  let dir = -1; // -1 = up, +1 = down
  let row = n - 1;

  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip vertical timing column
    while (true) {
      for (let dx = 0; dx < 2; dx++) {
        const c = col - dx;
        if (!placed[at(row, c)]) {
          let bit = 0;
          if (bitIndex < dataBytes.length * 8) {
            const byte = dataBytes[bitIndex >>> 3];
            bit = ((byte >>> (7 - (bitIndex & 7))) & 1);
          }
          cells[at(row, c)] = bit;
          placed[at(row, c)] = 1;
          bitIndex++;
        }
      }
      row += dir;
      if (row < 0 || row >= n) {
        dir = -dir;
        row += dir;
        break;
      }
    }
  }
}

function maskFn(maskId) {
  switch (maskId) {
    case 0: return (r, c) => (r + c) % 2 === 0;
    case 1: return (r) => r % 2 === 0;
    case 2: return (_, c) => c % 3 === 0;
    case 3: return (r, c) => (r + c) % 3 === 0;
    case 4: return (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
  return () => false;
}

function applyMask(matrix, maskId, isDataMask) {
  const fn = maskFn(maskId);
  const { n, cells } = matrix;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!isDataMask[r * n + c]) continue;
      if (fn(r, c)) cells[r * n + c] ^= 1;
    }
  }
}

function buildIsDataMask(matrix) {
  // Cells that are data modules: every placed cell that isn't a function-pattern reserved cell.
  // We record this when the matrix is freshly constructed (everything placed before placeData is function/format).
  const { n, placed } = matrix;
  const fnMask = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) fnMask[i] = placed[i] ? 1 : 0;
  return fnMask;
}

function isDataCell(initialPlacedSnapshot, idx) {
  return !initialPlacedSnapshot[idx];
}

function evaluateMask(matrix) {
  // Standard penalty score
  const { n, cells } = matrix;
  const at = (r, c) => r * n + c;
  let score = 0;

  // Rule 1: runs of 5+ same-color in row/col → score = 3 + (run-5)
  for (let r = 0; r < n; r++) {
    let run = 1;
    for (let c = 1; c < n; c++) {
      if (cells[at(r, c)] === cells[at(r, c - 1)]) {
        run++;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let c = 0; c < n; c++) {
    let run = 1;
    for (let r = 1; r < n; r++) {
      if (cells[at(r, c)] === cells[at(r - 1, c)]) {
        run++;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  // Rule 2: 2x2 same-color blocks → +3 each
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = cells[at(r, c)];
      if (v === cells[at(r, c + 1)] && v === cells[at(r + 1, c)] && v === cells[at(r + 1, c + 1)]) {
        score += 3;
      }
    }
  }
  // Rule 3: finder-like patterns 1011101 with light buffer → +40 each
  const pattern = [1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c <= n - 7; c++) {
      let m = true;
      for (let i = 0; i < 7; i++) if (cells[at(r, c + i)] !== pattern[i]) { m = false; break; }
      if (m) {
        // Check for 4 light modules on either side
        const before = (c >= 4) && [1,2,3,4].every(k => cells[at(r, c - k)] === 0);
        const after = (c + 7 + 3 < n) && [0,1,2,3].every(k => cells[at(r, c + 7 + k)] === 0);
        if (before || after) score += 40;
      }
    }
  }
  for (let c = 0; c < n; c++) {
    for (let r = 0; r <= n - 7; r++) {
      let m = true;
      for (let i = 0; i < 7; i++) if (cells[at(r + i, c)] !== pattern[i]) { m = false; break; }
      if (m) {
        const before = (r >= 4) && [1,2,3,4].every(k => cells[at(r - k, c)] === 0);
        const after = (r + 7 + 3 < n) && [0,1,2,3].every(k => cells[at(r + 7 + k, c)] === 0);
        if (before || after) score += 40;
      }
    }
  }
  // Rule 4: dark-module proportion
  let dark = 0;
  for (let i = 0; i < n * n; i++) if (cells[i]) dark++;
  const ratio = (dark * 100) / (n * n);
  const dev = Math.abs(ratio - 50) / 5;
  score += Math.floor(dev) * 10;

  return score;
}

// ---------- Format info (level M = 0b00) and version info ----------

function bchFormat(input) {
  // BCH(15,5) generator polynomial 0b10100110111
  let d = input << 10;
  for (let i = 4; i >= 0; i--) {
    if ((d >>> (i + 10)) & 1) d ^= 0b10100110111 << i;
  }
  return ((input << 10) | d) ^ 0b101010000010010;
}

function placeFormatInfo(matrix, maskId) {
  // ECC M = 0b00, mask 3 bits → 5-bit format input
  const fmtInput = (0b00 << 3) | maskId;
  const bits = bchFormat(fmtInput);
  const { n, cells } = matrix;
  const at = (r, c) => r * n + c;
  // Top-left horizontal + vertical
  for (let i = 0; i < 6; i++) {
    cells[at(8, i)] = (bits >>> i) & 1;
  }
  cells[at(8, 7)] = (bits >>> 6) & 1;
  cells[at(8, 8)] = (bits >>> 7) & 1;
  cells[at(7, 8)] = (bits >>> 8) & 1;
  for (let i = 9; i < 15; i++) {
    cells[at(14 - i, 8)] = (bits >>> i) & 1;
  }
  // Bottom-left + top-right
  for (let i = 0; i < 8; i++) {
    cells[at(n - 1 - i, 8)] = (bits >>> i) & 1;
  }
  for (let i = 8; i < 15; i++) {
    cells[at(8, n - 15 + i)] = (bits >>> i) & 1;
  }
}

function bchVersion(version) {
  // BCH(18,6), generator 0b1111100100101
  let d = version << 12;
  for (let i = 5; i >= 0; i--) {
    if ((d >>> (i + 12)) & 1) d ^= 0b1111100100101 << i;
  }
  return (version << 12) | d;
}

function placeVersionInfo(matrix, version) {
  if (version < 7) return;
  const bits = bchVersion(version);
  const { n, cells } = matrix;
  const at = (r, c) => r * n + c;
  for (let i = 0; i < 18; i++) {
    const bit = (bits >>> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3 + n - 8 - 3;
    cells[at(r, c)] = bit;
    cells[at(c, r)] = bit;
  }
}

// ---------- Public API ----------

/**
 * Generate a QR code (ECC level M, byte mode).
 *
 * @param {string} text — The text to encode (UTF-8).
 * @param {{ ecc?: 'M' }} [opts] — Reserved; only 'M' is supported in this build.
 * @returns {{ size: number, isDark: (r: number, c: number) => boolean }}
 */
export function makeQR(text /* , opts = {} */) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('makeQR: text required');
  }
  const utf8len = new TextEncoder().encode(text).length;
  const version = chooseVersion(utf8len);
  const data = encodeData(text, version);

  // Pick best mask: try 0..7, score, choose lowest
  let best = null;
  for (let m = 0; m < 8; m++) {
    const matrix = makeMatrix(version);
    const initialPlaced = new Uint8Array(matrix.placed);
    placeData(matrix, data);
    const dataMask = new Uint8Array(matrix.cells.length);
    for (let i = 0; i < matrix.cells.length; i++) dataMask[i] = isDataCell(initialPlaced, i) ? 1 : 0;
    applyMask(matrix, m, dataMask);
    placeFormatInfo(matrix, m);
    placeVersionInfo(matrix, version);
    const score = evaluateMask(matrix);
    if (best === null || score < best.score) {
      best = { score, matrix };
    }
  }

  const { n, cells } = best.matrix;
  return {
    size: n,
    isDark(r, c) {
      if (r < 0 || c < 0 || r >= n || c >= n) return false;
      return cells[r * n + c] === 1;
    },
  };
}

/**
 * Render a QR matrix to an SVG string. Black on white.
 *
 * @param {{ size: number, isDark: (r: number, c: number) => boolean }} qr
 * @param {{ scale?: number, margin?: number, dark?: string, light?: string }} [opts]
 * @returns {string}
 */
export function qrToSvg(qr, opts = {}) {
  const scale = Math.max(1, opts.scale ?? 6);
  const margin = Math.max(0, opts.margin ?? 4);
  const dark = opts.dark || '#000000';
  const light = opts.light || '#ffffff';
  const total = qr.size + margin * 2;
  const px = total * scale;
  let path = '';
  for (let r = 0; r < qr.size; r++) {
    let runStart = -1;
    for (let c = 0; c <= qr.size; c++) {
      const dark = c < qr.size && qr.isDark(r, c);
      if (dark && runStart === -1) {
        runStart = c;
      } else if (!dark && runStart !== -1) {
        const x = (margin + runStart) * scale;
        const y = (margin + r) * scale;
        const w = (c - runStart) * scale;
        path += `M${x} ${y}h${w}v${scale}h-${w}z`;
        runStart = -1;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}" shape-rendering="crispEdges">`
    + `<rect width="${px}" height="${px}" fill="${light}"/>`
    + `<path fill="${dark}" d="${path}"/>`
    + `</svg>`;
}
