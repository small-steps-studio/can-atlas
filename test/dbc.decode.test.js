'use strict';
// Decoding frames with the codec. The vectors in test/fixtures/decode/*.json were computed by hand
// (each carries the arithmetic in its "how" text). A separately written reference decoder checks
// the raw values of every vector again and 20,000 random signal layouts in frames of 1 to 64 bytes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../src/dbc/parse');
const C = require('../src/dbc/codec');
const U = require('../src/util');
const ref = require('./helpers/ref-decoder');
const G = require('./helpers/gen-dbc');

const FIX = path.join(__dirname, 'fixtures');
const dbCache = new Map();
function corpusDb(file) {
  let db = dbCache.get(file);
  if (!db) { db = P.parseDbc(U.decodeBytes(fs.readFileSync(path.join(FIX, 'corpus', file))).text); dbCache.set(file, db); }
  return db;
}
function hexBytes(text) {
  const parts = text.trim() ? text.trim().split(/\s+/) : [];
  return Uint8Array.from(parts.map(function (h) { return parseInt(h, 16); }));
}
function frameOf(v) {
  if (v.fill) {
    const b = new Uint8Array(v.fill.length);
    for (const k of Object.keys(v.fill.bytes)) b[Number(k)] = parseInt(v.fill.bytes[k], 16);
    return b;
  }
  return hexBytes(v.data);
}

const vectorFiles = fs.readdirSync(path.join(FIX, 'decode')).filter(function (f) { return f.endsWith('.json'); }).sort();
const vectors = [];
for (const f of vectorFiles) for (const v of JSON.parse(fs.readFileSync(path.join(FIX, 'decode', f), 'utf8'))) { v.source = f; vectors.push(v); }

test('there are at least 120 hand-computed decode vectors, each with its arithmetic', () => {
  assert.ok(vectors.length >= 120, 'vectors: ' + vectors.length);
  for (const v of vectors) assert.ok(v.how && v.how.length >= 2, v.source + ' ' + v.id + ' has a how');
});

