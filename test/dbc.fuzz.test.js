'use strict';
// Seeded mutation fuzz of the whole DBC pipeline: reader, checks, decode and encode, hover and
// lookup, outline and symbols, bit layout and multiplexing groups. Nothing may throw, every
// position must lie inside the text, every code must be a known code, and the same text must give
// the same problems twice.
//
// The seed is fixed. To repeat another run set CAN_ATLAS_FUZZ_SEED; to run more rounds set
// CAN_ATLAS_FUZZ_ROUNDS; to replay one failing round set CAN_ATLAS_FUZZ_ROUND (the failing text is
// also written to the temporary folder).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../src/dbc/parse');
const V = require('../src/dbc/validate');
const C = require('../src/dbc/codec');
const D = require('../src/dbc/describe');
const O = require('../src/dbc/outline');
const L = require('../src/dbc/layout');
const M = require('../src/dbc/mux');
const U = require('../src/util');
const { sampleFor } = require('../src/samples');
const H = require('./helpers/hostile');

const SEED = Number(process.env.CAN_ATLAS_FUZZ_SEED) || 20261112;
const TOTAL = Number(process.env.CAN_ATLAS_FUZZ_ROUNDS) || 2000;
const ONLY = process.env.CAN_ATLAS_FUZZ_ROUND === undefined ? -1 : Number(process.env.CAN_ATLAS_FUZZ_ROUND);

const MUX_BASE = [
  'VERSION "x"', '', 'BS_:', '', 'BU_: A B C', '',
  'VAL_TABLE_ Gear 2 "Two" 1 "One" 0 "Zero" ;',
  'BO_ 100 Pages: 8 A',
  ' SG_ Sel M : 0|8@1+ (1,0) [0|255] "" B',
  ' SG_ Lo m0 : 8|16@1- (0.1,-5) [-3276.8|3276.7] "V" B,C',
  ' SG_ Hi m1 : 8|16@0+ (0.25,0) [0|16383.75] "rpm" B',
  ' SG_ Big m2M : 8|8@1+ (1,0) [0|255] "" B',
  ' SG_ Leaf m3 : 16|32@1+ (1,0) [0|0] "" B',
  ' SG_ Flt : 40|24@1+ (1,0) [0|0] "" B',
  'BO_ 2566869221 Ext: 8 B',
  ' SG_ F32 : 0|32@1- (1,0) [0|0] "x" A',
  ' SG_ F64 : 0|64@1+ (1,0) [0|0] "x" A',
  ' SG_ Wide : 3|60@0+ (0.001,0) [0|0] "" A',
  'BO_ 7 Plain: 3 C',
  ' SG_ S : 0|12@1- (1,0) [-2048|2047] "" A',
  ' SG_ T : 12|1@1+ (1,0) [0|1] "" A',
  'CM_ "net";', 'CM_ BU_ A "node";', 'CM_ BO_ 100 "msg";', 'CM_ SG_ 100 Sel "sig\nover two lines";',
  'BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;', 'BA_DEF_ SG_ "Kind" ENUM "a","b";', 'BA_DEF_ "Bus" STRING ;',
  'BA_DEF_DEF_ "GenMsgCycleTime" 0;', 'BA_DEF_DEF_ "Kind" "a";', 'BA_DEF_DEF_ "Bus" "";',
  'BA_ "Bus" "CAN";', 'BA_ "GenMsgCycleTime" BO_ 100 20;', 'BA_ "Kind" SG_ 100 Sel 1;',
  'VAL_ 100 Sel 2 "Two" 1 "One" 0 "Zero" ;', 'VAL_ 7 S -1 "minus" ;',
  'SIG_VALTYPE_ 2566869221 F32 : 1;', 'SIG_VALTYPE_ 2566869221 F64 : 2;',
  'BO_TX_BU_ 100 : B,C;', 'SG_MUL_VAL_ 100 Leaf Big 4-6, 9-9;', 'SG_MUL_VAL_ 100 Big Sel 2-2;', ''
].join('\n');

const BASES = [{ name: 'sample valid', text: sampleFor('valid').text }, { name: 'sample problems', text: sampleFor('problems').text }, { name: 'multiplexing base', text: MUX_BASE }]
  .concat(H.corpusFiles().filter(function (f) { return f.text.length <= 120000; }).map(function (f) { return { name: 'corpus ' + f.name, text: f.text }; }));

