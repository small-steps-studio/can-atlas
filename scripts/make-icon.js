'use strict';
// Draws media/icon.png (128 x 128): a dark tile with two bus lines above a grid of bit cells in which
// two signals are drawn as coloured runs. Drawn with 4x4 supersampling and written as a PNG with
// only IHDR, IDAT and IEND chunks.
//   node scripts/make-icon.js [output.png]

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 128;
const SS = 4;

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, function (_, n) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
}

const BG = hex('#1b2a3a');
const CELL = hex('#3a5068');
const SIGNAL_A = hex('#4cc3a1');
const SIGNAL_B = hex('#f2b134');
const BUS = hex('#cfe0f2');

// A grid of 8 bit cells per byte, 4 bytes. Two signals are drawn as runs of cells: one in the
// second byte (teal) and one that crosses from the third into the fourth byte (amber).
const COLS = 8;
const ROWS = 4;
const X0 = 20;
const Y0 = 38;
const STEP = 11.5;
const BOX = 9;
function cellColour(col, row) {
  if (row === 1 && col >= 1 && col <= 6) return SIGNAL_A;
  if (row === 2 && col >= 5) return SIGNAL_B;
  if (row === 3 && col <= 2) return SIGNAL_B;
  return CELL;
}

function shade(x, y) {
  if (!inRoundRect(x, y, 4, 4, 124, 124, 22)) return null;
  // The bus: two parallel lines with a gap above the grid.
  if (inRoundRect(x, y, 20, 17, 108, 21, 2)) return BUS;
  if (inRoundRect(x, y, 20, 25, 108, 29, 2)) return BUS;
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const x0 = X0 + col * STEP;
      const y0 = Y0 + row * STEP * 1.35;
      if (inRoundRect(x, y, x0, y0, x0 + BOX, y0 + BOX + 3, 2.5)) return cellColour(col, row);
    }
  }
  return BG;
}

function render() {
  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    const row = Buffer.alloc(1 + SIZE * 4);
    row[0] = 0;
    for (let x = 0; x < SIZE; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const o = 1 + x * 4;
      if (a) { row[o] = Math.round(r / a); row[o + 1] = Math.round(g / a); row[o + 2] = Math.round(b / a); }
      row[o + 3] = Math.round(255 * a / (SS * SS));
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, '..', 'media', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, render());
  process.stdout.write('icon written: ' + out + '\n');
}

module.exports = { render: render };
