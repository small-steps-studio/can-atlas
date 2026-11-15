'use strict';
// Builds the DBC corpus and generates databases of any size for tests.
//
//   node test/helpers/gen-dbc.js --build     writes test/fixtures/corpus/*.dbc and manifest.json
//
// Nothing is written unless --build is given. The files are original and invented. The manifest
// (expected message and signal counts, expected problem codes) is written here by hand from the design
// of each file; it is never produced by running the extension's own checks.
//
// generateDbc() returns the text of a valid database of a chosen size. It uses its own bit
// allocation (it never calls the extension's code), so it can serve as an independent source of
// well-formed input: signals are placed one after the other and never overlap, every sender and
// receiver is a listed node, every ID and name is unique.

const fs = require('node:fs');
const path = require('node:path');

// ---- small helpers -----------------------------------------------------------------------------

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

const NS_WORDS = ['NS_DESC_', 'CM_', 'BA_DEF_', 'BA_', 'VAL_', 'CAT_DEF_', 'CAT_', 'FILTER', 'BA_DEF_DEF_', 'EV_DATA_', 'ENVVAR_DATA_', 'SGTYPE_', 'SGTYPE_VAL_',
  'BA_DEF_SGTYPE_', 'BA_SGTYPE_', 'SIG_TYPE_REF_', 'VAL_TABLE_', 'SIG_GROUP_', 'SIG_VALTYPE_', 'SIGTYPE_VALTYPE_', 'BO_TX_BU_', 'BA_DEF_REL_', 'BA_REL_',
  'BA_DEF_DEF_REL_', 'BU_SG_REL_', 'BU_EV_REL_', 'BU_BO_REL_', 'SG_MUL_VAL_'];

/** The classic header: VERSION, the NS_ list, BS_ and the node list. */
function head(version, nodes, withNs) {
  const out = ['VERSION "' + version + '"', ''];
  if (withNs !== false) { out.push('NS_ :'); for (const w of NS_WORDS) out.push('\t' + w); out.push(''); out.push('BS_:'); out.push(''); }
  out.push('BU_: ' + nodes.join(' '));
  out.push('');
  return out;
}
function lines() { return Array.prototype.concat.apply([], Array.prototype.slice.call(arguments)).join('\n'); }
function bo(id, name, size, sender) { return 'BO_ ' + id + ' ' + name + ': ' + size + ' ' + sender; }
function sg(name, start, len, order, sign, factor, offset, min, max, unit, receivers, mux) {
  return ' SG_ ' + name + (mux ? ' ' + mux : '') + ' : ' + start + '|' + len + '@' + order + sign + ' (' + factor + ',' + offset + ') [' + min + '|' + max + '] "' + unit + '" ' + receivers;
}
function maxOf(bits) { return ((1n << BigInt(bits)) - 1n).toString(); }
/** Unsigned signal with factor 1: sg() with the full raw range as its range. */
function u(name, start, len, order, receivers, mux) { return sg(name, start, len, order, '+', '1', '0', '0', maxOf(len), '', receivers, mux); }
function s(name, start, len, order, receivers, mux) { const h = 1n << BigInt(len - 1); return sg(name, start, len, order, '-', '1', '0', (-h).toString(), (h - 1n).toString(), '', receivers, mux); }

// ---- exact decimal text for the builder (own implementation, independent of the product) ----

function decOf(text) {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  const frac = m[3] || '';
  return { n: BigInt((m[1] || '') + m[2] + frac), s: frac.length };
}
function decText(n, s) {
  const neg = n < 0n;
  let d = (neg ? -n : n).toString();
  if (s > 0) {
    while (d.length <= s) d = '0' + d;
    let intPart = d.slice(0, d.length - s);
    let frac = d.slice(d.length - s).replace(/0+$/, '');
    d = frac ? intPart + '.' + frac : intPart;
  }
  return (neg && d !== '0' ? '-' : '') + d;
}
/** The physical value of a raw BigInt for factor and offset given as decimal text. */
function physical(raw, factor, offset) {
  const f = decOf(factor);
  const o = decOf(offset);
  const S = Math.max(f.s, o.s);
  const v = raw * f.n * (10n ** BigInt(S - f.s)) + o.n * (10n ** BigInt(S - o.s));
  return decText(v, S);
}
function rangeText(len, signed, factor, offset) {
  const lo = signed ? -(1n << BigInt(len - 1)) : 0n;
  const hi = signed ? (1n << BigInt(len - 1)) - 1n : (1n << BigInt(len)) - 1n;
  const a = physical(lo, factor, offset);
  const b = physical(hi, factor, offset);
  const fa = decOf(a); const fb = decOf(b);
  const S = Math.max(fa.s, fb.s);
  const va = fa.n * (10n ** BigInt(S - fa.s));
  const vb = fb.n * (10n ** BigInt(S - fb.s));
  return va <= vb ? [a, b] : [b, a];
}

/** The DBC start bit of the linear position q of a big-endian bit string (bit 7 of byte 0 is position 0). */
function motorolaStart(q) { return Math.floor(q / 8) * 8 + (7 - (q % 8)); }

// ---- the builder ------------------------------------------------------------------------------

/**
 * Text of a valid database. Options: messages, signalsPerMessage, seed, nodes, extendedShare,
 * muxShare, eol, version. Returns { text, messages, signals, extendedMessages, muxMessages }.
 */
