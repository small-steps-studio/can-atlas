'use strict';
// Encoding physical values into frames and decoding them again. The frames are also checked bit by
// bit against the separately written reference writer, and the error messages are checked.

const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../src/dbc/parse');
const C = require('../src/dbc/codec');
const ref = require('./helpers/ref-decoder');
const G = require('./helpers/gen-dbc');

function randBig(rnd, bits) {
  let v = 0n;
  for (let i = 0; i < bits + 16; i += 16) v = v * 65536n + BigInt(Math.floor(rnd() * 65536));
  return v;
}
function pickFrom(rnd, list) { return list[Math.floor(rnd() * list.length)]; }

const FACTORS = ['1', '1', '0.5', '0.1', '0.01', '0.001', '2', '10', '-1', '-0.25', '1e-05', '3', '0.0625', '100000', '0.3', '-0.001'];
const OFFSETS = ['0', '0', '0', '-40', '100', '-273.15', '0.5', '1000000', '-0.001'];

/** Scaled integer form of a decimal text: { n, s } with value = n / 10^s. */
function scaled(text) { return G.decOf(G.plainDecimal(text)); }

/** Builds one random message of non-overlapping signals; returns { text, specs }. */
function randomMessage(rnd, id, size, onlyWide) {
  const specs = [];
  const lines = ['BU_: Tx Rx', 'BO_ ' + id + ' R' + id + ': ' + size + ' Tx'];
  let used = 0; // bits used in the linear (Motorola) or physical (Intel) numbering of this message
  const little = rnd() < 0.5;
  for (let k = 0; k < 12; k++) {
    let len;
    const r = rnd();
    if (onlyWide) len = r < 0.5 ? 64 : 48 + Math.floor(rnd() * 17); else len = r < 0.1 ? 1 : r < 0.2 ? 64 : 1 + Math.floor(rnd() * 32);
    if (used + len > size * 8) { if (specs.length) break; len = Math.min(len, size * 8); }
    const signed = len > 1 && rnd() < 0.4;
    const factor = pickFrom(rnd, FACTORS);
    const offset = pickFrom(rnd, OFFSETS);
    const start = little ? used : G.motorolaStart(used);
    const values = len <= 8 && rnd() < 0.3 ? [] : null;
    if (values) {
      const lo = signed ? -(1n << BigInt(len - 1)) : 0n;
      const hi = signed ? (1n << BigInt(len - 1)) - 1n : (1n << BigInt(len)) - 1n;
      const seen = new Set();
      for (let j = 0; j < 3; j++) {
        const v = lo + randBig(rnd, len) % (hi - lo + 1n);
        if (!seen.has(v.toString())) { seen.add(v.toString()); values.push([v, 'Level' + (v < 0n ? 'M' + (-v) : v)]); }
      }
    }
    const name = 'Sg' + k;
    specs.push({ name: name, start: start, len: len, little: little, signed: signed, factor: factor, offset: offset, values: values });
    lines.push(' SG_ ' + name + ' : ' + start + '|' + len + '@' + (little ? 1 : 0) + (signed ? '-' : '+') + ' (' + factor + ',' + offset + ') [0|0] "" Rx');
    used += len;
    if (len === 64) break;
  }
  for (const s of specs) if (s.values) lines.push('VAL_ ' + id + ' ' + s.name + ' ' + s.values.map(function (e) { return e[0] + ' "' + e[1] + '"'; }).join(' ') + ' ;');
  return { text: lines.join('\n') + '\n', specs: specs };
}

