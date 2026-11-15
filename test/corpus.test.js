'use strict';
// The DBC corpus: every file of test/fixtures/corpus is read and checked against the expectations
// that were written by hand into manifest.json when the file was designed (counts of messages and
// signals, the exact list of problem codes). A database of 10,000 messages is built at test time.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../src/dbc/parse');
const V = require('../src/dbc/validate');
const M = require('../src/dbc/mux');
const U = require('../src/util');
const G = require('./helpers/gen-dbc');

const DIR = path.join(__dirname, 'fixtures', 'corpus');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));

function load(file) {
  const bytes = fs.readFileSync(path.join(DIR, file));
  const decoded = U.decodeBytes(bytes);
  return { bytes: bytes, text: decoded.text, encoding: decoded.encoding };
}
function signalCount(db) {
  let n = 0;
  for (const m of db.messages) n += m.signals.length;
  return n;
}
function realMessages(db) { return db.messages.filter(function (m) { return !m.pseudo; }); }
function codesOf(result) { return result.problems.map(function (p) { return p.code; }).sort(); }

test('the corpus has at least 44 original files and every file in the folder is in the manifest', () => {
  assert.ok(manifest.files.length >= 44, 'files: ' + manifest.files.length);
  const listed = new Set(manifest.files.map(function (f) { return f.file; }));
  const onDisk = fs.readdirSync(DIR).filter(function (f) { return f.endsWith('.dbc'); });
  assert.deepEqual(onDisk.sort(), Array.from(listed).sort());
  for (const f of manifest.files) assert.ok(f.description && f.description.length > 10, f.file + ' has a description');
  assert.equal(new Set(manifest.files.map(function (f) { return f.file; })).size, manifest.files.length);
});

for (const entry of manifest.files) {
  test('corpus ' + entry.file + ': ' + entry.description.slice(0, 70), () => {
    const f = load(entry.file);
    assert.equal(f.bytes.length, entry.bytes, 'size on disk');
    assert.equal(f.encoding, entry.encoding, 'encoding label');
    const db = P.parseDbc(f.text);
    assert.equal(realMessages(db).length, entry.messages, 'messages');
    assert.equal(signalCount(db), entry.signals, 'signals attached to messages');
    assert.equal(db.orphanSignals.length, entry.orphans, 'signals without a message');
    const result = V.validate(db, { text: f.text, maxProblems: 1000000 });
    assert.deepEqual(codesOf(result), entry.expectCodes.slice().sort(), 'problem codes');
    assert.equal(result.counts.error === 0, entry.noErrors, 'noErrors');
    assert.equal(result.dropped, 0);
    // Every reported range lies inside the text and names something that is really there.
    for (const p of result.problems) {
      assert.ok(p.start >= 0 && p.end >= p.start && p.end <= f.text.length + 1, entry.file + ' ' + p.code + ' range ' + p.start + '-' + p.end);
      assert.equal(p.severity, V.CODES[p.code]);
      assert.ok(p.message.length > 10);
    }
    // Every message and signal starts at its keyword and its name is at the recorded offsets.
    for (const m of db.messages) {
      assert.equal(f.text.slice(m.start, m.start + 3), 'BO_');
      assert.equal(f.text.slice(m.nameStart, m.nameEnd), m.name);
      assert.equal(f.text.slice(m.idStart, m.idEnd), m.idText);
      for (const s of m.signals) {
        assert.equal(f.text.slice(s.start, s.start + 3), 'SG_');
        assert.equal(f.text.slice(s.nameStart, s.nameEnd), s.name);
      }
    }
  });
}

test('the four line-end variants of the same database parse to the same structure', () => {
  const names = ['31-line-ends-lf.dbc', '32-line-ends-crlf.dbc', '33-line-ends-cr.dbc', '34-bom-utf8.dbc'];
  const shape = function (file) {
    const db = P.parseDbc(load(file).text);
    return JSON.stringify({
      version: db.version && db.version.text, nodes: db.nodes.map(function (n) { return n.name; }),
      messages: db.messages.map(function (m) { return [m.idText, m.name, m.size, m.sender, m.signals.map(function (s) { return [s.name, s.startBit, s.length, s.little, s.signed, s.factorText, s.offsetText, s.minText, s.maxText, s.unit, s.receivers]; }), m.comment]; })
    });
  };
  const first = shape(names[0]);
  for (const n of names) assert.equal(shape(n), first, n);
  assert.ok(load('32-line-ends-crlf.dbc').bytes.includes(Buffer.from('\r\n')));
  assert.ok(!load('33-line-ends-cr.dbc').bytes.includes(Buffer.from('\n')));
  assert.deepEqual(Array.from(load('34-bom-utf8.dbc').bytes.subarray(0, 3)), [0xEF, 0xBB, 0xBF]);
});

test('the text encodings of the corpus decode to the expected characters', () => {
  const win = load('35-windows-1252.dbc');
  assert.ok(win.bytes.includes(0xB0) && win.bytes.includes(0xE9));
  const dbWin = P.parseDbc(win.text);
  assert.equal(dbWin.messages[0].signals[0].unit, '°C');
  assert.equal(dbWin.messages[0].signals[0].comment, 'Température');
  const utf8 = P.parseDbc(load('36-utf8-text.dbc').text);
  assert.equal(utf8.messages[0].signals[0].unit, '°C');
  assert.equal(utf8.messages[0].signals[0].comment, 'Température Ünicöde – 温度');
  const wide = load('37-utf16le-bom.dbc');
  assert.deepEqual(Array.from(wide.bytes.subarray(0, 2)), [0xFF, 0xFE]);
  assert.equal(P.parseDbc(wide.text).messages[0].signals[0].unit, '°C');
  // The same bytes read as UTF-8 by mistake would hold the replacement character.
  assert.ok(win.bytes.toString('utf8').includes('�'));
});