function generateDbc(options) {
  const o = Object.assign({ messages: 10, signalsPerMessage: 6, seed: 1, nodes: 8, extendedShare: 0.2, muxShare: 0.1, eol: '\n', version: 'synthetic' }, options || {});
  const rand = mulberry32(o.seed);
  const pick = function (a) { return a[Math.floor(rand() * a.length)]; };
  const int = function (lo, hi) { return lo + Math.floor(rand() * (hi - lo + 1)); };
  const nodes = [];
  for (let i = 1; i <= o.nodes; i++) nodes.push('Node' + i);
  const body = [];
  const sizes = [8, 8, 8, 8, 4, 6, 2, 12, 16, 24, 32, 64];
  const factors = ['1', '1', '0.5', '0.1', '0.25', '0.01', '2'];
  const offsets = ['0', '0', '0', '-40', '100', '-0.5'];
  const units = ['', 'km/h', 'rpm', 'V', 'A', 'degC', '%'];
  const tables = { 1: ['State2', [[1, 'On'], [0, 'Off']]], 2: ['Mode4', [[3, 'Fault'], [2, 'Hold'], [1, 'Run'], [0, 'Idle']]] };
  const usedTables = new Set();
  let signalTotal = 0;
  let extendedMessages = 0;
  let muxMessages = 0;
  const attributeLines = [];
  const valueLines = [];
  const commentLines = [];

  for (let i = 0; i < o.messages; i++) {
    const extended = i >= 2000 || rand() < o.extendedShare;
    const id = extended ? 2147483648 + 65536 + i : i + 1;
    if (extended) extendedMessages++;
    const mux = rand() < o.muxShare;
    const size = mux ? pick([8, 8, 12, 16, 24, 32, 64]) : pick(sizes);
    const sender = nodes[i % nodes.length];
    const rx = nodes[(i + 1) % nodes.length] + (rand() < 0.4 ? ',' + nodes[(i + 2) % nodes.length] : '');
    body.push(bo(id, 'Msg_' + i, size, sender));
    const order = mux ? 1 : pick([0, 1]);
    const sigs = [];
    function place(name, start, len, ord, mx) {
      const signed = rand() < 0.25 && len > 1;
      const factor = len === 1 ? '1' : pick(factors);
      const offset = len === 1 ? '0' : pick(offsets);
      const r = rangeText(len, signed, factor, offset);
      const unit = len <= 2 ? '' : pick(units);
      body.push(sg(name, start, len, ord, signed ? '-' : '+', factor, offset, r[0], r[1], unit, rx, mx));
      sigs.push({ name: name, len: len, signed: signed });
      signalTotal++;
      if (!signed && len <= 2 && rand() < 0.7) {
        const t = tables[len];
        usedTables.add(len);
        valueLines.push('VAL_ ' + id + ' ' + name + ' ' + t[1].map(function (e) { return e[0] + ' "' + e[1] + '"'; }).join(' ') + ' ;');
      }
    }
    function sequence(prefix, from, to, count, ord, mx) {
      let used = from;
      for (let k = 0; k < count; k++) {
        let len = pick([1, 2, 3, 4, 8, 8, 12, 16]);
        if (used + len > to) len = to - used;
        if (len < 1) break;
        const start = ord === 1 ? used : motorolaStart(used);
        place(prefix + k, start, len, ord, mx);
        used += len;
      }
    }
    if (mux) {
      muxMessages++;
      place('Sig_' + i + '_sel', 0, 8, 1, 'M');
      sequence('Sig_' + i + '_a', 8, 40, Math.min(3, Math.max(1, Math.floor(o.signalsPerMessage / 3))), 1, 'm0');
      sequence('Sig_' + i + '_b', 8, 40, Math.min(3, Math.max(1, Math.floor(o.signalsPerMessage / 3))), 1, 'm1');
      if (size * 8 > 40) sequence('Sig_' + i + '_c', 40, Math.min(size * 8, 72), Math.min(2, Math.max(1, Math.floor(o.signalsPerMessage / 3))), 1, '');
    } else {
      sequence('Sig_' + i + '_', 0, size * 8, o.signalsPerMessage, order, '');
    }
    body.push('');
    attributeLines.push('BA_ "GenMsgCycleTime" BO_ ' + id + ' ' + (10 * int(1, 100)) + ';');
    if (extended) attributeLines.push('BA_ "VFrameFormat" BO_ ' + id + ' 1;');
    if (i % 7 === 0) commentLines.push('CM_ BO_ ' + id + ' "Message number ' + i + ' of the synthetic network.";');
  }
  const out = head(o.version, nodes);
  const tableLines = [];
  for (const k of Object.keys(tables)) if (usedTables.has(Number(k))) tableLines.push('VAL_TABLE_ ' + tables[k][0] + ' ' + tables[k][1].map(function (e) { return e[0] + ' "' + e[1] + '"'; }).join(' ') + ' ;');
  const all = out.concat(tableLines, tableLines.length ? [''] : [], body, commentLines, [
    'BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;', 'BA_DEF_ BO_ "VFrameFormat" ENUM "StandardCAN","ExtendedCAN";',
    'BA_DEF_DEF_ "GenMsgCycleTime" 0;', 'BA_DEF_DEF_ "VFrameFormat" "StandardCAN";'], attributeLines, valueLines, ['']);
  return { text: all.join(o.eol), messages: o.messages, signals: signalTotal, extendedMessages: extendedMessages, muxMessages: muxMessages };
}

// ---- the corpus -----------------------------------------------------------------------------------

// Problem codes of severity "error" (written down here from the design of the codes, not read from
// the product); the manifest says "noErrors" when none of them is expected.
const ERROR_CODES = new Set(['DBC-SYNTAX', 'DBC-STRING-UNTERMINATED', 'DBC-NUMBER', 'DBC-NAME-INVALID', 'DBC-MESSAGE-ID-DUPLICATE', 'DBC-MESSAGE-NAME-DUPLICATE',
  'DBC-MESSAGE-ID-RANGE', 'DBC-MESSAGE-DLC', 'DBC-SIGNAL-NAME-DUPLICATE', 'DBC-SIGNAL-WITHOUT-MESSAGE', 'DBC-SIGNAL-LENGTH', 'DBC-SIGNAL-OUTSIDE-FRAME',
  'DBC-SIGNAL-OVERLAP', 'DBC-FACTOR-ZERO', 'DBC-RANGE-INVERTED', 'DBC-VALTYPE-INVALID', 'DBC-MUX-NO-MULTIPLEXOR', 'DBC-MUX-AMBIGUOUS', 'DBC-MUX-SWITCH-FLOAT',
  'DBC-MUX-EXTENDED-RANGE', 'DBC-MUX-CYCLE', 'DBC-MUX-TOO-DEEP']);