const KEYWORDS = ['BO_', 'SG_', 'VAL_', 'CM_', 'BA_', 'BA_DEF_', 'BA_DEF_DEF_', 'VAL_TABLE_', 'BU_', 'BS_', 'NS_', 'VERSION', 'SG_MUL_VAL_', 'SIG_VALTYPE_', 'BO_TX_BU_', 'EV_', 'SGTYPE_',
  'm0M', 'm1', 'M', ';', '"', '\\', '\\"', '|', '@', '(', ')', '[', ']', ',', ':', '-', '+', '1+', '0-', '@1+', '@0-', '(1,0)', '[0|1]', 'Vector__XXX', 'VECTOR__INDEPENDENT_SIG_MSG', 'INT', 'ENUM', 'FLOAT', 'STRING', 'HEX', '\n', '\r\n', '\r', ' ', '\t'];
const NUMBERS = ['0', '1', '-1', '8', '64', '65', '99999999999999999999', '18446744073709551616', '4294967295', '4294967296', '2147483648', '2147483647', '9007199254740993', '1e400', '1E-5', '1e999999', '.5', '5.', '-0', '0x10', '+7', '1.5e3', '000', '3-5', '-'];

function randomUnicode(rnd) {
  switch (rnd.int(9)) {
    case 0: return '\u0000';
    case 1: return String.fromCharCode(0xD800 + rnd.int(0x800));
    case 2: return String.fromCharCode(0x80 + rnd.int(0x700));
    case 3: return String.fromCharCode(0x800 + rnd.int(0xD000));
    case 4: return String.fromCodePoint(0x10000 + rnd.int(0xFFFFF));
    case 5: return rnd.pick(['﻿', ' ', ' ', '‮', '\u0085', ' ']);
    case 6: return String.fromCharCode(1 + rnd.int(31));
    case 7: return String.fromCharCode(0xE000 + rnd.int(0x1FFF));
    default: return String.fromCharCode(0x7F + rnd.int(0x81));
  }
}

function mutate(text, rnd, log) {
  let s = text;
  const operations = 1 + rnd.int(6);
  for (let k = 0; k < operations; k++) {
    const len = s.length;
    const i = len ? rnd.int(len + 1) : 0;
    const op = rnd.int(14);
    log.push(op);
    if (op === 0 && len) { s = s.slice(0, i) + s.slice(Math.min(len, i + 1 + rnd.int(200))); }
    else if (op === 1) { s = s.slice(0, i) + rnd.pick(KEYWORDS) + s.slice(i); }
    else if (op === 2 && len) { const a = rnd.int(len); const b = Math.min(len, a + 1 + rnd.int(300)); s = s.slice(0, i) + s.slice(a, b) + s.slice(i); }
    else if (op === 3 && len > 2) { const a = rnd.int(len - 1); const b = Math.min(len, a + 1 + rnd.int(80)); const c = Math.min(len, b + 1 + rnd.int(80)); s = s.slice(0, a) + s.slice(b, c) + s.slice(a, b) + s.slice(c); }
    else if (op === 4 && len) { const j = rnd.int(len); s = s.slice(0, j) + String.fromCharCode(rnd.int(256)) + s.slice(j + 1); }
    else if (op === 5 && len) { s = s.slice(0, rnd.int(len)); }
    else if (op === 6) { s = s.slice(0, i) + rnd.pick(NUMBERS) + s.slice(i); }
    else if (op === 7) { let noise = ''; const n = 1 + rnd.int(50); for (let q = 0; q < n; q++) noise += String.fromCharCode(rnd.int(256)); s = s.slice(0, i) + noise + s.slice(i); }
    else if (op === 8) { let uni = ''; const n = 1 + rnd.int(8); for (let q = 0; q < n; q++) uni += randomUnicode(rnd); s = s.slice(0, i) + uni + s.slice(i); }
    else if (op === 9 && len) { const lines = s.split('\n'); lines.splice(rnd.int(lines.length), 1); s = lines.join('\n'); }
    else if (op === 10 && len) { const lines = s.split('\n'); const j = rnd.int(lines.length); lines.splice(rnd.int(lines.length + 1), 0, lines[j]); s = lines.join('\n'); }
    else if (op === 11 && len) { const lines = s.split('\n'); const a = rnd.int(lines.length); const b = rnd.int(lines.length); const t = lines[a]; lines[a] = lines[b]; lines[b] = t; s = lines.join('\n'); }
    else if (op === 12 && len) { const j = rnd.int(len); s = s.slice(0, j) + s.slice(j, j + 1).toUpperCase() + s.slice(j + 1); }
    else if (op === 13) { s = s.slice(0, i) + rnd.pick(['BO_ ', 'SG_ ', ' SG_ ', 'CM_ "', 'VAL_ 1 ', 'BA_ "x" ']) + rnd.pick(NUMBERS) + ' ' + s.slice(i); }
    if (s.length > 400000) s = s.slice(0, 400000);
  }
  return s;
}