test('encode then decode returns every value within half a step (5,000 random signals, up to 64 bits, both byte orders)', () => {
  const rnd = G.mulberry32(77031);
  let signals = 0;
  let exact = 0;
  let rounded = 0;
  let described = 0;
  let id = 1;
  while (signals < 5000) {
    const wide = rnd() < 0.15;
    const size = wide ? 8 : pickFrom(rnd, [8, 8, 8, 12, 16, 24, 32, 64]);
    const msg = randomMessage(rnd, id++, size, wide);
    const db = P.parseDbc(msg.text);
    const m = db.messages[0];
    const inputs = new Map();
    const want = [];
    for (const s of msg.specs) {
      const lo = s.signed ? -(1n << BigInt(s.len - 1)) : 0n;
      const hi = s.signed ? (1n << BigInt(s.len - 1)) - 1n : (1n << BigInt(s.len)) - 1n;
      const sizeOfRange = hi - lo + 1n;
      const f = scaled(s.factor);
      const o = scaled(s.offset);
      const S = Math.max(f.s, o.s);
      const F = f.n * 10n ** BigInt(S - f.s);
      const O = o.n * 10n ** BigInt(S - o.s);
      const absF = F < 0n ? -F : F;
      // A raw value strictly inside the range, so that a rounding step cannot leave it.
      const r = sizeOfRange >= 3n ? lo + 1n + randBig(rnd, s.len) % (sizeOfRange - 2n) : lo;
      const byName = s.values && rnd() < 0.5;
      if (byName) {
        const e = s.values[Math.floor(rnd() * s.values.length)];
        const text = rnd() < 0.5 ? e[1] : e[1].toUpperCase();
        inputs.set(s.name, text);
        want.push({ spec: s, byName: true, raw: e[0], text: e[1] });
        continue;
      }
      // The requested value lies within half a step of raw value r (the ends of the step included).
      const half = absF / 2n;
      const cap = half < 1000000n ? half : 1000000n;
      const dd = sizeOfRange < 3n ? 0n : BigInt(Math.floor(rnd() * (Number(cap) * 2 + 1))) - cap;
      const requested = r * F + O + dd;
      inputs.set(s.name, G.decText(requested, S));
      want.push({ spec: s, byName: false, requested: requested, S: S, F: F, O: O, raw: r });
    }
    const enc = C.encodeMessage(db, m, inputs);
    assert.deepEqual(enc.errors, [], msg.text + JSON.stringify(Array.from(inputs)));
    assert.equal(enc.bytes.length, size);
    // The frame holds exactly the bits of the reference writer.
    const expectBytes = new Uint8Array(size);
    for (const w of want) {
      const s = w.spec;
      const rowRaw = BigInt(enc.rows[msg.specs.indexOf(s)].rawText);
      const pattern = rowRaw < 0n ? rowRaw + (1n << BigInt(s.len)) : rowRaw;
      ref.writeBits(expectBytes, s.start, s.len, s.little, pattern);
    }
    assert.deepEqual(Array.from(enc.bytes), Array.from(expectBytes), 'frame bytes');
    // And decoding gives the value back.
    const dec = C.decodeMessage(m, enc.bytes, enc.bytes.length);
    for (const w of want) {
      const s = w.spec;
      const row = dec.rows[msg.specs.indexOf(s)];
      assert.equal(row.status, 'ok');
      if (w.byName) {
        assert.equal(row.rawText, w.raw.toString());
        assert.equal(row.text, w.text);
        described++;
        continue;
      }
      const d = G.decOf(row.physical);
      const got = d.n * 10n ** BigInt(w.S - d.s);
      let diff = got - w.requested;
      if (diff < 0n) diff = -diff;
      assert.ok(diff * 2n <= (w.F < 0n ? -w.F : w.F), s.name + ': requested ' + G.decText(w.requested, w.S) + ', decoded ' + row.physical + ', step ' + s.factor);
      if (diff === 0n) exact++; else rounded++;
      // The raw value found is the nearest one: within one of the raw value the request was built from.
      const rawDiff = BigInt(row.rawText) - w.raw;
      assert.ok(rawDiff >= -1n && rawDiff <= 1n, 'raw ' + row.rawText + ' vs ' + w.raw);
    }
    signals += msg.specs.length;
  }
  assert.ok(signals >= 5000);
  assert.ok(exact > 500 && rounded > 500 && described > 100, 'exact ' + exact + ', rounded ' + rounded + ', by description ' + described);
  process.stdout.write('# round trip: ' + signals + ' signals (' + exact + ' exact, ' + rounded + ' rounded, ' + described + ' by description)\n');
});