function buildCorpus() {
  const C = [];
  function add(file, description, messages, signals, expect, content, extra) {
    C.push(Object.assign({ file: file, description: description, messages: messages, signals: signals, orphans: 0, expect: expect.slice().sort(), content: content, encoding: 'utf-8' }, extra || {}));
  }
  const N2 = ['Ecu1', 'Ecu2'];

  add('01-minimal.dbc', 'Smallest useful file: no NS_ block, two nodes, one message with one signal.', 1, 1, [],
    lines(head('1', ['A', 'B'], false), [bo(100, 'Msg', 8, 'A'), u('S', 0, 8, 1, 'B'), '']));

  add('02-classic-header.dbc', 'Classic header with the full NS_ list, a value table that a signal uses, comments on every kind of object.', 2, 3, [],
    lines(head('1.0', ['Engine', 'Gearbox', 'Cluster']), [
      'VAL_TABLE_ OnOff 1 "On" 0 "Off" ;', '',
      bo(100, 'Status', 8, 'Engine'), u('Running', 0, 1, 1, 'Cluster'), u('Gear', 8, 4, 1, 'Cluster,Gearbox'), '',
      bo(101, 'Request', 2, 'Cluster'), u('ReqGear', 0, 4, 1, 'Gearbox'), '',
      'CM_ "Invented test network.";', 'CM_ BU_ Engine "Drives the powertrain.";', 'CM_ BO_ 100 "Status of the drive.";', 'CM_ SG_ 100 Gear "Selected gear.";',
      'VAL_ 100 Running 1 "On" 0 "Off" ;', '']));

  add('03-intel-basic.dbc', 'Little-endian signals: byte-aligned, nibbles, a 32-bit signal, and signals that cross byte boundaries at odd bits.', 2, 10, [],
    lines(head('1', N2), [
      bo(257, 'IntelBasic', 8, 'Ecu1'), u('A', 0, 8, 1, 'Ecu2'), sg('B', 8, 16, 1, '+', '0.5', '0', '0', '32767.5', 'u', 'Ecu2'), u('C', 24, 4, 1, 'Ecu2'), u('D', 28, 4, 1, 'Ecu2'), u('E', 32, 32, 1, 'Ecu2'), '',
      bo(258, 'IntelOdd', 8, 'Ecu1'), u('X1', 5, 9, 1, 'Ecu2'), u('X2', 14, 11, 1, 'Ecu2'), u('X3', 25, 7, 1, 'Ecu2'), u('X4', 32, 13, 1, 'Ecu2'), u('X5', 45, 19, 1, 'Ecu2'), '']));

  add('04-motorola-basic.dbc', 'Big-endian signals: start bit 7 length 16, start bit 0 length 8, a 20-bit signal over three bytes, byte 7, nibbles.', 4, 8, [],
    lines(head('1', N2), [
      bo(512, 'MotP', 8, 'Ecu1'), u('P', 7, 16, 0, 'Ecu2'), '',
      bo(513, 'MotQ', 8, 'Ecu1'), u('Q', 0, 8, 0, 'Ecu2'), '',
      bo(514, 'MotS', 8, 'Ecu1'), u('S', 4, 20, 0, 'Ecu2'), '',
      bo(515, 'MotMix', 8, 'Ecu1'), u('X', 7, 8, 0, 'Ecu2'), u('U', 15, 8, 0, 'Ecu2'), u('W', 23, 24, 0, 'Ecu2'), u('T', 59, 4, 0, 'Ecu2'), u('V', 63, 4, 0, 'Ecu2'), '']));

  add('05-bit-signals.dbc', 'One-bit signals in both byte orders, at the edges of bytes.', 1, 6, [],
    lines(head('1', N2), [
      bo(768, 'Bits8', 8, 'Ecu1'), u('I0', 0, 1, 1, 'Ecu2'), u('I1', 9, 1, 1, 'Ecu2'), u('M0', 7, 1, 0, 'Ecu2'), u('M1', 16, 1, 0, 'Ecu2'), u('I2', 23, 1, 1, 'Ecu2'), u('M2', 31, 1, 0, 'Ecu2'), '']));

  add('06-wide-signals.dbc', 'Signals of 63 and 64 bits in both byte orders, signed and unsigned, and a 64-bit signal with an exact decimal factor.', 6, 6, [],
    lines(head('1', N2), [
      bo(1024, 'Wide64', 8, 'Ecu1'), u('U64', 0, 64, 1, 'Ecu2'), '',
      bo(1025, 'WideMotS', 8, 'Ecu1'), s('M64S', 7, 64, 0, 'Ecu2'), '',
      bo(1026, 'Wide63', 8, 'Ecu1'), u('L63', 1, 63, 1, 'Ecu2'), '',
      bo(1027, 'Wide63M', 8, 'Ecu1'), u('N63', 6, 63, 0, 'Ecu2'), '',
      bo(1028, 'WideDec', 8, 'Ecu1'), sg('D64', 0, 64, 1, '+', '0.001', '0', '0', '18446744073709551.615', 'km', 'Ecu2'), '',
      bo(1029, 'WideS64', 8, 'Ecu1'), s('S64', 0, 64, 1, 'Ecu2'), '']));

  add('07-signed-values.dbc', 'Signed signals of 8, 12, 16, 32 and 64 bits, little and big endian, a negative factor, negative offsets.', 3, 8, [],
    lines(head('1', N2), [
      bo(1280, 'Signed1', 8, 'Ecu1'), s('S8', 0, 8, 1, 'Ecu2'), sg('S12', 8, 12, 1, '-', '0.5', '-10', '-1034', '1013.5', '', 'Ecu2'), s('S16', 24, 16, 1, 'Ecu2'), '',
      bo(1281, 'Signed32', 8, 'Ecu1'), s('S32I', 0, 32, 1, 'Ecu2'), s('S32M', 39, 32, 0, 'Ecu2'), '',
      bo(1282, 'NegFactor', 8, 'Ecu1'), sg('NF', 0, 8, 1, '+', '-0.5', '100', '-27.5', '100', '', 'Ecu2'), sg('NF2', 8, 8, 1, '-', '-1', '0', '-127', '128', '', 'Ecu2'),
      sg('NO', 16, 8, 1, '+', '1', '-40', '-40', '215', 'degC', 'Ecu2'), '']));

  add('08-exact-decimals.dbc', 'Factors and offsets that binary floating point cannot hold: 0.001, 0.1, 1e-05, 0.00390625, 0.3, 0.07, 1e12, -273.15.', 2, 9, [],
    lines(head('1', N2), [
      bo(1536, 'Dec1', 8, 'Ecu1'), sg('F001', 0, 16, 1, '+', '0.001', '0', '0', '65.535', 'V', 'Ecu2'), sg('F01', 16, 8, 1, '+', '0.1', '-40', '-40', '-14.5', 'degC', 'Ecu2'),
      sg('F1M5', 24, 16, 1, '+', '1e-05', '0', '0', '0.65535', 'A', 'Ecu2'), sg('F39', 40, 8, 1, '+', '0.00390625', '0', '0', '0.99609375', '', 'Ecu2'), '',
      bo(1537, 'Dec2', 8, 'Ecu1'), sg('FHUGE', 0, 8, 1, '+', '1000000000000', '0', '0', '255000000000000', '', 'Ecu2'),
      sg('TEMP', 8, 16, 1, '+', '0.01', '-273.15', '-273.15', '382.2', 'degC', 'Ecu2'), sg('FNEG', 24, 8, 1, '+', '0.1', '-12.8', '-12.8', '12.7', '', 'Ecu2'),
      sg('FTHIRD', 32, 8, 1, '+', '0.3', '0', '0', '76.5', '', 'Ecu2'), sg('F7', 40, 8, 1, '+', '0.07', '0', '0', '17.85', '', 'Ecu2'), '']));

  add('09-float-signals.dbc', 'Floating point signals (value type 1 and 2), little and big endian.', 3, 5, [],
    lines(head('1', N2), [
      bo(1792, 'Float32', 8, 'Ecu1'), sg('FA', 0, 32, 1, '+', '1', '0', '-1000', '1000', '', 'Ecu2'), sg('FB', 32, 32, 1, '+', '1', '0', '-1000', '1000', '', 'Ecu2'), '',
      bo(1793, 'Float64', 8, 'Ecu1'), sg('FD', 0, 64, 1, '+', '1', '0', '-1000', '1000', '', 'Ecu2'), '',
      bo(1794, 'FloatMot', 8, 'Ecu1'), sg('FM', 7, 32, 0, '+', '1', '0', '-1000', '1000', '', 'Ecu2'), sg('FM2', 39, 32, 0, '+', '1', '0', '-1000', '1000', '', 'Ecu2'), '',
      'SIG_VALTYPE_ 1792 FA : 1;', 'SIG_VALTYPE_ 1792 FB : 1;', 'SIG_VALTYPE_ 1793 FD : 2;', 'SIG_VALTYPE_ 1794 FM : 1;', 'SIG_VALTYPE_ 1794 FM2 : 1;', '']));

  add('10-float-scaled.dbc', 'Floating point signals with a factor and an offset.', 2, 2, [],
    lines(head('1', N2), [
      bo(1800, 'FloatScaled32', 8, 'Ecu1'), sg('G32', 0, 32, 1, '+', '2', '1', '0', '0', '', 'Ecu2'), '',
      bo(1801, 'FloatScaled64', 8, 'Ecu1'), sg('H64', 0, 64, 1, '+', '0.5', '-0.25', '0', '0', '', 'Ecu2'), '',
      'SIG_VALTYPE_ 1800 G32 : 1;', 'SIG_VALTYPE_ 1801 H64 : 2;', '']));

  add('11-value-tables.dbc', 'Value descriptions: negative values, 64-bit values, an entry for a signed signal written as an unsigned bit pattern (reported).', 3, 4, ['DBC-VALUE-OUTSIDE-RAW'],
    lines(head('1', N2), [
      bo(1024, 'Tables8', 8, 'Ecu1'), s('Sa', 0, 8, 1, 'Ecu2'), s('Sb', 8, 8, 1, 'Ecu2'), '',
      bo(1025, 'Big64', 8, 'Ecu1'), u('U64v', 0, 64, 1, 'Ecu2'), '',
      bo(1026, 'Low64', 8, 'Ecu1'), s('S64v', 0, 64, 1, 'Ecu2'), '',
      'VAL_ 1024 Sa -1 "Minus" 0 "Zero" 127 "Max" ;', 'VAL_ 1024 Sb 255 "AllOnes" 0 "Zero" ;',
      'VAL_ 1025 U64v 18446744073709551615 "Full" 0 "Empty" ;', 'VAL_ 1026 S64v -9223372036854775808 "Lowest" 9223372036854775807 "Highest" ;', '']));

  add('12-value-escapes-duplicates.dbc', 'Escapes inside descriptions, a repeated raw value, a second VAL_ for one signal, a table with a repeated value, a table defined twice, tables nothing uses.', 1, 3,
    ['DBC-VAL-DUPLICATE', 'DBC-VAL-DUPLICATE', 'DBC-VAL-DUPLICATE', 'DBC-VALUE-TABLE-DUPLICATE', 'DBC-VALUE-TABLE-UNUSED', 'DBC-VALUE-TABLE-UNUSED'],
    lines(head('1', N2), [
      'VAL_TABLE_ T 1 "a" 1 "b" ;', 'VAL_TABLE_ U 0 "z" ;', 'VAL_TABLE_ U 1 "w" ;', '',
      bo(1040, 'Esc', 8, 'Ecu1'), u('A', 0, 8, 1, 'Ecu2'), u('B', 8, 8, 1, 'Ecu2'), u('C', 16, 8, 1, 'Ecu2'), '',
      String.raw`VAL_ 1040 A 0 "Say \"zero\"" 1 "back\\slash" 2 "semi;colon" ;`,
      'VAL_ 1040 B 1 "one" 1 "uno" 2 "two" ;', 'VAL_ 1040 C 0 "x" ;', 'VAL_ 1040 C 1 "y" ;', '']));

  add('13-multiplex-simple.dbc', 'Simple multiplexing: one multiplexor, signals for value 0 and value 1 on the same bits, a signal in every frame.', 1, 5, [],
    lines(head('1', N2), [
      bo(1100, 'MuxSimple', 8, 'Ecu1'), u('Sel', 0, 8, 1, 'Ecu2', 'M'), u('A', 8, 16, 1, 'Ecu2', 'm0'), sg('B', 8, 16, 1, '+', '0.1', '0', '0', '6553.5', '', 'Ecu2', 'm1'),
      u('C', 24, 8, 1, 'Ecu2', 'm0'), u('D', 56, 8, 1, 'Ecu2'), '']));

  const eight = [bo(1101, 'MuxEight', 8, 'Ecu1'), u('Sel', 0, 3, 1, 'Ecu2', 'M')];
  for (let k = 0; k < 8; k++) eight.push(u('V' + k, 8, 8, 1, 'Ecu2', 'm' + k));
  eight.push('');
  add('14-multiplex-eight.dbc', 'A 3-bit multiplexor with eight values, each selecting one signal on the same byte.', 1, 9, [], lines(head('1', N2), eight));

  add('15-multiplex-extended-simple.dbc', 'Extended multiplexing with ranges of multiplexor values (SG_MUL_VAL_).', 1, 4, [],
    lines(head('1', N2), [
      bo(1102, 'MuxRanges', 8, 'Ecu1'), u('Sel', 0, 8, 1, 'Ecu2', 'M'), u('A', 8, 8, 1, 'Ecu2', 'm0'), u('B', 16, 8, 1, 'Ecu2', 'm5'), u('C', 8, 8, 1, 'Ecu2', 'm9'), '',
      'SG_MUL_VAL_ 1102 A Sel 0-3;', 'SG_MUL_VAL_ 1102 B Sel 5-5, 7-9;', 'SG_MUL_VAL_ 1102 C Sel 9-12;', '']));

  add('16-multiplex-extended-nested.dbc', 'A multiplexor that is itself multiplexed (m1M), with signals selected by either level.', 1, 6, [],
    lines(head('1', N2), [
      bo(1103, 'MuxNested', 8, 'Ecu1'), u('Sel', 0, 4, 1, 'Ecu2', 'M'), u('Sub', 4, 4, 1, 'Ecu2', 'm1M'), u('X', 8, 8, 1, 'Ecu2', 'm0'), u('Y', 8, 8, 1, 'Ecu2', 'm1'),
      u('Z', 16, 8, 1, 'Ecu2', 'm0'), u('W', 24, 8, 1, 'Ecu2', 'm2'), '',
      'SG_MUL_VAL_ 1103 X Sel 0-0;', 'SG_MUL_VAL_ 1103 Y Sel 1-1;', 'SG_MUL_VAL_ 1103 Z Sub 0-3;', 'SG_MUL_VAL_ 1103 W Sub 2-2;', '']));

  add('17-multiplex-three-level.dbc', 'Three levels of multiplexors: M0 selects M1 selects M2 selects a signal.', 1, 5, [],
    lines(head('1', N2), [
      bo(1104, 'MuxThree', 8, 'Ecu1'), u('M0', 0, 2, 1, 'Ecu2', 'M'), u('M1', 2, 2, 1, 'Ecu2', 'm1M'), u('M2', 4, 2, 1, 'Ecu2', 'm2M'), u('S', 8, 8, 1, 'Ecu2', 'm3'), u('T', 16, 8, 1, 'Ecu2', 'm0'), '',
      'SG_MUL_VAL_ 1104 M1 M0 1-1;', 'SG_MUL_VAL_ 1104 M2 M1 2-2;', 'SG_MUL_VAL_ 1104 S M2 3-3;', 'SG_MUL_VAL_ 1104 T M0 0-0;', '']));

  add('18-mux-ambiguous.dbc', 'Two multiplexors and a multiplexed signal without SG_MUL_VAL_: it is not clear which one selects it.', 1, 3,
    ['DBC-MUX-AMBIGUOUS', 'DBC-MUX-UNUSED', 'DBC-MUX-UNUSED'],
    lines(head('1', N2), [bo(1105, 'MuxAmbig', 8, 'Ecu1'), u('Sel1', 0, 4, 1, 'Ecu2', 'M'), u('Sel2', 4, 4, 1, 'Ecu2', 'M'), u('Data', 8, 8, 1, 'Ecu2', 'm0'), '']));

  add('19-mux-float-switch.dbc', 'A multiplexor that is a 32-bit float cannot select by value.', 1, 2, ['DBC-MUX-SWITCH-FLOAT'],
    lines(head('1', N2), [bo(1106, 'MuxFloat', 8, 'Ecu1'), sg('Sel', 0, 32, 1, '+', '1', '0', '0', '0', '', 'Ecu2', 'M'), u('A', 32, 8, 1, 'Ecu2', 'm0'), '', 'SIG_VALTYPE_ 1106 Sel : 1;', '']));

  add('20-mux-loop.dbc', 'Two multiplexors that select each other, and a signal below them.', 1, 3, ['DBC-MUX-CYCLE', 'DBC-MUX-CYCLE'],
    lines(head('1', N2), [
      bo(1107, 'MuxLoop', 8, 'Ecu1'), u('A', 0, 4, 1, 'Ecu2', 'm0M'), u('B', 4, 4, 1, 'Ecu2', 'm0M'), u('C', 8, 8, 1, 'Ecu2', 'm0'), '',
      'SG_MUL_VAL_ 1107 A B 0-0;', 'SG_MUL_VAL_ 1107 B A 0-0;', 'SG_MUL_VAL_ 1107 C A 0-0;', '']));

  add('21-mux-bad-extended.dbc', 'Seven small messages, each with one multiplexing mistake.', 7, 13,
    ['DBC-MUX-EXTENDED-UNKNOWN', 'DBC-MUX-UNUSED', 'DBC-MUX-EXTENDED-RANGE', 'DBC-MUX-UNUSED', 'DBC-MUX-EXTENDED-MISMATCH', 'DBC-MUX-EXTENDED-DUPLICATE',
      'DBC-MUX-NOT-MULTIPLEXED', 'DBC-MUX-UNUSED', 'DBC-MUX-NO-MULTIPLEXOR', 'DBC-MUX-VALUE-RANGE'],
    lines(head('1', N2), [
      bo(1, 'MxA', 8, 'Ecu1'), u('Sel', 0, 4, 1, 'Ecu2', 'M'), u('P', 8, 8, 1, 'Ecu2', 'm0'), '',
      bo(2, 'MxB', 8, 'Ecu1'), u('Sel', 0, 4, 1, 'Ecu2', 'M'), u('Q', 8, 8, 1, 'Ecu2', 'm3'), '',
      bo(3, 'MxC', 8, 'Ecu1'), u('Sel', 0, 4, 1, 'Ecu2', 'M'), u('R', 8, 8, 1, 'Ecu2', 'm3'), '',
      bo(4, 'MxD', 8, 'Ecu1'), u('Sel', 0, 4, 1, 'Ecu2', 'M'), u('T', 8, 8, 1, 'Ecu2', 'm1'), '',
      bo(5, 'MxE', 8, 'Ecu1'), u('U', 0, 8, 1, 'Ecu2'), u('Sel2', 8, 4, 1, 'Ecu2', 'M'), '',
      bo(6, 'MxF', 8, 'Ecu1'), u('V', 0, 8, 1, 'Ecu2', 'm2'), '',
      bo(7, 'MxG', 8, 'Ecu1'), u('Sel', 0, 2, 1, 'Ecu2', 'M'), u('W', 8, 8, 1, 'Ecu2', 'm9'), '',
      'SG_MUL_VAL_ 1 P Nope 0-0;', 'SG_MUL_VAL_ 2 Q Sel 5-4;', 'SG_MUL_VAL_ 3 R Sel 5-6;', 'SG_MUL_VAL_ 4 T Sel 1-1;', 'SG_MUL_VAL_ 4 T Sel 2-2;', 'SG_MUL_VAL_ 5 U Sel2 0-0;', '']));

  const ext = (n) => String(n);
  add('22-extended-ids.dbc', 'Standard and 29-bit identifiers: bit 31 of the written ID marks an extended frame; both ends of each range.', 5, 6, [],
    lines(head('1', N2), [
      bo(ext(0x98FEF100), 'ExtA', 8, 'Ecu1'), u('E1', 0, 16, 1, 'Ecu2'), u('E2', 16, 16, 1, 'Ecu2'), '',
      bo(ext(0x80000001), 'ExtMin', 8, 'Ecu1'), u('E3', 0, 8, 1, 'Ecu2'), '',
      bo(ext(0x9FFFFFFF), 'ExtMax', 8, 'Ecu1'), u('E4', 0, 8, 1, 'Ecu2'), '',
      bo(0x7FF, 'StdMax', 8, 'Ecu1'), u('E5', 0, 8, 1, 'Ecu2'), '',
      bo(0, 'StdZero', 8, 'Ecu1'), u('E6', 0, 8, 1, 'Ecu2'), '',
      'BA_DEF_ BO_ "VFrameFormat" ENUM "StandardCAN","ExtendedCAN";', 'BA_DEF_DEF_ "VFrameFormat" "StandardCAN";',
      'BA_ "VFrameFormat" BO_ ' + ext(0x98FEF100) + ' 1;', 'BA_ "VFrameFormat" BO_ ' + ext(0x80000001) + ' 1;', 'BA_ "VFrameFormat" BO_ ' + ext(0x9FFFFFFF) + ' 1;', '']));

  add('23-id-flag-mistakes.dbc', 'Identifier mistakes: 0x800 without the extended flag, a flagged ID above 29 bits, an ID above 32 bits, frame format attributes that disagree with the ID.', 7, 7,
    ['DBC-MESSAGE-EXTENDED-FLAG', 'DBC-MESSAGE-ID-RANGE', 'DBC-MESSAGE-ID-RANGE', 'DBC-MESSAGE-FRAME-FORMAT', 'DBC-MESSAGE-FRAME-FORMAT'],
    lines(head('1', N2), [
      bo(2048, 'FlagMissing', 8, 'Ecu1'), u('A', 0, 8, 1, 'Ecu2'), '',
      bo(ext(0xA0000000), 'TooBig', 8, 'Ecu1'), u('B', 0, 8, 1, 'Ecu2'), '',
      bo(4294967296, 'Huge', 8, 'Ecu1'), u('C', 0, 8, 1, 'Ecu2'), '',
      bo(ext(0x80000001), 'ExtButStd', 8, 'Ecu1'), u('D', 0, 8, 1, 'Ecu2'), '',
      bo(3, 'StdButExt', 8, 'Ecu1'), u('E', 0, 8, 1, 'Ecu2'), '',
      bo(0x7FF, 'Edge', 8, 'Ecu1'), u('F', 0, 8, 1, 'Ecu2'), '',
      bo(ext(0x800007FF), 'ExtEdge', 8, 'Ecu1'), u('G', 0, 8, 1, 'Ecu2'), '',
      'BA_DEF_ BO_ "VFrameFormat" ENUM "StandardCAN","ExtendedCAN";', 'BA_DEF_DEF_ "VFrameFormat" "StandardCAN";',
      'BA_ "VFrameFormat" BO_ ' + ext(0x80000001) + ' 0;', 'BA_ "VFrameFormat" BO_ 3 1;', '']));

  add('24-dlc-values.dbc', 'Data lengths 0, 8, 9 (not a frame length), 12, 24, 64 and 65 (too long); signals in the upper bytes of the long frames.', 7, 8,
    ['DBC-MESSAGE-NO-SIGNALS', 'DBC-MESSAGE-DLC-FD', 'DBC-MESSAGE-DLC'],
    lines(head('1', N2), [
      bo(1200, 'Dlc0', 0, 'Ecu1'), '',
      bo(1201, 'Dlc8', 8, 'Ecu1'), u('D8', 0, 64, 1, 'Ecu2'), '',
      bo(1202, 'Dlc12', 12, 'Ecu1'), u('H0', 0, 8, 1, 'Ecu2'), u('H1', 88, 8, 1, 'Ecu2'), '',
      bo(1203, 'Dlc24', 24, 'Ecu1'), u('U0', 184, 8, 1, 'Ecu2'), '',
      bo(1204, 'Dlc64', 64, 'Ecu1'), u('Z0', 504, 8, 1, 'Ecu2'), u('Z1', 255, 16, 0, 'Ecu2'), '',
      bo(1205, 'Dlc9', 9, 'Ecu1'), u('Y', 0, 8, 1, 'Ecu2'), '',
      bo(1206, 'Dlc65', 65, 'Ecu1'), u('X', 0, 8, 1, 'Ecu2'), '']));

  add('25-comments.dbc', 'Comments on the network, a node, a message and signals, with quotes, semicolons and line breaks inside.', 2, 3, [],
    lines(head('1', ['A', 'B']), [
      bo(100, 'M1', 8, 'A'), u('S1', 0, 8, 1, 'B'), u('S2', 8, 8, 1, 'B'), '', bo(101, 'M2', 4, 'B'), u('S3', 0, 8, 1, 'A'), '',
      'CM_ "Network comment.";', 'CM_ BU_ A "Node comment.";', 'CM_ BO_ 100 "Message comment.";',
      String.raw`CM_ SG_ 100 S1 "Signal with \"quotes\" and a ; semicolon and a back\\slash.";`,
      'CM_ SG_ 100 S2 "line one', 'line two', 'line three;";', '']));

  add('26-attributes.dbc', 'Attribute definitions of every type (INT, HEX, FLOAT, STRING, ENUM) for the network, nodes, messages and signals, with defaults and values.', 2, 3, [],
    lines(head('1', ['A', 'B']), [
      bo(100, 'M1', 8, 'A'), u('S1', 0, 8, 1, 'B'), u('S2', 8, 8, 1, 'B'), '', bo(101, 'M2', 8, 'B'), u('S3', 0, 8, 1, 'A'), '',
      'BA_DEF_ "BusType" STRING ;', 'BA_DEF_ BU_ "NodeRole" STRING ;', 'BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;', 'BA_DEF_ BO_ "MaskBits" HEX 0 255;',
      'BA_DEF_ SG_ "SigGain" FLOAT 0 10;', 'BA_DEF_ SG_ "SigClass" ENUM "None","Slow","Fast";', 'BA_DEF_ "Generation" INT 1 9;',
      'BA_DEF_DEF_ "BusType" "";', 'BA_DEF_DEF_ "NodeRole" "";', 'BA_DEF_DEF_ "GenMsgCycleTime" 0;', 'BA_DEF_DEF_ "MaskBits" 0;', 'BA_DEF_DEF_ "SigGain" 1;',
      'BA_DEF_DEF_ "SigClass" "None";', 'BA_DEF_DEF_ "Generation" 1;',
      'BA_ "BusType" "CAN";', 'BA_ "Generation" 3;', 'BA_ "NodeRole" BU_ A "master";', 'BA_ "GenMsgCycleTime" BO_ 100 10;', 'BA_ "MaskBits" BO_ 100 16;',
      'BA_ "SigGain" SG_ 100 S1 2.5;', 'BA_ "SigClass" SG_ 100 S1 2;', 'BA_ "SigClass" SG_ 100 S2 "Fast";', '']));

  add('27-attributes-bad.dbc', 'Attribute mistakes: duplicate definition, undefined attribute, wrong object type, unknown object, values outside the definition.', 1, 1,
    ['DBC-ATTRIBUTE-DUPLICATE-DEF', 'DBC-ATTRIBUTE-OBJECT-TYPE', 'DBC-ATTRIBUTE-UNDEFINED', 'DBC-ATTRIBUTE-UNDEFINED', 'DBC-ATTRIBUTE-UNKNOWN-OBJECT',
      'DBC-ATTRIBUTE-VALUE', 'DBC-ATTRIBUTE-VALUE', 'DBC-ATTRIBUTE-VALUE', 'DBC-ATTRIBUTE-VALUE', 'DBC-ATTRIBUTE-VALUE'],
    lines(head('1', ['A', 'B']), [
      bo(100, 'M', 8, 'A'), u('S', 0, 8, 1, 'B'), '',
      'BA_DEF_ BO_ "Prio" INT 0 7;', 'BA_DEF_ BO_ "Prio" INT 0 7;', 'BA_DEF_ SG_ "Gain" FLOAT 0 10;', 'BA_DEF_ "Mode" ENUM "A","B";', 'BA_DEF_ "Label" STRING ;', 'BA_DEF_ BO_ "Mask" HEX 0 255;',
      'BA_DEF_DEF_ "Prio" 0;', 'BA_DEF_DEF_ "Ghost" 5;', 'BA_DEF_DEF_ "Mode" "C";',
      'BA_ "Prio" BO_ 100 9;', 'BA_ "Prio" BO_ 999 3;', 'BA_ "Gain" SG_ 100 S 11.5;', 'BA_ "Gain" BO_ 100 1;', 'BA_ "Unknown" 5;', 'BA_ "Label" 5;', 'BA_ "Mask" BO_ 100 1.5;', '']));

  add('28-transmitters.dbc', 'An extra transmitter, a message without a sending node, a signal that only Vector__XXX receives, and two bad BO_TX_BU_ statements.', 2, 2,
    ['DBC-SIGNAL-NO-RECEIVER', 'DBC-TRANSMITTER-UNKNOWN-MESSAGE', 'DBC-SENDER-UNKNOWN'],
    lines(head('1', ['A', 'B']), [
      bo(100, 'M1', 8, 'A'), u('S1', 0, 8, 1, 'B'), '', bo(101, 'M2', 8, 'Vector__XXX'), u('S2', 0, 8, 1, 'Vector__XXX'), '',
      'BO_TX_BU_ 100 : B;', 'BO_TX_BU_ 999 : A;', 'BO_TX_BU_ 100 : Ghost;', '']));

  add('29-independent-signals.dbc', 'The pseudo message VECTOR__INDEPENDENT_SIG_MSG that holds signals without a message.', 1, 3, [],
    lines(head('1', ['A', 'B']), [
      bo(3221225472, 'VECTOR__INDEPENDENT_SIG_MSG', 0, 'Vector__XXX'), u('Free1', 0, 8, 1, 'B'), u('Free2', 8, 8, 1, 'B'), '',
      bo(100, 'M', 8, 'A'), u('S', 0, 8, 1, 'B'), '']));

  add('30-env-vars-passed-over.dbc', 'Statements that are read over without interpretation: EV_, ENVVAR_DATA_, SIG_GROUP_, relation attributes; and signal types, one with a missing value table.', 1, 1,
    ['DBC-VALUE-TABLE-MISSING'],
    lines(head('1', ['A', 'B']), [
      'VAL_TABLE_ SpeedTable 0 "slow" 1 "fast" ;', '',
      bo(100, 'M', 8, 'A'), u('S', 0, 8, 1, 'B'), '',
      'EV_ EnvTemp: 0 [-40|85] "degC" 0 1 DUMMY_NODE_VECTOR0 Vector__XXX;', 'ENVVAR_DATA_ EnvTemp: 8;', 'SGTYPE_ st1 : 8@1+ (1,0) [0|255] "km/h" 0,SpeedTable;',
      'SGTYPE_ st2 : 8@1+ (1,0) [0|255] "km/h" 0,NoSuchTable;', 'SIG_GROUP_ 100 Grp 1 : S;', 'BA_DEF_REL_ BU_SG_REL_ "RelAttr" STRING ;', 'BU_SG_REL_ A SG_ 100 S;',
      'BA_REL_ "RelAttr" BU_SG_REL_ A SG_ 100 S "x";', 'CM_ EV_ EnvTemp "Temperature outside.";', 'VAL_ EnvTemp 0 "cold" 1 "warm" ;', '']));

  const sameBody = ['BU_: Alpha Beta', '', bo(100, 'Pair', 8, 'Alpha'), u('One', 0, 8, 1, 'Beta'), u('Two', 8, 8, 1, 'Beta'), '', bo(101, 'Solo', 4, 'Beta'),
    sg('Three', 0, 16, 1, '+', '0.5', '0', '0', '32767.5', 'u', 'Alpha'), '', 'CM_ BO_ 100 "A comment";', ''];
  const sameHead = ['VERSION "2.1"', '', 'NS_ :', '', 'BS_:', ''];
  const sameText = sameHead.concat(sameBody).join('\n');
  const asBytes = (text, eol, bom) => Buffer.concat([bom ? Buffer.from([0xEF, 0xBB, 0xBF]) : Buffer.alloc(0), Buffer.from(text.replace(/\n/g, eol), 'utf8')]);
  add('31-line-ends-lf.dbc', 'The same small database with LF line ends.', 2, 3, [], asBytes(sameText, '\n', false));
  add('32-line-ends-crlf.dbc', 'The same small database with CRLF line ends.', 2, 3, [], asBytes(sameText, '\r\n', false));
  add('33-line-ends-cr.dbc', 'The same small database with lone CR line ends.', 2, 3, [], asBytes(sameText, '\r', false));
  add('34-bom-utf8.dbc', 'The same small database with a UTF-8 byte order mark.', 2, 3, [], asBytes(sameText, '\n', true));
  const textWith = (unit, comment) => lines(head('1', ['A', 'B']), [bo(100, 'Temp', 8, 'A'), sg('Outside', 0, 8, 1, '+', '1', '-40', '-40', '215', unit, 'B'), '', 'CM_ SG_ 100 Outside "' + comment + '";', '']);
  add('35-windows-1252.dbc', 'Bytes in Windows-1252: the degree sign is the single byte 0xB0 and e-acute the byte 0xE9; not valid UTF-8.', 1, 1, [], Buffer.from(textWith('°C', 'Température'), 'latin1'), { encoding: 'windows-1252' });
  add('36-utf8-text.dbc', 'UTF-8 text with a degree sign, accented letters and other non-ASCII characters in a unit and a comment.', 1, 1, [], Buffer.from(textWith('°C', 'Température Ünicöde – 温度'), 'utf8'));
  add('37-utf16le-bom.dbc', 'The same kind of database saved as UTF-16 little endian with a byte order mark.', 1, 1, [],
    Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(textWith('°C', 'Température'), 'utf16le')]), { encoding: 'utf-16le' });
  add('38-replacement-char.dbc', 'A comment that already holds the replacement character U+FFFD (a file saved after a wrong encoding guess).', 1, 1, ['DBC-ENCODING'],
    Buffer.from(textWith('', 'Temp�rature'), 'utf8'));

  add('39-missing-semicolons.dbc', 'Five statements without their closing semicolon, each followed by another statement or the end of the file.', 1, 1,
    ['DBC-SEMICOLON', 'DBC-SEMICOLON', 'DBC-SEMICOLON', 'DBC-SEMICOLON', 'DBC-SEMICOLON'],
    lines(['BU_: A B', '', bo(100, 'M', 8, 'A'), u('S', 0, 8, 1, 'B'), '',
      'CM_ SG_ 100 S "no semicolon here"', 'BA_DEF_ BO_ "Cyc" INT 0 100', 'BA_DEF_DEF_ "Cyc" 0', 'BA_ "Cyc" BO_ 100 10', 'VAL_ 100 S 0 "zero" 1 "one"', '']));

  add('40-unterminated-strings.dbc', 'A unit string and a comment string that never close.', 3, 3,
    ['DBC-SEMICOLON', 'DBC-SIGNAL-NO-RECEIVER', 'DBC-STRING-UNTERMINATED', 'DBC-STRING-UNTERMINATED'],
    lines(['VERSION "1.0"', 'BU_: A B', bo(100, 'M1', 8, 'A'), ' SG_ S1 : 0|8@1+ (1,0) [0|255] "km/h B', bo(101, 'M2', 8, 'A'), u('S2', 0, 8, 1, 'B'),
      'CM_ "this comment never closes;', bo(102, 'M3', 8, 'B'), u('S3', 0, 8, 1, 'A'), '']));

  add('41-unknown-statements.dbc', 'A line of garbage where a statement should start, and two statements with unknown keywords.', 1, 1,
    ['DBC-SYNTAX', 'DBC-UNKNOWN-STATEMENT', 'DBC-UNKNOWN-STATEMENT'],
    lines(['VERSION "1"', 'BU_: A B', '@@@ not a statement', bo(100, 'M', 8, 'A'), u('S', 0, 8, 1, 'B'), 'FOO_BAR 12 34;', 'CM_ "ok";', 'WIBBLE', '']));

  add('42-signal-before-message.dbc', 'Signal lines that do not follow a message line: before the first message, and after a comment.', 1, 1,
    ['DBC-SIGNAL-WITHOUT-MESSAGE', 'DBC-SIGNAL-WITHOUT-MESSAGE'], lines(['BU_: A B', u('Lost', 0, 8, 1, 'B'), bo(100, 'M', 8, 'A'), u('Ok', 0, 8, 1, 'B'), 'CM_ "x";', u('Lost2', 8, 8, 1, 'B'), '']),
    { orphans: 2 });

  add('43-garbage-lines.dbc', 'Four lines of garbage between valid statements.', 1, 1, ['DBC-SYNTAX', 'DBC-SYNTAX', 'DBC-SYNTAX', 'DBC-SYNTAX'],
    lines(['VERSION "1"', 'BU_: A B', '(((garbage', bo(100, 'M', 8, 'A'), u('S', 0, 8, 1, 'B'), '"stray string"', 'CM_ "ok";', '||| pipes', 'BA_DEF_ BO_ "Cyc" INT 0 100;',
      ': colon', 'BA_ "Cyc" BO_ 100 5;', '']));

  add('44-empty.dbc', 'An empty file.', 0, 0, [], Buffer.alloc(0));
  add('45-only-comments.dbc', 'A file that holds a version and comments only.', 0, 0, [], lines(['VERSION "0"', '', 'CM_ "First comment.";', 'CM_ "Second comment with a ; inside.";', '']));

  const long33 = 'LongMessageNameWith33Characters_x';
  const long64 = 'S' + 'ignalNameThatIsSixtyFourCharactersLongBecauseItRepeatsABlock'.padEnd(63, 'x');
  const long40 = 'LongNodeNameWithFortyCharacters_abcdefgh';
  const exact32 = 'ExactlyThirtyTwoCharactersLong_x';
  add('46-long-names.dbc', 'A node of 40 characters, a message of 33, a signal of 64 and a message of exactly 32 (no note).', 2, 2, ['DBC-NAME-LONG', 'DBC-NAME-LONG', 'DBC-NAME-LONG'],
    lines(head('1', [long40, 'Short']), [bo(100, long33, 8, long40), u(long64, 0, 8, 1, 'Short'), '', bo(101, exact32, 8, 'Short'), u('Ok', 0, 8, 1, long40), '']),
    { checks: { long33: long33.length, long64: long64.length, long40: long40.length, exact32: exact32.length } });

  add('47-names-invalid.dbc', 'Names that are not valid DBC identifiers: a hyphen, a leading digit.', 1, 1, ['DBC-NAME-INVALID', 'DBC-NAME-INVALID', 'DBC-NAME-INVALID'],
    lines(head('1', ['Good', 'Bad-Node']), [bo(100, '9Msg', 8, 'Good'), u('Bad-Sig', 0, 8, 1, 'Bad-Node'), '']));

  add('48-names-case.dbc', 'Names that differ only in case: nodes, messages, signals.', 2, 3, ['DBC-NAME-CASE', 'DBC-NAME-CASE', 'DBC-NAME-CASE'],
    lines(head('1', ['Gateway', 'gateway']), [bo(100, 'Speed', 8, 'Gateway'), u('Rpm', 0, 8, 1, 'gateway'), u('rpm', 8, 8, 1, 'gateway'), '', bo(101, 'SPEED', 8, 'gateway'), u('S', 0, 8, 1, 'Gateway'), '']));

  add('49-duplicates.dbc', 'A node listed twice, a signal name used twice, two messages with the same ID, two with the same name, an unknown sender and an unknown receiver.', 3, 4,
    ['DBC-MESSAGE-ID-DUPLICATE', 'DBC-MESSAGE-NAME-DUPLICATE', 'DBC-NODE-DUPLICATE', 'DBC-RECEIVER-UNKNOWN', 'DBC-SENDER-UNKNOWN', 'DBC-SIGNAL-NAME-DUPLICATE'],
    lines(head('1', ['A', 'B', 'A']), [bo(100, 'M1', 8, 'A'), u('S', 0, 8, 1, 'B'), u('S', 8, 8, 1, 'B'), '', bo(100, 'M2', 8, 'Zed'), u('T', 0, 8, 1, 'Ghost'), '', bo(101, 'M1', 8, 'A'), u('U', 0, 8, 1, 'B'), '']));

  add('50-layout-errors.dbc', 'Layout and number mistakes, one message for each group: overlap, outside the frame, length, factor 0, inverted range, range beyond the raw bits, unreadable number, float length, value outside the raw range.', 5, 13,
    ['DBC-SIGNAL-OVERLAP', 'DBC-SIGNAL-OUTSIDE-FRAME', 'DBC-SIGNAL-OUTSIDE-FRAME', 'DBC-SIGNAL-LENGTH', 'DBC-SIGNAL-LENGTH', 'DBC-FACTOR-ZERO', 'DBC-RANGE-INVERTED', 'DBC-RANGE-OUTSIDE-RAW',
      'DBC-NUMBER', 'DBC-VALTYPE-INVALID', 'DBC-VALTYPE-INVALID', 'DBC-VALTYPE-UNKNOWN', 'DBC-VALUE-OUTSIDE-RAW'],
    lines(head('1', N2), [
      bo(100, 'L100', 2, 'Ecu1'), u('A', 0, 8, 1, 'Ecu2'), u('B', 4, 8, 1, 'Ecu2'), '',
      bo(101, 'L101', 4, 'Ecu1'), u('C', 24, 16, 1, 'Ecu2'), u('D', 31, 16, 0, 'Ecu2'), u('E', 8, 0, 1, 'Ecu2'), u('F', 8, 65, 1, 'Ecu2'), '',
      bo(102, 'L102', 4, 'Ecu1'), sg('G', 0, 8, 1, '+', '0', '0', '0', '15', '', 'Ecu2'), sg('H', 8, 8, 1, '+', '1', '0', '10', '5', '', 'Ecu2'),
      sg('I', 16, 4, 1, '+', '1', '0', '0', '20', '', 'Ecu2'), sg('J', 24, 8, 1, '+', '1e999', '0', '0', '1', '', 'Ecu2'), '',
      bo(103, 'L103', 8, 'Ecu1'), u('K', 0, 16, 1, 'Ecu2'), u('L', 16, 8, 1, 'Ecu2'), '',
      bo(104, 'L104', 2, 'Ecu1'), u('M', 0, 8, 1, 'Ecu2'), '',
      'SIG_VALTYPE_ 103 K : 1;', 'SIG_VALTYPE_ 103 Nope : 1;', 'SIG_VALTYPE_ 103 L : 7;', 'VAL_ 104 M 300 "big" 0 "zero" ;', '']));

  add('51-references-unknown.dbc', 'Statements that name a message, signal or node that does not exist.', 1, 1,
    ['DBC-COMMENT-UNKNOWN', 'DBC-COMMENT-UNKNOWN', 'DBC-COMMENT-UNKNOWN', 'DBC-MUX-EXTENDED-UNKNOWN', 'DBC-MUX-EXTENDED-UNKNOWN', 'DBC-VAL-UNKNOWN-MESSAGE', 'DBC-VAL-UNKNOWN-SIGNAL', 'DBC-VALTYPE-UNKNOWN'],
    lines(head('1', ['A', 'B']), [bo(100, 'M', 8, 'A'), u('S', 0, 8, 1, 'B'), '',
      'VAL_ 999 S 1 "x" ;', 'VAL_ 100 Nope 1 "x" ;', 'CM_ BO_ 999 "c";', 'CM_ SG_ 100 Nope "c";', 'CM_ BU_ Ghost "c";', 'SG_MUL_VAL_ 999 S Sel 0-0;',
      'SG_MUL_VAL_ 100 Nope Sel 0-0;', 'SIG_VALTYPE_ 999 S : 1;', '']));

  add('52-value-not-whole.dbc', 'A value description for a raw value that is not a whole number.', 1, 1, ['DBC-VALUE-NOT-WHOLE'],
    lines(head('1', ['A', 'B']), [bo(100, 'M', 8, 'A'), u('S', 0, 8, 1, 'B'), '', 'VAL_ 100 S 1.5 "half" 2 "two" ;', '']));

  const gen = generateDbc({ messages: 300, signalsPerMessage: 6, seed: 20261112, nodes: 12, version: 'synthetic-300' });
  add('53-synthetic-300.dbc', 'About 300 messages built from a fixed seed by the helper generateDbc in this folder: mixed byte orders, extended IDs, multiplexed messages, value tables, attributes, comments.', gen.messages, gen.signals, [], gen.text,
    { builder: 'generateDbc({ messages: 300, signalsPerMessage: 6, seed: 20261112, nodes: 12, version: "synthetic-300" })' });

  add('54-spacing-and-tabs.dbc', 'Valid statements written with tabs, extra spaces, no indent, blank lines between signals and spaces inside the brackets.', 2, 3, [],
    lines(['VERSION\t"1"', '', 'BU_:\tA\tB   C', '', 'BO_\t100\tM1:\t8\tA', 'SG_ S1 :0|8@1+\t( 1 , 0 )\t[ 0 | 255 ]\t""\tB , C', '',
      '   SG_  S2  :  8|8@0+  (1,0)  [0|255]  "x"  C', '', 'BO_ 101  M2 :  2   B', ' SG_ S3 : 0|16@1- (0.5,0) [-16384|16383.5] "u" A', '']));

  return C;
}