test('long names: the lengths in the file are the lengths the manifest promises', () => {
  const e = manifest.files.find(function (x) { return x.file === '46-long-names.dbc'; });
  assert.deepEqual(e.checks, { long33: 33, long64: 64, long40: 40, exact32: 32 });
  const db = P.parseDbc(load('46-long-names.dbc').text);
  assert.deepEqual(db.messages.map(function (m) { return m.name.length; }), [33, 32]);
  assert.equal(db.messages[0].signals[0].name.length, 64);
  assert.equal(db.nodes[0].name.length, 40);
});

test('nothing in the corpus is decoded by the multiplexing analysis with a surprise', () => {
  // The multiplexing files have the multiplexing structure they were designed with.
  const status = function (file, msgName) {
    const db = P.parseDbc(load(file).text);
    const m = db.messages.find(function (x) { return x.name === msgName; });
    const mux = M.analyseMux(m);
    const out = {};
    for (const s of m.signals) out[s.name] = mux.info.get(s).status + ':' + (mux.info.get(s).parent ? mux.info.get(s).parent.name : '-') + ':' + mux.info.get(s).depth;
    return out;
  };
  assert.deepEqual(status('13-multiplex-simple.dbc', 'MuxSimple'), { Sel: 'ok:-:0', A: 'ok:Sel:1', B: 'ok:Sel:1', C: 'ok:Sel:1', D: 'ok:-:0' });
  assert.deepEqual(status('16-multiplex-extended-nested.dbc', 'MuxNested'), { Sel: 'ok:-:0', Sub: 'ok:Sel:1', X: 'ok:Sel:1', Y: 'ok:Sel:1', Z: 'ok:Sub:2', W: 'ok:Sub:2' });
  assert.deepEqual(status('17-multiplex-three-level.dbc', 'MuxThree'), { M0: 'ok:-:0', M1: 'ok:M0:1', M2: 'ok:M1:2', S: 'ok:M2:3', T: 'ok:M0:1' });
  assert.deepEqual(status('18-mux-ambiguous.dbc', 'MuxAmbig'), { Sel1: 'ok:-:0', Sel2: 'ok:-:0', Data: 'bad:-:0' });
  assert.deepEqual(status('20-mux-loop.dbc', 'MuxLoop'), { A: 'cycle:B:0', B: 'cycle:A:0', C: 'parent:A:0' });
});

test('the builder is deterministic and its databases are valid (200 messages, three seeds)', () => {
  for (const seed of [1, 2, 3]) {
    const a = G.generateDbc({ messages: 200, signalsPerMessage: 5, seed: seed, muxShare: 0.15 });
    const b = G.generateDbc({ messages: 200, signalsPerMessage: 5, seed: seed, muxShare: 0.15 });
    assert.equal(a.text, b.text);
    const db = P.parseDbc(a.text);
    assert.equal(realMessages(db).length, 200);
    assert.equal(signalCount(db), a.signals);
    const result = V.validate(db, { text: a.text });
    assert.deepEqual(codesOf(result), []);
    assert.ok(a.muxMessages > 0 && a.extendedMessages > 0, 'the synthetic database has multiplexed and extended messages');
  }
  assert.notEqual(G.generateDbc({ messages: 20, seed: 1 }).text, G.generateDbc({ messages: 20, seed: 2 }).text);
});

test('a database of 10,000 messages is built, read and checked without a single problem', () => {
  const t0 = Date.now();
  const g = G.generateDbc({ messages: 10000, signalsPerMessage: 6, seed: 424242, nodes: 16, extendedShare: 0.3, muxShare: 0.1 });
  const t1 = Date.now();
  const db = P.parseDbc(g.text);
  const t2 = Date.now();
  const result = V.validate(db, { text: g.text });
  const t3 = Date.now();
  assert.equal(realMessages(db).length, 10000);
  assert.equal(signalCount(db), g.signals);
  assert.ok(g.signals > 30000, 'signals: ' + g.signals);
  assert.deepEqual(codesOf(result), []);
  assert.equal(db.problems.length, 0);
  assert.ok(g.extendedMessages > 2500 && g.muxMessages > 600);
  // Two messages with the same ID would be found; the lookup maps hold every message.
  assert.equal(db.messageByRawId.size, 10000);
  assert.equal(db.messageByName.size, 10000);
  process.stdout.write('# 10,000 messages (' + Math.round(g.text.length / 1024) + ' KB, ' + g.signals + ' signals): generate ' + (t1 - t0) + ' ms, parse ' + (t2 - t1) + ' ms, check ' + (t3 - t2) + ' ms\n');
  assert.ok(t3 - t1 < 20000, 'parse and check took ' + (t3 - t1) + ' ms');
});

test('the 300-message corpus file matches what the builder makes today', () => {
  const g = G.generateDbc({ messages: 300, signalsPerMessage: 6, seed: 20261112, nodes: 12, version: 'synthetic-300' });
  assert.equal(load('53-synthetic-300.dbc').text, g.text);
});
