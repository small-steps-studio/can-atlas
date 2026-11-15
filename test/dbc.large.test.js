'use strict';
// Large inputs: a database of 10,000 messages with 12 signals each, and a message of 64 bytes with
// 512 one-bit signals. Values are worked out by hand from the way the builder function lays the signals out.

const test = require('node:test');
const assert = require('node:assert/strict');
const v8 = require('node:v8');
const vm = require('node:vm');
const P = require('../src/dbc/parse');
const V = require('../src/dbc/validate');
const C = require('../src/dbc/codec');
const D = require('../src/dbc/describe');
const O = require('../src/dbc/outline');
const L = require('../src/dbc/layout');
const H = require('./helpers/hostile');

v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc');

const MESSAGES = 10000;
let shared = null;

function database() {
  if (shared) return shared;
  gc();
  const before = process.memoryUsage().heapUsed;
  const text = H.bigDbc(MESSAGES, 12);
  const parsed = H.timed(function () { return P.parseDbc(text); });
  const checked = H.timed(function () { return V.validate(parsed.value, { text: text }); });
  gc();
  const growth = (process.memoryUsage().heapUsed - before) / 1048576;
  shared = { text: text, db: parsed.value, result: checked.value, parseMs: parsed.ms, validateMs: checked.ms, growthMB: growth };
  return shared;
}

test('10,000 messages with 12 signals are read and checked in a few seconds with no problem', (t) => {
  const s = database();
  t.diagnostic('database of ' + (s.text.length / 1048576).toFixed(2) + ' MB: parse ' + s.parseMs.toFixed(0) + ' ms, validate ' + s.validateMs.toFixed(0) + ' ms, heap growth ' + s.growthMB.toFixed(0) + ' MB');
  assert.equal(s.db.messages.length, MESSAGES);
  assert.equal(s.db.messages.reduce(function (n, m) { return n + m.signals.length; }, 0), MESSAGES * 12);
  assert.deepEqual(s.result.problems.map(function (p) { return p.code; }), []);
  assert.ok(s.parseMs < 10000, 'parse took ' + s.parseMs.toFixed(0) + ' ms');
  assert.ok(s.validateMs < 10000, 'validate took ' + s.validateMs.toFixed(0) + ' ms');
  assert.ok(s.growthMB < 400, 'heap grew by ' + s.growthMB.toFixed(0) + ' MB');
});

test('the first 2,000 messages have standard IDs and the others extended IDs', () => {
  const { db } = database();
  assert.equal(db.messages[0].extended, false);
  assert.equal(db.messages[1999].frameId, 2000);
  assert.equal(db.messages[2000].extended, true);
  assert.equal(db.messages[2000].frameId, 2000);
  assert.equal(db.messages[9999].rawId, 2147483648 + 9999);
});

test('outline: messages are listed by ID in pages of 500', () => {
  const { db } = database();
  const roots = O.rootNodes(db);
  assert.deepEqual(roots.map(function (n) { return n.kind + ':' + n.detail; }), ['messages:10000', 'nodes:10', 'valueTables:0']);
  const pages = O.childrenOf(db, roots[0]);
  assert.equal(O.PAGE, 500);
  assert.equal(pages.length, 20);
  assert.equal(pages[0].label, 'Messages 1 to 500');
  assert.equal(pages[0].detail, '0x1 to 0x1F4');
  assert.equal(pages[19].label, 'Messages 9501 to 10000');
  const first = O.childrenOf(db, pages[0]);
  assert.equal(first.length, 500);
  assert.equal(first[0].label, '0x1 Msg0');
  assert.equal(first[499].label, '0x1F4 Msg499');
  assert.equal(first[0].detail, '8 bytes · N0 · 12 signals');
  const signals = O.childrenOf(db, first[0]);
  assert.equal(signals.length, 12);
  assert.equal(signals[0].label, 'Sig0');
  assert.equal(signals[0].detail, '0|8@1+ unit');
  const last = O.childrenOf(db, pages[19]);
  assert.equal(last[499].label, '0x270F Msg9999', 'extended messages come after the standard ones, by frame ID (the label shows the frame ID without the flag bit)');
  assert.ok(last[0].offset > first[0].offset || last[0].offset >= 0);
  const all = O.messagesById(db);
  assert.equal(all.length, MESSAGES);
  assert.equal(all[1999].extended, false);
  assert.equal(all[2000].extended, true);
  for (let k = 1; k < all.length; k++) {
    const a = all[k - 1];
    const b = all[k];
    assert.ok(a.extended < b.extended || (a.extended === b.extended && a.frameId < b.frameId), 'order at ' + k);
  }
});