test('float signals: values survive the round trip as the nearest float', () => {
  const rnd = G.mulberry32(1357);
  let n = 0;
  for (let round = 0; round < 300; round++) {
    const text = ['BU_: Tx Rx', 'BO_ 1 F: 16 Tx', ' SG_ F32 : 0|32@1+ (1,0) [0|0] "" Rx', ' SG_ F64 : 64|64@1+ (1,0) [0|0] "" Rx', ' SG_ M32 : 39|32@0+ (1,0) [0|0] "" Rx',
      'SIG_VALTYPE_ 1 F32 : 1;', 'SIG_VALTYPE_ 1 F64 : 2;', 'SIG_VALTYPE_ 1 M32 : 1;', ''].join('\n');
    const db = P.parseDbc(text);
    const a = ((rnd() - 0.5) * 2000).toFixed(Math.floor(rnd() * 6));
    const b = ((rnd() - 0.5) * 2e6).toFixed(Math.floor(rnd() * 10));
    const c = String(Math.floor(rnd() * 1000) / 8);
    const enc = C.encodeMessage(db, db.messages[0], { F32: a, F64: b, M32: c });
    assert.deepEqual(enc.errors, []);
    const dec = C.decodeMessage(db.messages[0], enc.bytes, 16);
    assert.equal(Math.fround(Number(dec.rows[0].rawText)) + 0, Math.fround(Number(a)) + 0);
    assert.equal(Number(dec.rows[1].rawText), Number(b) + 0);
    assert.equal(Math.fround(Number(dec.rows[2].rawText)) + 0, Math.fround(Number(c)) + 0);
    n += 3;
  }
  assert.equal(n, 900);
});

test('a float that single precision cannot hold exactly says so; one it can hold says nothing', () => {
  const db = P.parseDbc(['BU_: Tx Rx', 'BO_ 1 F: 8 Tx', ' SG_ F32 : 0|32@1+ (1,0) [0|0] "" Rx', 'SIG_VALTYPE_ 1 F32 : 1;', ''].join('\n'));
  let e = C.encodeMessage(db, db.messages[0], { F32: '16777217' });
  assert.equal(e.rows[0].rawText, '16777216');
  assert.equal(e.rows[0].note, 'stored as the nearest float, 16777216');
  e = C.encodeMessage(db, db.messages[0], { F32: '0.1' });
  assert.equal(e.rows[0].note, '');
  e = C.encodeMessage(db, db.messages[0], { F32: '1013.25' });
  assert.equal(e.rows[0].note, '');
  e = C.encodeMessage(db, db.messages[0], { F32: '1e39' });
  assert.match(e.errors[0], /outside the range of a 32-bit float/);
});

test('float signals with a factor and an offset: 10 with factor 2 and offset 1 is stored as 4.5', () => {
  const db = P.parseDbc(['BU_: Tx Rx', 'BO_ 1 F: 8 Tx', ' SG_ G : 0|32@1+ (2,1) [0|0] "" Rx', 'SIG_VALTYPE_ 1 G : 1;', ''].join('\n'));
  const enc = C.encodeMessage(db, db.messages[0], { G: '10' });
  assert.deepEqual(enc.errors, []);
  assert.equal(enc.rows[0].rawText, '4.5');
  assert.equal(enc.rows[0].physical, '10');
  // 4.5 = 0x40900000, little-endian 00 00 90 40
  assert.deepEqual(Array.from(enc.bytes.subarray(0, 4)), [0x00, 0x00, 0x90, 0x40]);
  const dec = C.decodeMessage(db.messages[0], enc.bytes, 8);
  assert.equal(dec.rows[0].physical, '10');
});

const SAMPLE = ['BU_: Tx Rx', 'BO_ 256 Msg: 8 Tx',
  ' SG_ U8 : 0|8@1+ (1,0) [0|255] "" Rx',
  ' SG_ S8 : 8|8@1- (1,0) [-128|127] "" Rx',
  ' SG_ Quarter : 16|8@1+ (0.25,0) [0|63.75] "x" Rx',
  ' SG_ Temp : 24|8@1+ (1,-40) [-40|215] "degC" Rx',
  ' SG_ Pct : 32|8@1+ (1,0) [0|100] "%" Rx',
  ' SG_ Big : 40|8@1+ (1,0) [0|255] "" Rx',
  'VAL_ 256 Big 1 "One" 300 "TooBig" ;', ''].join('\n');

