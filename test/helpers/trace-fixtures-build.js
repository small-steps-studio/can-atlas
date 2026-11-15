'use strict';
// Writes the trace fixtures that a text editor cannot hold safely: other line endings, a byte
// order mark, UTF-16, a file without a final newline, an empty file and random bytes. The files
// are checked in; run `node test/helpers/trace-fixtures-build.js --build` to write them again.
// Nothing happens when the file is only loaded (the test runner loads every file under test/).

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'fixtures', 'traces');

const FRAMES = [
  '(1762944000.000000) can0 100#401F72FA8E01103C',
  '(1762944000.002000) can0 120#380BB85F',
  '(1762944000.005000) can0 130#E8131027F401',
  '(1762944000.010000) can0 100#601F72FA001E10D0'
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function build() {
  fs.mkdirSync(DIR, { recursive: true });
  const write = function (name, data) { fs.writeFileSync(path.join(DIR, name), data); };
  write('crlf.candump.log', FRAMES.join('\r\n') + '\r\n');
  write('lone-cr.candump.log', FRAMES.join('\r') + '\r');
  write('bom.candump.log', Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(FRAMES.join('\n') + '\n', 'utf8')]));
  write('no-final-newline.candump.log', FRAMES.slice(0, 3).join('\n'));
  write('empty.log', Buffer.alloc(0));
  write('utf16le.candump.log', Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(FRAMES.slice(0, 3).join('\r\n') + '\r\n', 'utf16le')]));
  const rnd = mulberry32(20261112);
  const junk = Buffer.alloc(4096);
  for (let i = 0; i < junk.length; i++) junk[i] = Math.floor(rnd() * 256);
  write('binary-junk.bin', junk);
}

if (require.main === module && process.argv.indexOf('--build') !== -1) {
  build();
  process.stdout.write('trace fixtures written to ' + DIR + '\n');
}

module.exports = { build: build, FRAMES: FRAMES, mulberry32: mulberry32, DIR: DIR };