function build() {
  const dir = path.join(__dirname, '..', 'fixtures', 'corpus');
  fs.mkdirSync(dir, { recursive: true });
  const corpus = buildCorpus();
  const manifest = { note: 'Written by test/helpers/gen-dbc.js --build. Counts and problem codes are written by hand from the design of each file.', files: [] };
  for (const c of corpus) {
    const bytes = Buffer.isBuffer(c.content) ? c.content : Buffer.from(c.content, 'utf8');
    fs.writeFileSync(path.join(dir, c.file), bytes);
    const entry = { file: c.file, description: c.description, encoding: c.encoding, messages: c.messages, signals: c.signals, orphans: c.orphans, expectCodes: c.expect, noErrors: !c.expect.some(function (x) { return ERROR_CODES.has(x); }), bytes: bytes.length };
    if (c.checks) entry.checks = c.checks;
    if (c.builder) entry.builder = c.builder;
    manifest.files.push(entry);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write('wrote ' + corpus.length + ' corpus files and manifest.json\n');
}

/** A decimal written with an exponent (1e-05, 2.5E+3) as plain digits; other text is returned as it is. */
function plainDecimal(text) {
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

module.exports = {
  generateDbc: generateDbc, mulberry32: mulberry32, motorolaStart: motorolaStart, physical: physical, rangeText: rangeText, decOf: decOf, decText: decText,
  plainDecimal: plainDecimal, ERROR_CODES: ERROR_CODES
};

if (require.main === module && process.argv.indexOf('--build') !== -1) build();