test('outline: document symbols are in text order with ranges inside the text', () => {
  const { db, text } = database();
  const symbols = O.symbols(db);
  assert.equal(symbols.length, 1 + MESSAGES);
  assert.equal(symbols[0].name, 'Nodes');
  assert.equal(symbols[0].children.length, 10);
  let previous = -1;
  for (const s of symbols) {
    assert.ok(s.start >= previous, 'symbols are sorted');
    previous = s.start;
    assert.ok(s.start <= s.end && s.end <= text.length);
    assert.ok(s.selStart >= s.start && s.selEnd <= s.end, s.name);
  }
  assert.equal(symbols[1].children.length, 12);
  assert.equal(O.messageItems(db).length, MESSAGES);
});

test('hover lookup at 1,000 random offsets and on 1,000 names is fast and finds the right element', (t) => {
  const { db, text } = database();
  const rnd = H.rng(99);
  const r = H.timed(function () {
    let found = 0;
    for (let k = 0; k < 1000; k++) {
      const el = D.elementAt(db, rnd.int(text.length));
      if (el) { found++; assert.equal(typeof D.hoverOf(db, el), 'string'); }
    }
    for (let k = 0; k < 1000; k++) {
      const m = db.messages[rnd.int(MESSAGES)];
      const s = m.signals[rnd.int(12)];
      const onSignal = D.elementAt(db, s.nameStart + 1);
      assert.equal(onSignal.kind, 'signal');
      assert.equal(onSignal.signal, s);
      assert.equal(text.slice(onSignal.start, onSignal.end), s.name);
      assert.equal(onSignal.definition, true);
      const onMessage = D.elementAt(db, m.nameStart);
      assert.equal(onMessage.kind, 'message');
      assert.equal(onMessage.message, m);
      assert.equal(D.messageAt(db, s.nameStart), m);
      assert.deepEqual(D.definitionOf(db, onSignal), { start: s.nameStart, end: s.nameEnd });
    }
    return found;
  });
  t.diagnostic('1,000 random offsets and 1,000 names: ' + r.ms.toFixed(0) + ' ms, ' + r.value + ' random offsets hit an element');
  assert.ok(r.ms < 5000, 'took ' + r.ms.toFixed(0) + ' ms');
  assert.ok(r.value > 300);
});

test('hovers of a signal in the middle of the database state bits, scaling and range', () => {
  const { db } = database();
  const intel = db.messages[4];
  const motorola = db.messages[5];
  const intelNibble = D.hoverOf(db, { kind: 'signal', message: intel, signal: intel.signals[6] });
  assert.match(intelNibble, /4 bits, little\\-endian \\\(Intel\\\): start bit 40 is the least significant bit; bits 40 to 43, byte 5/);
  assert.match(intelNibble, /physical = raw × 0\.5 − 3/);
  assert.match(intelNibble, /raw 0 to 15 gives \\-3 to 4\.5 unit/);
  const moto = D.hoverOf(db, { kind: 'signal', message: motorola, signal: motorola.signals[6] });
  assert.match(moto, /4 bits, big\\-endian \\\(Motorola\\\): start bit 47 is the most significant bit; it runs down to bit 44, byte 5/);
});

test('every message is decoded to the values worked out by hand', (t) => {
  const { db } = database();
  const frame = Uint8Array.from([10, 20, 30, 40, 0x21, 0x43, 0x65, 0x87]);
  const intelWanted = ['2', '7', '12', '17', '-2.5', '-2', '-1.5', '-1', '-0.5', '0', '0.5', '1'];
  // Big-endian nibbles: an even nibble number is the upper half of its byte, an odd one the lower half.
  const motorolaWanted = ['2', '7', '12', '17', '-2', '-2.5', '-1', '-1.5', '0', '-0.5', '1', '0.5'];
  const r = H.timed(function () {
    for (let i = 0; i < MESSAGES; i++) {
      const m = db.messages[i];
      const rows = C.decodeMessage(m, frame, 8).rows;
      assert.equal(rows.length, 12);
      const wanted = i % 2 === 0 ? intelWanted : motorolaWanted;
      for (let k = 0; k < 12; k++) {
        if (rows[k].status !== 'ok' || rows[k].physical !== wanted[k]) assert.fail('message ' + i + ' signal ' + k + ': ' + rows[k].status + ' ' + rows[k].physical + ' instead of ' + wanted[k]);
      }
    }
  });
  t.diagnostic('decoded ' + MESSAGES + ' messages: ' + r.ms.toFixed(0) + ' ms');
  assert.ok(r.ms < 10000);
  const sample = C.decodeMessage(db.messages[0], frame, 8).rows;
  assert.equal(sample[0].rawText, '10');
  assert.equal(sample[4].rawText, '1');
  assert.equal(sample[11].rawText, '8');
});