test('values that do not fit give clear errors that name the signal and the raw range', () => {
  const db = P.parseDbc(SAMPLE);
  const m = db.messages[0];
  let e = C.encodeMessage(db, m, { U8: '256' });
  assert.equal(e.ok, false);
  assert.match(e.errors[0], /U8: 256 needs the raw value 256, but its 8 unsigned bits hold 0 to 255 \(physical 0 to 255\)/);
  e = C.encodeMessage(db, m, { S8: '-129' });
  assert.match(e.errors[0], /S8: -129 needs the raw value -129, but its 8 signed bits hold -128 to 127/);
  e = C.encodeMessage(db, m, { S8: '-128' });
  assert.deepEqual(e.errors, []);
  assert.equal(e.bytes[1], 0x80);
  e = C.encodeMessage(db, m, { S8: '127' });
  assert.equal(e.bytes[1], 0x7F);
  e = C.encodeMessage(db, m, { U8: 'abc' });
  assert.match(e.errors[0], /U8: "abc" is neither a number nor one of its value descriptions/);
  e = C.encodeMessage(db, m, { Nope: '1' });
  assert.match(e.errors[0], /The message Msg has no signal "Nope"/);
  e = C.encodeMessage(db, m, { Big: '"Missing"' });
  assert.match(e.errors[0], /Big has no value description "Missing"/);
  e = C.encodeMessage(db, m, { Big: 'toobig' });
  assert.match(e.errors[0], /"TooBig" stands for the raw value 300, which Big cannot hold/);
  e = C.encodeMessage(db, m, { Temp: '216' });
  assert.match(e.errors[0], /Temp: 216 needs the raw value 256/);
  assert.match(e.errors[0], /physical -40 to 215/);
  // Nothing is written for a signal with an error; the others are still encoded.
  e = C.encodeMessage(db, m, { U8: '300', Quarter: '1' });
  assert.equal(e.ok, false);
  assert.equal(e.bytes[0], 0);
  assert.equal(e.bytes[2], 4);
});

test('64-bit limits: the largest unsigned value is accepted, one more is refused', () => {
  const db = P.parseDbc(['BU_: Tx Rx', 'BO_ 1 W: 8 Tx', ' SG_ W64 : 0|64@1+ (1,0) [0|18446744073709551615] "" Rx', ''].join('\n'));
  let e = C.encodeMessage(db, db.messages[0], { W64: '18446744073709551615' });
  assert.deepEqual(e.errors, []);
  assert.deepEqual(Array.from(e.bytes), [255, 255, 255, 255, 255, 255, 255, 255]);
  e = C.encodeMessage(db, db.messages[0], { W64: '18446744073709551616' });
  assert.match(e.errors[0], /needs the raw value 18446744073709551616/);
  const sdb = P.parseDbc(['BU_: Tx Rx', 'BO_ 1 W: 8 Tx', ' SG_ W64 : 7|64@0- (1,0) [0|0] "" Rx', ''].join('\n'));
  e = C.encodeMessage(sdb, sdb.messages[0], { W64: '-9223372036854775808' });
  assert.deepEqual(Array.from(e.bytes), [0x80, 0, 0, 0, 0, 0, 0, 0]);
  e = C.encodeMessage(sdb, sdb.messages[0], { W64: '-1' });
  assert.deepEqual(Array.from(e.bytes), [255, 255, 255, 255, 255, 255, 255, 255]);
  e = C.encodeMessage(sdb, sdb.messages[0], { W64: '9223372036854775808' });
  assert.equal(e.ok, false);
});