test('every hand-computed vector decodes to the expected values', () => {
  let signalsChecked = 0;
  for (const v of vectors) {
    const db = corpusDb(v.file);
    const m = db.messageByRawId.get(v.id);
    assert.ok(m, v.file + ': no message with ID ' + v.id);
    const bytes = frameOf(v);
    const out = C.decodeMessage(m, bytes, bytes.length);
    for (const name of Object.keys(v.expect)) {
      const want = v.expect[name];
      const row = out.rows.find(function (r) { return r.signal.name === name; });
      const label = v.file + ' ' + v.id + ' [' + Array.from(bytes).map(function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(' ') + '] ' + name;
      assert.ok(row, label + ': no such signal');
      if (want.status) { assert.equal(row.status, want.status, label + ' status'); signalsChecked++; continue; }
      assert.equal(row.status, 'ok', label + ' status (' + (row.reason || '') + ')');
      if (want.raw !== undefined) assert.equal(row.rawText, want.raw, label + ' raw');
      if (want.physical !== undefined) assert.equal(row.physical, want.physical, label + ' physical');
      if (want.text !== undefined) assert.equal(row.text, want.text, label + ' text');
      signalsChecked++;
    }
  }
  assert.ok(signalsChecked > 350, 'signal values checked: ' + signalsChecked);
  process.stdout.write('# ' + vectors.length + ' vectors, ' + signalsChecked + ' signal values checked\n');
});

test('the raw values written into the vectors agree with the separately written reference decoder', () => {
  let checked = 0;
  for (const v of vectors) {
    const db = corpusDb(v.file);
    const m = db.messageByRawId.get(v.id);
    const bytes = frameOf(v);
    for (const name of Object.keys(v.expect)) {
      const want = v.expect[name];
      if (want.raw === undefined) continue;
      const s = m.signalIndex.get(name);
      if (s.valueType !== 0) continue;
      assert.equal(ref.rawText(bytes, s.startBit, s.length, s.little, s.signed), want.raw, v.file + ' ' + v.id + ' ' + name);
      checked++;
    }
  }
  assert.ok(checked > 200, 'checked ' + checked);
});

/** Writes a decimal in exponent form (1e-05) as plain digits (0.00001). */
function plain(text) {
  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (!m) return text;
  let digits = m[2] + (m[3] || '');
  let point = m[2].length + Number(m[4]);
  if (point <= 0) { digits = '0'.repeat(1 - point) + digits; point = 1; }
  while (digits.length < point) digits += '0';
  const whole = digits.slice(0, point);
  const frac = digits.slice(point);
  return m[1] + whole + (frac ? '.' + frac : '');
}

test('physical values of integer signals equal raw x factor + offset in exact decimal arithmetic', () => {
  for (const v of vectors) {
    const db = corpusDb(v.file);
    const m = db.messageByRawId.get(v.id);
    const bytes = frameOf(v);
    const out = C.decodeMessage(m, bytes, bytes.length);
    for (const row of out.rows) {
      if (row.status !== 'ok' || row.signal.valueType !== 0) continue;
      const s = row.signal;
      assert.equal(row.physical, G.physical(BigInt(row.rawText), plain(s.factorText), plain(s.offsetText)), v.file + ' ' + s.name);
    }
  }
});

function rngInt(rnd, lo, hi) { return lo + Math.floor(rnd() * (hi - lo + 1)); }

test('20,000 random layouts agree with the reference decoder (Intel and Motorola, 1 to 64 bits, 1 to 64 byte frames)', () => {
  const rnd = G.mulberry32(20261112);
  let layouts = 0;
  let comparisons = 0;
  let shortCount = 0;
  let beyond = 0;
  for (let round = 0; round < 100; round++) {
    const n = rngInt(rnd, 1, 64);
    const sigs = [];
    const lines = ['BU_: Tx Rx', 'BO_ 1 R: ' + n + ' Tx'];
    for (let k = 0; k < 200; k++) {
      const little = rnd() < 0.5;
      const signed = rnd() < 0.5;
      const r = rnd();
      const len = r < 0.1 ? 64 : r < 0.2 ? 1 : r < 0.3 ? rngInt(rnd, 56, 63) : rngInt(rnd, 1, 64);
      const loose = rnd() < 0.15;
      let start;
      if (little) start = loose ? rngInt(rnd, 0, 8 * n + 8) : rngInt(rnd, 0, Math.max(0, 8 * n - len));
      else start = loose ? rngInt(rnd, 0, 8 * n + 16) : rngInt(rnd, 0, 8 * n - 1);
      sigs.push({ name: 'S' + k, start: start, len: len, little: little, signed: signed });
      lines.push(' SG_ S' + k + ' : ' + start + '|' + len + '@' + (little ? 1 : 0) + (signed ? '-' : '+') + ' (1,0) [0|0] "" Rx');
    }
    const db = P.parseDbc(lines.join('\n') + '\n');
    const m = db.messages[0];
    assert.equal(m.signals.length, 200);
    for (let f = 0; f < 10; f++) {
      const pattern = f === 0 ? 0 : f === 1 ? 255 : -1;
      const len = rnd() < 0.2 ? rngInt(rnd, 0, n) : n;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = pattern >= 0 ? pattern : rngInt(rnd, 0, 255);
      const out = C.decodeMessage(m, bytes, bytes.length);
      for (let k = 0; k < sigs.length; k++) {
        const s = sigs[k];
        const row = out.rows[k];
        const want = ref.rawText(bytes, s.start, s.len, s.little, s.signed);
        const positions = ref.bitPositions(s.start, s.len, s.little);
        const outside64 = positions.some(function (p) { return p >= 512; });
        if (outside64) { assert.equal(row.status, 'undecodable', 'beyond 64 bytes'); beyond++; continue; }
        if (want === null) { assert.equal(row.status, 'short', 'start ' + s.start + ' len ' + s.len + ' frame ' + len); shortCount++; continue; }
        assert.equal(row.status, 'ok');
        assert.equal(row.rawText, want, 'round ' + round + ' signal ' + JSON.stringify(s) + ' frame ' + Array.from(bytes).join(','));
        assert.equal(row.bits.toString(), ref.rawPattern(bytes, s.start, s.len, s.little));
        comparisons++;
      }
    }
    layouts += sigs.length;
  }
  assert.equal(layouts, 20000);
  assert.ok(comparisons > 100000, 'value comparisons: ' + comparisons);
  assert.ok(shortCount > 1000 && beyond > 100, 'short ' + shortCount + ', beyond ' + beyond);
  process.stdout.write('# reference decoder: ' + layouts + ' layouts, ' + comparisons + ' values compared, ' + shortCount + ' short, ' + beyond + ' beyond 64 bytes\n');
});

test('known awkward layouts match the reference decoder bit lists written out by hand', () => {
  // Motorola start 7, 16 bits: bits 7..0 of byte 0 then bits 7..0 of byte 1.
  assert.deepEqual(ref.bitPositions(7, 16, false), [7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8]);
  // Motorola start 0, 8 bits: bit 0 of byte 0, then bits 7..1 of byte 1.
  assert.deepEqual(ref.bitPositions(0, 8, false), [0, 15, 14, 13, 12, 11, 10, 9]);
  // Motorola start 4, 20 bits.
  assert.deepEqual(ref.bitPositions(4, 20, false), [4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8, 23, 22, 21, 20, 19, 18, 17]);
  // Intel start 5, 9 bits, most significant first.
  assert.deepEqual(ref.bitPositions(5, 9, true), [13, 12, 11, 10, 9, 8, 7, 6, 5]);
});

test('signal rows carry the signal, the plan and a reason for every status that is not ok', () => {
  const db = corpusDb('13-multiplex-simple.dbc');
  const m = db.messageByRawId.get(1100);
  const out = C.decodeMessage(m, hexBytes('01 34 12 07 00 00 00 99'), 8);
  const a = out.rows.find(function (r) { return r.signal.name === 'A'; });
  assert.equal(a.status, 'absent');
  assert.match(a.reason, /present when Sel = 0/);
  const short = C.decodeMessage(m, hexBytes('00 34'), 2);
  const c = short.rows.find(function (r) { return r.signal.name === 'D'; });
  assert.equal(c.status, 'short');
  assert.match(c.reason, /frame has 2 data bytes; the signal needs 8/);
  const amb = corpusDb('18-mux-ambiguous.dbc');
  const row = C.decodeMessage(amb.messageByRawId.get(1105), hexBytes('21 55'), 2).rows.find(function (r) { return r.signal.name === 'Data'; });
  assert.equal(row.status, 'undecodable');
  assert.match(row.reason, /several multiplexors/);
});

test('signals the codec cannot read are never decoded by guess', () => {
  const text = [
    'BU_: A B', 'BO_ 1 M: 8 A',
    ' SG_ OutOfFrame : 60|16@1+ (1,0) [0|0] "" B',
    ' SG_ ZeroLength : 0|0@1+ (1,0) [0|0] "" B',
    ' SG_ Huge : 0|65@1+ (1,0) [0|0] "" B',
    ' SG_ BadFloat : 0|16@1+ (1,0) [0|0] "" B',
    ' SG_ BadScale : 0|8@1+ (1e999,0) [0|0] "" B',
    ' SG_ Fine : 0|8@1+ (1,0) [0|0] "" B',
    'SIG_VALTYPE_ 1 BadFloat : 1;', ''].join('\n');
  const db = P.parseDbc(text);
  const out = C.decodeMessage(db.messages[0], hexBytes('05 00 00 00 00 00 00 00'), 8);
  const by = {};
  for (const r of out.rows) by[r.signal.name] = r;
  assert.equal(by.OutOfFrame.status, 'short');
  assert.equal(by.ZeroLength.status, 'undecodable');
  assert.equal(by.Huge.status, 'undecodable');
  assert.equal(by.BadFloat.status, 'undecodable');
  assert.match(by.BadFloat.reason, /float type does not match/);
  assert.equal(by.BadScale.status, 'undecodable');
  assert.match(by.BadScale.reason, /factor or offset/);
  assert.equal(by.Fine.status, 'ok');
  assert.equal(by.Fine.rawText, '5');
});

test('frame identifiers are written as candump writes them', () => {
  const db = corpusDb('22-extended-ids.dbc');
  assert.equal(C.frameIdText(db.messageByRawId.get(2566844672)), '18FEF100');
  assert.equal(C.frameIdText(db.messageByRawId.get(2147483649)), '00000001');
  assert.equal(C.frameIdText(db.messageByRawId.get(2684354559)), '1FFFFFFF');
  assert.equal(C.frameIdText(db.messageByRawId.get(2047)), '7FF');
  assert.equal(C.frameIdText(db.messageByRawId.get(0)), '000');
});

test('scaledText writes exact integers divided by powers of ten', () => {
  assert.equal(C.scaledText(5, 1), '0.5');
  assert.equal(C.scaledText(-5, 1), '-0.5');
  assert.equal(C.scaledText(0, 3), '0');
  assert.equal(C.scaledText(100, 2), '1');
  assert.equal(C.scaledText(123456, 3), '123.456');
  assert.equal(C.scaledText(7, 0), '7');
  assert.equal(C.scaledText(-1200n, 2), '-12');
  assert.equal(C.scaledText(18446744073709551615000n, 3), '18446744073709551615');
  assert.equal(C.scaledText(1n, 5), '0.00001');
});

test('the physical value uses the exact path for 64-bit signals with fractional factors', () => {
  const db = corpusDb('06-wide-signals.dbc');
  const m = db.messageByRawId.get(1028);
  const out = C.decodeMessage(m, hexBytes('FF FF FF FF FF FF FF FF'), 8);
  assert.equal(out.rows[0].physical, '18446744073709551.615');
  // One less: 18446744073709551614 x 0.001 = 18446744073709551.614
  const less = C.decodeMessage(m, hexBytes('FE FF FF FF FF FF FF FF'), 8);
  assert.equal(less.rows[0].physical, '18446744073709551.614');
  // A float result for the same raw value would have been 18446744073709552 (binary floating point).
  assert.notEqual(String(Number('18446744073709551615') * 0.001), '18446744073709551.615');
});

test('the exact path takes over where a double can no longer hold the physical value (2^53)', () => {
  const text = ['BU_: Tx Rx', 'BO_ 1 Edge: 8 Tx',
    ' SG_ Fits : 0|53@1+ (1,0) [0|0] "" Rx',
    'BO_ 2 Over: 8 Tx',
    ' SG_ Raw54 : 0|54@1+ (1,0) [0|0] "" Rx',
    'BO_ 3 Offs: 8 Tx',
    ' SG_ Plus1 : 0|53@1+ (1,1) [0|0] "" Rx',
    'BO_ 4 Big: 8 Tx',
    ' SG_ Wide : 0|32@1+ (4294967296,0) [0|0] "" Rx',
    'BO_ 5 Neg: 8 Tx',
    ' SG_ Low : 0|54@1- (1,0) [0|0] "" Rx', ''].join('\n');
  const d = P.parseDbc(text);
  const at = function (id, hex) { const m = d.messageByRawId.get(id); return C.decodeMessage(m, hexBytes(hex), 8).rows[0]; };
  // 53 bits all set = 2^53 - 1 = 9007199254740991, the largest integer a double holds exactly.
  assert.equal(at(1, 'FF FF FF FF FF FF 1F 00').physical, '9007199254740991');
  // 54 bits all set = 2^54 - 1 = 18014398509481983 (a double would give ...984).
  assert.equal(at(2, 'FF FF FF FF FF FF 3F 00').physical, '18014398509481983');
  assert.equal(at(2, 'FF FF FF FF FF FF 3F 00').rawText, '18014398509481983');
  // 2^53 - 1 plus the offset 1 = 2^53 = 9007199254740992.
  assert.equal(at(3, 'FF FF FF FF FF FF 1F 00').physical, '9007199254740992');
  assert.equal(at(3, 'FE FF FF FF FF FF 1F 00').physical, '9007199254740991');
  // (2^32 - 1) x 2^32 = 2^64 - 2^32 = 18446744069414584320.
  assert.equal(at(4, 'FF FF FF FF 00 00 00 00').physical, '18446744069414584320');
  // 54 signed bits, all ones = -1; the pattern 0x20000000000000 (bit 53) is the lowest value -2^53 = -9007199254740992.
  assert.equal(at(5, 'FF FF FF FF FF FF 3F 00').physical, '-1');
  assert.equal(at(5, '00 00 00 00 00 00 20 00').physical, '-9007199254740992');
  assert.equal(at(5, 'FF FF FF FF FF FF 1F 00').physical, '9007199254740991');
});