test('encoding the decoded values gives the frame back', () => {
  const { db } = database();
  const frame = [10, 20, 30, 40, 0x21, 0x43, 0x65, 0x87];
  for (const i of [0, 1, 1999, 2000, 5000, 9998, 9999]) {
    const m = db.messages[i];
    const rows = C.decodeMessage(m, Uint8Array.from(frame), 8).rows;
    const inputs = {};
    for (const row of rows) inputs[row.signal.name] = row.physical;
    const enc = C.encodeMessage(db, m, inputs);
    assert.equal(enc.ok, true, 'message ' + i);
    assert.deepEqual(Array.from(enc.bytes), frame, 'message ' + i);
    assert.equal(enc.frameText, (m.extended ? m.frameId.toString(16).toUpperCase().padStart(8, '0') : m.frameId.toString(16).toUpperCase().padStart(3, '0')) + '#0A141E28 21436587'.replace(' ', ''));
  }
});

test('the layout text of a message with 12 signals has one row per byte', () => {
  const { db } = database();
  const md = L.layoutMarkdown(db, db.messages[0]);
  const rows = md.split('\n').filter(function (l) { return /^\| \d+ \|/.test(l); });
  assert.equal(rows.length, 8);
  assert.deepEqual(H.tableCells(rows[0]).map(function (c) { return c.trim(); }), ['0', 'A ▲', 'A', 'A', 'A', 'A', 'A', 'A', 'A ▼']);
});

// ---- a message with 512 one-bit signals ------------------------------------------------------------------

function bitsDatabase(order) {
  const lines = ['VERSION ""', '', 'BS_:', '', 'BU_: N', '', 'BO_ 1 Bits: 64 N'];
  for (let k = 0; k < 512; k++) lines.push(' SG_ B' + k + ' : ' + k + '|1@' + order + '+ (1,0) [0|1] "" N');
  lines.push('');
  const text = lines.join('\n');
  return { text: text, db: P.parseDbc(text) };
}

test('a message of 64 bytes with 512 one-bit signals is decoded bit by bit', () => {
  for (const order of ['1', '0']) {
    const { db, text } = bitsDatabase(order);
    const m = db.messages[0];
    assert.equal(V.validate(db, { text: text }).problems.length, 0, 'no problem for order ' + order);
    const rnd = H.rng(5 + Number(order));
    for (let round = 0; round < 20; round++) {
      const bytes = new Uint8Array(64);
      for (let i = 0; i < 64; i++) bytes[i] = rnd.int(256);
      const rows = C.decodeMessage(m, bytes, 64).rows;
      for (let k = 0; k < 512; k++) {
        const want = (bytes[k >> 3] >> (k & 7)) & 1;
        if (rows[k].status !== 'ok' || rows[k].rawText !== String(want)) assert.fail('order ' + order + ' bit ' + k + ': ' + rows[k].status + ' ' + rows[k].rawText + ' instead of ' + want);
      }
      const inputs = {};
      for (let k = 0; k < 512; k++) inputs['B' + k] = rows[k].rawText;
      const enc = C.encodeMessage(db, m, inputs);
      assert.equal(enc.ok, true);
      assert.deepEqual(Array.from(enc.bytes), Array.from(bytes), 'round trip for order ' + order);
      assert.equal(enc.warnings.length <= 1, true, 'the overlap warnings are capped');
    }
  }
});

test('the layout text of that message names every bit and has no gaps', () => {
  const { db } = bitsDatabase('1');
  const m = db.messages[0];
  const md = L.layoutMarkdown(db, m);
  const rows = md.split('\n').filter(function (l) { return /^\| \d+ \|/.test(l); });
  assert.equal(rows.length, 64);
  assert.deepEqual(H.tableCells(rows[0]).map(function (c) { return c.trim(); }), ['0', 'H', 'G', 'F', 'E', 'D', 'C', 'B', 'A']);
  assert.deepEqual(H.tableCells(rows[63]).map(function (c) { return c.trim(); }), ['63', L.keyOf(511), L.keyOf(510), L.keyOf(509), L.keyOf(508), L.keyOf(507), L.keyOf(506), L.keyOf(505), L.keyOf(504)]);
  assert.equal(rows.join('\n').includes('·'), false, 'every bit is used');
  assert.equal(L.keyOf(0), 'A');
  assert.equal(L.keyOf(25), 'Z');
  assert.equal(L.keyOf(26), 'AA');
  assert.equal(L.keyOf(27), 'AB');
  assert.equal(L.keyOf(51), 'AZ');
  assert.equal(L.keyOf(52), 'BA');
  assert.equal(L.keyOf(701), 'ZZ');
  assert.equal(L.keyOf(702), 'AAA');
  const lay = L.layoutOf(m);
  assert.equal(lay.bytes, 64);
  assert.equal(lay.groups.length, 1);
  assert.equal(lay.groups[0].overlaps, 0);
});