test('rounding is shown, halves round away from zero', () => {
  const db = P.parseDbc(SAMPLE);
  const m = db.messages[0];
  let e = C.encodeMessage(db, m, { Quarter: '0.26' });
  assert.equal(e.rows[2].rawText, '1');
  assert.equal(e.rows[2].physical, '0.25');
  assert.equal(e.rows[2].note, 'rounded to 0.25');
  e = C.encodeMessage(db, m, { Quarter: '0.125' });
  assert.equal(e.rows[2].rawText, '1', 'a half rounds away from zero');
  e = C.encodeMessage(db, m, { Quarter: '0.124999' });
  assert.equal(e.rows[2].rawText, '0');
  e = C.encodeMessage(db, m, { Quarter: '0.25' });
  assert.equal(e.rows[2].note, '');
  const sdb = P.parseDbc(['BU_: Tx Rx', 'BO_ 1 W: 8 Tx', ' SG_ N : 0|8@1- (0.25,0) [-32|31.75] "" Rx', ''].join('\n'));
  const neg = C.encodeMessage(sdb, sdb.messages[0], { N: '-0.125' });
  assert.equal(neg.rows[0].rawText, '-1');
  assert.equal(neg.rows[0].physical, '-0.25');
  assert.equal(neg.bytes[0], 0xFF);
});

test('a value outside the declared range of the signal is encoded and warned about', () => {
  const db = P.parseDbc(SAMPLE);
  const e = C.encodeMessage(db, db.messages[0], { Pct: '120' });
  assert.equal(e.ok, true);
  assert.equal(e.bytes[4], 120);
  assert.equal(e.warnings.length, 1);
  assert.match(e.warnings[0], /Pct: 120 is outside its range \[0\|100\]; it is encoded anyway/);
});

test('signals that are not given start at the raw value 0 and the row says so (GenSigStartValue is not interpreted)', () => {
  const text = SAMPLE + ['BA_DEF_ SG_ "GenSigStartValue" INT 0 65535;', 'BA_DEF_DEF_ "GenSigStartValue" 0;', 'BA_ "GenSigStartValue" SG_ 256 Temp 90;', ''].join('\n');
  const db = P.parseDbc(text);
  const e = C.encodeMessage(db, db.messages[0], {});
  assert.equal(e.ok, true);
  assert.equal(e.frameText, '100#0000000000000000');
  const temp = e.rows[3];
  assert.equal(temp.source, 'zero');
  assert.equal(temp.rawText, '0');
  assert.equal(temp.physical, '-40');
  for (const row of e.rows) assert.equal(row.source, 'zero');
  const given = C.encodeMessage(db, db.messages[0], { Temp: '25' });
  assert.equal(given.rows[3].source, 'given');
  assert.equal(given.rows[3].rawText, '65');
  assert.equal(given.rows[3].physical, '25');
});

test('frame text: three hex digits for standard and eight for extended identifiers, data in capital hex', () => {
  const db = P.parseDbc(['BU_: Tx Rx', 'BO_ 2566844672 Ext: 4 Tx', ' SG_ A : 0|16@1+ (1,0) [0|0] "" Rx', 'BO_ 291 Std: 3 Tx', ' SG_ B : 0|16@1+ (1,0) [0|0] "" Rx', ''].join('\n'));
  assert.equal(C.encodeMessage(db, db.messages[0], { A: '43981' }).frameText, '18FEF100#CDAB0000');
  assert.equal(C.encodeMessage(db, db.messages[1], { B: '255' }).frameText, '123#FF0000');
});