/** Documents made of random statement-like pieces, without a valid base. */
function soup(rnd) {
  const pieces = ['BO_ ' + rnd.pick(NUMBERS) + ' N' + rnd.int(5) + ': ' + rnd.pick(NUMBERS) + ' ' + rnd.pick(['A', 'B', 'Vector__XXX', '']),
    ' SG_ s' + rnd.int(9) + ' ' + rnd.pick(['', 'M', 'm0', 'm1M', 'm' + rnd.pick(NUMBERS)]) + ' : ' + rnd.pick(NUMBERS) + '|' + rnd.pick(NUMBERS) + '@' + rnd.pick(['0', '1', '2']) + rnd.pick(['+', '-', '']) + ' (' + rnd.pick(NUMBERS) + ',' + rnd.pick(NUMBERS) + ') [' + rnd.pick(NUMBERS) + '|' + rnd.pick(NUMBERS) + '] "' + rnd.pick(['', 'V', 'a b']) + '" ' + rnd.pick(['A', 'B,C', 'Vector__XXX', 'Q', '']),
    'VAL_ ' + rnd.pick(NUMBERS) + ' s' + rnd.int(9) + ' ' + rnd.pick(NUMBERS) + ' "' + rnd.pick(['x', 'y z', '']) + '" ;',
    'CM_ ' + rnd.pick(['', 'BO_ ' + rnd.pick(NUMBERS) + ' ', 'SG_ ' + rnd.pick(NUMBERS) + ' s' + rnd.int(9) + ' ', 'BU_ A ']) + '"' + rnd.pick(['text', '', 'a\nb', 'q\\"q']) + '";',
    'BA_DEF_ ' + rnd.pick(['', 'BO_ ', 'SG_ ', 'BU_ ']) + '"a' + rnd.int(3) + '" ' + rnd.pick(['INT 0 9', 'ENUM "p","q"', 'STRING ', 'FLOAT -1 1', 'HEX 0 255']) + ';',
    'BA_ "a' + rnd.int(3) + '" ' + rnd.pick(['', 'BO_ ' + rnd.pick(NUMBERS) + ' ', 'SG_ ' + rnd.pick(NUMBERS) + ' s' + rnd.int(9) + ' ']) + rnd.pick(NUMBERS) + ';',
    'SG_MUL_VAL_ ' + rnd.pick(NUMBERS) + ' s' + rnd.int(9) + ' s' + rnd.int(9) + ' ' + rnd.pick(NUMBERS) + '-' + rnd.pick(NUMBERS) + ', ' + rnd.pick(NUMBERS) + '-' + rnd.pick(NUMBERS) + ';',
    'SIG_VALTYPE_ ' + rnd.pick(NUMBERS) + ' s' + rnd.int(9) + ' : ' + rnd.pick(['0', '1', '2', '3', '99']) + ';',
    'BU_: A B C ' + rnd.pick(['', 'D', 'A']), 'VAL_TABLE_ T' + rnd.int(3) + ' ' + rnd.pick(NUMBERS) + ' "x" ;', 'BO_TX_BU_ ' + rnd.pick(NUMBERS) + ' : A,B;', 'VERSION "' + rnd.pick(['', 'v1']) + '"', 'NS_ :', 'BS_:', ''];
  const count = 5 + rnd.int(60);
  const lines = [];
  for (let k = 0; k < count; k++) lines.push(rnd.pick(pieces));
  return lines.join(rnd.pick(['\n', '\r\n', '\n\n', ' ']));
}

const SIGNAL_STATUS = new Set(['ok', 'absent', 'short', 'undecodable']);
const DECIMAL = /^-?\d+(\.\d+)?$/;
const INPUTS = ['0', '1', '-1', '255', '1e3', 'abc', '"Park"', 'Zero', 'One', '1e400', '', '99999999999999999999', '-0', '.5', '0.1', '-128', '4294967295', '"', '\u0000'];