test('multiplexed messages: only the signals selected by the multiplexor value are encoded, the others are named in a warning', () => {
  const text = ['BU_: Tx Rx', 'BO_ 5 Mx: 8 Tx', ' SG_ Sel M : 0|8@1+ (1,0) [0|255] "" Rx', ' SG_ A m0 : 8|16@1+ (1,0) [0|65535] "" Rx', ' SG_ B m1 : 8|16@1+ (0.1,0) [0|6553.5] "" Rx',
    ' SG_ C : 56|8@1+ (1,0) [0|255] "" Rx', ''].join('\n');
  const db = P.parseDbc(text);
  const m = db.messages[0];
  let e = C.encodeMessage(db, m, { Sel: '1', B: '466', A: '5', C: '153' });
  assert.equal(e.frameText, '005#0134120000000099');
  assert.equal(e.rows[1].note, 'not present: present when Sel = 0');
  assert.equal(e.rows[1].encoded, false);
  assert.equal(e.warnings.length, 1);
  assert.match(e.warnings[0], /A is not encoded: it is present when Sel = 0/);
  const dec = C.decodeMessage(m, e.bytes, 8);
  assert.equal(dec.rows[2].physical, '466');
  assert.equal(dec.rows[1].status, 'absent');
  // The multiplexor defaults to raw 0, which selects A.
  e = C.encodeMessage(db, m, { A: '4660' });
  assert.equal(e.frameText, '005#0034120000000000');
  // Extended multiplexing: nested.
  const nested = P.parseDbc(['BU_: Tx Rx', 'BO_ 6 Nx: 8 Tx', ' SG_ Sel M : 0|4@1+ (1,0) [0|15] "" Rx', ' SG_ Sub m1M : 4|4@1+ (1,0) [0|15] "" Rx', ' SG_ Y m1 : 8|8@1+ (1,0) [0|255] "" Rx',
    ' SG_ W m2 : 24|8@1+ (1,0) [0|255] "" Rx', 'SG_MUL_VAL_ 6 Y Sel 1-1;', 'SG_MUL_VAL_ 6 W Sub 2-2;', ''].join('\n'));
  e = C.encodeMessage(nested, nested.messages[0], { Sel: '1', Sub: '2', Y: '170', W: '204' });
  assert.equal(e.frameText, '006#21AA00CC00000000');
  const d2 = C.decodeMessage(nested.messages[0], e.bytes, 8);
  assert.equal(d2.rows[3].rawText, '204');
  e = C.encodeMessage(nested, nested.messages[0], { Sel: '2', Sub: '2', Y: '170' });
  assert.match(e.warnings.join(' '), /Sub is not encoded/);
  assert.equal(e.bytes[0], 2);
});

test('signals that overlap are warned about, many signals do not make the warning list explode', () => {
  const db = P.parseDbc(['BU_: Tx Rx', 'BO_ 1 O: 8 Tx', ' SG_ A : 0|16@1+ (1,0) [0|0] "" Rx', ' SG_ B : 8|16@1+ (1,0) [0|0] "" Rx', ''].join('\n'));
  const e = C.encodeMessage(db, db.messages[0], { A: '1', B: '2' });
  assert.deepEqual(e.warnings, ['B overlaps A; the bits written last win.']);
  const lines = ['BU_: Tx Rx', 'BO_ 1 Many: 8 Tx'];
  for (let k = 0; k < 1000; k++) lines.push(' SG_ S' + k + ' : 0|8@1+ (1,0) [0|0] "" Rx');
  const many = P.parseDbc(lines.join('\n') + '\n');
  const t0 = Date.now();
  const r = C.encodeMessage(many, many.messages[0], {});
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(r.warnings.length <= 25, 'warnings: ' + r.warnings.length);
  assert.match(r.warnings[r.warnings.length - 1], /more than 300 signals/);
});

test('a factor of 0 cannot encode, and a signal that does not fit the data length is said to be skipped', () => {
  const db = P.parseDbc(['BU_: Tx Rx', 'BO_ 1 Z: 2 Tx', ' SG_ Zero : 0|8@1+ (0,0) [0|0] "" Rx', ' SG_ Far : 24|8@1+ (1,0) [0|0] "" Rx', ''].join('\n'));
  const e = C.encodeMessage(db, db.messages[0], { Zero: '5', Far: '1' });
  assert.match(e.errors[0], /Zero has the factor 0, so no value can be encoded/);
  assert.match(e.warnings[0], /Far does not fit into the 2 data bytes and is not encoded/);
  assert.equal(e.rows[1].encoded, false);
});

test('value descriptions are found by name without regard to case and with or without quotes', () => {
  const db = P.parseDbc(['BU_: Tx Rx', 'BO_ 1 D: 8 Tx', ' SG_ Gear : 0|4@1+ (1,0) [0|7] "" Rx', 'VAL_ 1 Gear 3 "Drive" 0 "Park" ;', ''].join('\n'));
  for (const input of ['Drive', 'drive', 'DRIVE', '"Drive"', ' drive ', '3']) {
    const e = C.encodeMessage(db, db.messages[0], { Gear: input });
    assert.deepEqual(e.errors, [], input);
    assert.equal(e.bytes[0], 3, input);
  }
});