function checkText(text, rnd, label) {
  // reader and checks
  const db = P.parseDbc(text);
  const result = V.validate(db, { text: text });
  const listed = result.problems.filter(function (p) { return !(p.code === 'DBC-LIST-CUT' && result.dropped > 0); });
  for (const p of result.problems) {
    assert.ok(V.CODES[p.code], label + ': unknown problem code ' + p.code);
    assert.equal(p.severity, V.CODES[p.code], label + ': severity of ' + p.code);
    assert.ok(Number.isInteger(p.start) && Number.isInteger(p.end), label + ': non-integer position in ' + p.code);
    assert.ok(p.start >= 0 && p.start <= p.end && p.end <= text.length, label + ': ' + p.code + ' range ' + p.start + '-' + p.end + ' of ' + text.length);
    assert.equal(typeof p.message, 'string');
  }
  assert.equal(listed.length + result.dropped, result.counts.error + result.counts.warning + result.counts.info, label + ': counts add up');
  if (!result.dropped) for (const sev of ['error', 'warning', 'info']) assert.equal(result.problems.filter(function (p) { return p.severity === sev; }).length, result.counts[sev], label + ': ' + sev + ' count');
  const again = V.validate(P.parseDbc(text), { text: text });
  assert.equal(JSON.stringify(again.problems), JSON.stringify(result.problems), label + ': the same text gives the same problems');

  // hover, lookup, definition
  const offsets = [0, text.length, Math.max(0, text.length - 1)];
  for (let k = 0; k < 12; k++) offsets.push(text.length ? rnd.int(text.length) : 0);
  for (const off of offsets) {
    const el = D.elementAt(db, off);
    if (!el) continue;
    assert.ok(el.start >= 0 && el.start <= el.end && el.end <= text.length, label + ': element range ' + el.start + '-' + el.end);
    const hover = D.hoverOf(db, el);
    assert.equal(typeof hover, 'string');
    const def = D.definitionOf(db, el);
    if (def) assert.ok(def.start >= 0 && def.start <= def.end && def.end <= text.length, label + ': definition range');
    D.messageAt(db, off);
  }

  // outline, symbols, go to message
  const symbols = O.symbols(db);
  let previous = -1;
  for (const s of symbols) {
    assert.ok(s.start >= previous, label + ': symbols sorted');
    previous = s.start;
    assert.ok(s.start >= 0 && s.start <= s.end && s.end <= text.length, label + ': symbol range ' + s.name);
    assert.ok(s.selStart >= 0 && s.selStart <= s.selEnd && s.selEnd <= text.length, label + ': symbol name range');
    for (const c of s.children) assert.ok(c.start >= 0 && c.start <= c.end && c.end <= text.length && c.selEnd <= text.length, label + ': child range');
  }
  for (const root of O.rootNodes(db)) {
    const kids = O.childrenOf(db, root);
    for (const kid of kids.slice(0, 4)) O.childrenOf(db, kid);
  }
  O.messageItems(db);

  // codec, layout, multiplexing groups on the first messages
  const messages = db.messages.filter(function (m) { return m.signals.length <= 3000; }).slice(0, 8);
  let layouts = 0;
  for (const m of messages) {
    const len = rnd.int(65);
    const bytes = new Uint8Array(len);
    for (let q = 0; q < len; q++) bytes[q] = rnd.int(256);
    const out = C.decodeMessage(m, bytes, len);
    assert.equal(out.rows.length, m.signals.length);
    for (const row of out.rows) {
      assert.ok(SIGNAL_STATUS.has(row.status), label + ': status ' + row.status);
      if (row.status === 'ok') {
        assert.equal(typeof row.rawText, 'string');
        assert.ok(DECIMAL.test(row.physical) || /^(NaN|-?Infinity)$/.test(row.physical), label + ': physical value ' + JSON.stringify(row.physical));
        assert.equal(typeof D.valueSummary(row), 'string');
      } else assert.equal(typeof row.reason, 'string');
    }
    const inputs = {};
    for (const s of m.signals.slice(0, 20)) if (rnd.int(3)) inputs[s.name] = rnd.pick(INPUTS);
    if (rnd.int(4) === 0) inputs.NoSuchSignal = '1';
    const enc = C.encodeMessage(db, m, inputs);
    assert.equal(typeof enc.ok, 'boolean');
    assert.ok(enc.bytes instanceof Uint8Array);
    assert.ok(Array.isArray(enc.errors) && Array.isArray(enc.warnings));
    assert.match(enc.frameText, /^[0-9A-F]+#[0-9A-F]*$/);
    if (enc.ok) {
      const back = C.decodeMessage(m, enc.bytes, enc.bytes.length);
      assert.equal(back.rows.length, m.signals.length);
    }
    const g = M.groupsOf(m);
    assert.ok(g.groups.length >= 1);
    if (layouts < 3) { assert.equal(typeof L.layoutMarkdown(db, m), 'string'); layouts++; }
  }
  return { db: db, result: result };
}

function failWith(round, text, error) {
  let file = '';
  try {
    file = path.join(os.tmpdir(), 'can-atlas-fuzz-' + SEED + '-round-' + round + '.dbc');
    fs.writeFileSync(file, text, 'utf8');
  } catch (e) { file = '(could not be written)'; }
  error.message = 'seed ' + SEED + ', round ' + round + ' (text written to ' + file + '): ' + error.message;
  throw error;
}

test('mutated sample databases (' + Math.round(TOTAL * 0.75) + ' rounds, seed ' + SEED + ')', (t) => {
  const rounds = Math.round(TOTAL * 0.75);
  const start = process.hrtime.bigint();
  let problems = 0;
  let changed = 0;
  for (let round = 0; round < rounds; round++) {
    if (ONLY >= 0 && round !== ONLY) continue;
    const rnd = H.rng(SEED + round * 7919);
    const base = rnd.pick(BASES);
    const log = [];
    const text = mutate(base.text, rnd, log);
    if (text !== base.text) changed++;
    try {
      const r = checkText(text, rnd, base.name + ' [' + log.join(',') + ']');
      problems += r.result.problems.length;
    } catch (e) { failWith(round, text, e); }
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  t.diagnostic('fuzz: ' + rounds + ' mutation rounds over ' + BASES.length + ' base files, seed ' + SEED + ', ' + changed + ' changed texts, ' + problems + ' problems seen, ' + ms.toFixed(0) + ' ms');
  assert.ok(ONLY >= 0 || changed > rounds * 0.9);
  assert.ok(ms < 60000, 'took ' + ms.toFixed(0) + ' ms');
});

test('documents made of random statement pieces (' + Math.round(TOTAL * 0.15) + ' rounds, seed ' + SEED + ')', (t) => {
  const rounds = Math.round(TOTAL * 0.15);
  let problems = 0;
  for (let round = 0; round < rounds; round++) {
    if (ONLY >= 0 && round !== ONLY) continue;
    const rnd = H.rng(SEED * 3 + round * 104729);
    const text = soup(rnd);
    try { problems += checkText(text, rnd, 'soup').result.problems.length; } catch (e) { failWith('soup-' + round, text, e); }
  }
  t.diagnostic('fuzz: ' + rounds + ' soup rounds, ' + problems + ' problems seen');
  assert.ok(ONLY >= 0 || problems > rounds);
});

test('random bytes and text decoding (' + Math.round(TOTAL * 0.1) + ' rounds, seed ' + SEED + ')', (t) => {
  const rounds = Math.round(TOTAL * 0.1);
  for (let round = 0; round < rounds; round++) {
    if (ONLY >= 0 && round !== ONLY) continue;
    const rnd = H.rng(SEED * 5 + round * 15485863);
    const len = rnd.int(4000);
    const bytes = Buffer.alloc(len);
    const mode = rnd.int(4);
    for (let i = 0; i < len; i++) bytes[i] = mode === 0 ? rnd.int(256) : mode === 1 ? 32 + rnd.int(95) : mode === 2 ? rnd.pick([0, 10, 13, 34, 59, 124, 64, 40, 41, 66, 79, 95, 83, 71]) : rnd.int(256);
    if (mode === 3 && len > 4) { const base = Buffer.from(rnd.pick(BASES).text, 'latin1'); base.copy(bytes, 0, 0, Math.min(base.length, len)); for (let q = 0; q < 10; q++) bytes[rnd.int(len)] = rnd.int(256); }
    const decoded = U.decodeBytes(bytes);
    assert.equal(typeof decoded.text, 'string');
    try { checkText(decoded.text, rnd, 'bytes mode ' + mode); } catch (e) { failWith('bytes-' + round, decoded.text, e); }
  }
  t.diagnostic('fuzz: ' + rounds + ' byte rounds');
});

test('the fuzz inputs include the corpus when it exists', (t) => {
  t.diagnostic('fuzz base files: ' + BASES.map(function (b) { return b.name; }).join(', '));
  assert.ok(BASES.length >= 3);
});
