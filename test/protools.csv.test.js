'use strict';
// Tests of the signal list as CSV and of the DBC file made from a signal table.

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/dbc/parse');
const V = require('../src/dbc/validate');
const D = require('../src/dbc/decimal');
const B = require('../src/dbc/bits');
const U = require('../src/util');
const { sampleFor } = require('../src/samples');
const { signalsToCsv, csvToDbc, COLUMNS } = require('../src/pro/csvdbc');

const sampleText = sampleFor('valid').text;
const sample = P.parseDbc(sampleText);

// ---- helpers ----------------------------------------------------------------------------------

const DEFAULT_ROW = {
  message_id: '0x100', extended: 'FALSE', message: 'M', dlc: '8', sender: 'N', cycle_time_ms: '', signal: 'S', mux: '', start_bit: '0', length: '8', byte_order: 'intel', sign: 'unsigned',
  value_type: 'integer', factor: '1', offset: '0', minimum: '0', maximum: '0', unit: '', receivers: 'R', values: '', comment: '', message_comment: ''
};

function row(over) {
  const o = Object.assign({}, DEFAULT_ROW, over || {});
  return U.csvRow(COLUMNS.map(function (c) { return o[c]; }), false);
}

function table() { return U.csvRow(COLUMNS, false) + Array.prototype.slice.call(arguments).join(''); }

function lines(csvText) { return csvText.split('\r\n').filter(Boolean); }

function codesOf(db, text) { return new Set(V.validate(db, { text: text }).problems.map(function (p) { return p.code; })); }

/** Differences between two parsed databases, as a list of short texts (empty when they agree). */
function compare(a, b) {
  const diffs = [];
  const ma = a.messages.filter(function (m) { return !m.pseudo; });
  const mb = b.messages.filter(function (m) { return !m.pseudo; });
  if (ma.length !== mb.length) return ['message count ' + ma.length + ' / ' + mb.length];
  ma.forEach(function (m, i) {
    const n = mb[i];
    for (const k of ['rawId', 'extended', 'frameId', 'name', 'size', 'sender']) if (m[k] !== n[k]) diffs.push(m.name + ': ' + k + ' ' + m[k] + ' / ' + n[k]);
    if ((m.comment || '') !== (n.comment || '')) diffs.push(m.name + ': comment');
    if (P.cycleTimeOf(a, m) !== P.cycleTimeOf(b, n)) diffs.push(m.name + ': cycle time');
    if (m.signals.length !== n.signals.length) { diffs.push(m.name + ': signal count'); return; }
    m.signals.forEach(function (s, j) {
      const t = n.signals[j];
      const where = m.name + '.' + s.name + ': ';
      for (const k of ['name', 'startBit', 'length', 'little', 'signed', 'valueType', 'muxText', 'unit']) if (s[k] !== t[k]) diffs.push(where + k + ' ' + s[k] + ' / ' + t[k]);
      for (const k of ['factorText', 'offsetText', 'minText', 'maxText']) if (D.cmp(D.parse(s[k]), D.parse(t[k])) !== 0) diffs.push(where + k + ' ' + s[k] + ' / ' + t[k]);
      if (JSON.stringify(s.receivers) !== JSON.stringify(t.receivers)) diffs.push(where + 'receivers');
      if ((s.comment || '') !== (t.comment || '')) diffs.push(where + 'comment');
      const va = s.values ? s.values.map(function (e) { return e.value + '=' + e.text; }) : [];
      const vb = t.values ? t.values.map(function (e) { return e.value + '=' + e.text; }) : [];
      if (JSON.stringify(va) !== JSON.stringify(vb)) diffs.push(where + 'values ' + va + ' / ' + vb);
    });
  });
  return diffs;
}

function roundTrip(db) {
  const csv = signalsToCsv(db);
  const result = csvToDbc(csv);
  return { csv: csv, result: result, db: P.parseDbc(result.dbc) };
}

// A small seeded source of random numbers and a builder of random, valid databases.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NODE_NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];
const VALUE_TEXTS = ['Off', 'On', 'a;b', 'x=y', 'back\\slash', 'say "hi"', '100%', 'tilde ~', 'Ünï ☃', 'plain text', 'trailing ', ' leading', '=1+1', '-dash'];
const COMMENT_TEXTS = ['Plain comment', 'with "quotes" and \\ backslash', 'two\nlines of text', 'semi;colon, comma | pipe', '=not a formula', '-dash', 'Ünïcödé ☃', 'tab\there'];
const UNITS = ['', 'rpm', 'km/h', '%', 'deg"C', 'a\\b', 'V'];
const FACTORS = ['1', '0.25', '0.001', '100', '2.5E-3', '0.1', '0.5', '1e-05', '0.0000001'];
const OFFSETS = ['0', '0', '-40', '32768', '-0.5', '1E2', '12.5'];
const RANGES = ['0|0', '0|100', '-40|215', '-1024|1023.5', '0|65535'];

function randomDbc(seed) {
  const r = rng(seed);
  const int = function (n) { return Math.floor(r() * n); };
  const pick = function (list) { return list[int(list.length)]; };
  const esc = function (t) { return t.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); };
  const nodes = NODE_NAMES.slice(0, 2 + int(5));
  const out = ['VERSION "r' + seed + '"', '', 'BU_: ' + nodes.join(' '), ''];
  const defs = [];
  const after = [];
  const used = new Set();
  let cycles = false;
  const count = 1 + int(8);
  for (let i = 0; i < count; i++) {
    const extended = r() < 0.3;
    let frame;
    do { frame = extended ? 0x800 + int(0x1FFFFFFF - 0x800) : int(0x800); } while (used.has((extended ? 'x' : 's') + frame));
    used.add((extended ? 'x' : 's') + frame);
    const raw = extended ? frame + 0x80000000 : frame;
    const dlc = pick([1, 2, 3, 4, 5, 6, 7, 8, 8, 8, 12, 16, 24, 64]);
    const bits = dlc * 8;
    const mname = 'Msg' + i + 'x' + (seed % 97);
    out.push('BO_ ' + raw + ' ' + mname + ': ' + dlc + ' ' + (r() < 0.1 ? 'Vector__XXX' : pick(nodes)));
    const receivers = function () {
      const list = nodes.filter(function () { return r() < 0.4; });
      return list.length ? list.join(',') : 'Vector__XXX';
    };
    const free = new Array(bits).fill(true);
    const place = function (len, little, avoid) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const start = little ? int(bits - len + 1) : B.linearBit(int(bits - len + 1));
        const layout = B.layoutOf(start, len, little);
        if (!layout || layout.bytes > dlc) continue;
        const cells = B.bitsOf(layout);
        if (cells.every(function (b) { return avoid[b]; })) { for (const b of cells) avoid[b] = false; return start; }
      }
      return -1;
    };
    const signalLine = function (name, mux, start, len, little, signed, factor, offset, range, unit) {
      return ' SG_ ' + name + (mux ? ' ' + mux : '') + ' : ' + start + '|' + len + '@' + (little ? 1 : 0) + (signed ? '-' : '+') + ' (' + factor + ',' + offset + ') [' + range + '] "' + esc(unit) + '" ' + receivers();
    };
    const decorate = function (name, floatType) {
      if (floatType) after.push('SIG_VALTYPE_ ' + raw + ' ' + name + ' : ' + floatType + ';');
      else if (r() < 0.35) {
        const n = 1 + int(4);
        const entries = [];
        for (let k = 0; k < n; k++) entries.push(k + ' "' + esc(pick(VALUE_TEXTS)) + '"');
        after.push('VAL_ ' + raw + ' ' + name + ' ' + entries.reverse().join(' ') + ' ;');
      }
      if (r() < 0.3) after.push('CM_ SG_ ' + raw + ' ' + name + ' "' + esc(pick(COMMENT_TEXTS)) + '";');
    };
    if (dlc >= 4 && r() < 0.2) {
      out.push(signalLine('Sel' + i, 'M', 0, 8, true, false, '1', '0', '0|3', ''));
      for (let v = 0; v < 2; v++) {
        const avoid = free.slice();
        for (let b = 0; b < 8; b++) avoid[b] = false;
        for (let k = 0; k < 2; k++) {
          const len = pick([1, 4, 8, 12]);
          const start = place(len, true, avoid);
          if (start < 0) continue;
          const name = 'Mx' + i + '_' + v + '_' + k;
          out.push(signalLine(name, 'm' + v, start, len, true, false, pick(FACTORS), pick(OFFSETS), pick(RANGES), pick(UNITS)));
          decorate(name, 0);
        }
      }
    } else {
      const n = int(7);
      for (let k = 0; k < n; k++) {
        const wantFloat = r() < 0.1;
        const len = wantFloat ? pick([32, 64]) : pick([1, 1, 2, 3, 4, 5, 8, 8, 10, 12, 16, 16, 24, 32, 32, 64]);
        if (len > bits) continue;
        const little = r() < 0.5;
        const start = place(len, little, free);
        if (start < 0) continue;
        const name = 'S' + i + '_' + k;
        out.push(signalLine(name, '', start, len, little, r() < 0.3, wantFloat ? '1' : pick(FACTORS), wantFloat ? '0' : pick(OFFSETS), pick(RANGES), pick(UNITS)));
        decorate(name, wantFloat ? (len === 32 ? 1 : 2) : 0);
      }
    }
    out.push('');
    if (r() < 0.3) after.push('CM_ BO_ ' + raw + ' "' + esc(pick(COMMENT_TEXTS)) + '";');
    if (r() < 0.6) { cycles = true; after.push('BA_ "GenMsgCycleTime" BO_ ' + raw + ' ' + (1 + int(2000)) + ';'); }
  }
  if (cycles) defs.push('BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;', 'BA_DEF_DEF_ "GenMsgCycleTime" 0;');
  return out.concat(defs, after, ['']).join('\n');
}

// ---- export -----------------------------------------------------------------------------------

test('export: the header names the columns in order', () => {
  const csv = signalsToCsv(sample);
  assert.equal(lines(csv)[0], 'message_id,extended,message,dlc,sender,cycle_time_ms,signal,mux,start_bit,length,byte_order,sign,value_type,factor,offset,minimum,maximum,unit,receivers,values,comment,message_comment');
  assert.equal(COLUMNS.length, 22);
});

test('export: the row of EngineSpeed is exact', () => {
  const l = lines(signalsToCsv(sample));
  assert.ok(l.includes('0x100,FALSE,EngineStatus,8,EngineUnit,10,EngineSpeed,,0,16,intel,unsigned,integer,0.25,0,0,8000,rpm,Dashboard;Gateway,,Crankshaft speed.,"Engine speed, coolant temperature, throttle position and torque."'));
});

test('export: a signed signal keeps its negative range and offset', () => {
  const l = lines(signalsToCsv(sample));
  assert.ok(l.includes('0x100,FALSE,EngineStatus,8,EngineUnit,10,EngineTorque,,32,12,intel,signed,integer,0.5,0,-1024,1023.5,Nm,GearUnit,,,"Engine speed, coolant temperature, throttle position and torque."'));
  assert.ok(l.some(function (x) { return x.startsWith('0x100,FALSE,EngineStatus,8,EngineUnit,10,CoolantTemp,,16,8,intel,unsigned,integer,1,-40,-40,150,degC,Dashboard,'); }));
});

test('export: a big-endian signal and an extended frame', () => {
  const l = lines(signalsToCsv(sample));
  assert.ok(l.includes('0x120,FALSE,GearStatus,4,GearUnit,20,VehicleSpeed,,15,16,motorola,unsigned,integer,0.01,0,0,300,km/h,Dashboard;BrakeUnit;Gateway,,,'));
  assert.ok(l.includes('0x18FF50E5,TRUE,ChargerStatus,8,ChargerUnit,100,ChargeCurrent,,0,16,intel,signed,integer,0.1,0,-3276.8,3276.7,A,Dashboard;Gateway,,,'));
});

test('export: a float signal and the multiplexer markers', () => {
  const l = lines(signalsToCsv(sample));
  assert.ok(l.includes('0x300,FALSE,AmbientSensor,8,Gateway,50,AmbientPressure,,0,32,intel,signed,float32,1,0,0,2000,hPa,Dashboard;EngineUnit,,,'));
  assert.ok(l.some(function (x) { return x.startsWith('0x200,FALSE,TripComputer,8,Dashboard,100,PageIndex,M,0,8,'); }));
  assert.ok(l.some(function (x) { return x.startsWith('0x200,FALSE,TripComputer,8,Dashboard,100,TripDistance,m0,8,24,'); }));
});

test('export: value descriptions are raw=text pairs, with ; and \\ escaped', () => {
  const l = lines(signalsToCsv(sample));
  assert.ok(l.some(function (x) { return x.includes(',EngineRunning,,44,1,intel,unsigned,integer,1,0,0,1,,Dashboard,1=Running;0=Stopped,'); }));
  const db = P.parseDbc('VERSION ""\nBU_: N\nBO_ 1 M: 8 N\n SG_ S : 0|8@1+ (1,0) [0|0] "" N\nVAL_ 1 S 1 "a;b\\\\c=d" 0 "x" ;\n');
  assert.equal(db.messages[0].signals[0].values[0].text, 'a;b\\c=d');
  assert.ok(lines(signalsToCsv(db))[1].includes(',1=a\\;b\\\\c=d;0=x,'));
});

test('export: a message without signals gets one row with empty signal columns', () => {
  const db = P.parseDbc('VERSION ""\nBU_: N\nBO_ 5 Empty: 4 N\nCM_ BO_ 5 "No signals yet.";\n');
  const l = lines(signalsToCsv(db));
  assert.equal(l.length, 2);
  // Five cells of the message, sixteen empty cells (cycle time and the fifteen signal columns before the comments), the message comment.
  assert.equal(l[1], ['0x5', 'FALSE', 'Empty', '4', 'N'].concat(new Array(16).fill(''), ['No signals yet.']).join(','));
  assert.equal(l[1].split(',').length, 22);
});

test('export: signals without a message are not listed', () => {
  const db = P.parseDbc('VERSION ""\nBU_: N\nBO_ 3221225472 VECTOR__INDEPENDENT_SIG_MSG: 0 Vector__XXX\n SG_ Loose : 0|8@1+ (1,0) [0|0] "" N\nBO_ 1 M: 8 N\n SG_ S : 0|8@1+ (1,0) [0|0] "" N\n');
  const l = lines(signalsToCsv(db));
  assert.equal(l.length, 2);
  assert.ok(!l.join('\n').includes('Loose'));
});

test('export: hostile text keeps the cell count and is neutralised', () => {
  const text = 'VERSION ""\nBU_: N\nBO_ 1 M: 8 N\n SG_ S : 0|8@1+ (1,0) [0|0] "=1+1" N\nCM_ SG_ 1 S "=cmd|\' /C calc\'!A0, \\"quoted\\"\nline two @SUM(1) +5 -3 \u202E";\nCM_ BO_ 1 "-2+3";\nVAL_ 1 S 1 "@x" 0 "\\"" ;\n';
  const csv = signalsToCsv(P.parseDbc(text));
  const rows = U.parseCsv(csv).rows;
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.length, 22);
  for (const r of rows.slice(1)) for (const c of r) assert.ok(!/^[=+\-@\t\r]/.test(c) || /^-?\d+(\.\d+)?$/.test(c), c);
  assert.equal(rows[1][17], '\'=1+1');
  assert.ok(rows[1][20].startsWith('\'=cmd|'));
  assert.equal(rows[1][21], '\'-2+3');
  const raw = signalsToCsv(P.parseDbc(text), { neutralise: false });
  assert.equal(U.parseCsv(raw).rows[1][17], '=1+1');
});

// ---- the DBC that is written ---------------------------------------------------------------------

test('import: the DBC lines written for known rows are exact', () => {
  const r = csvToDbc(signalsToCsv(sample));
  assert.deepEqual(r.problems, []);
  assert.equal(r.messages, 8);
  assert.equal(r.signals, 30);
  const l = r.dbc.split('\n');
  assert.equal(l[0], 'VERSION ""');
  assert.ok(l.includes('NS_ :'));
  assert.ok(l.includes('BS_:'));
  assert.ok(l.includes('BU_: EngineUnit Dashboard Gateway GearUnit BrakeUnit ChargerUnit'));
  assert.ok(l.includes('BO_ 256 EngineStatus: 8 EngineUnit'));
  assert.ok(l.includes('BO_ 2566869221 ChargerStatus: 8 ChargerUnit'));
  assert.ok(l.includes(' SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|8000] "rpm" Dashboard,Gateway'));
  assert.ok(l.includes(' SG_ EngineTorque : 32|12@1- (0.5,0) [-1024|1023.5] "Nm" GearUnit'));
  assert.ok(l.includes(' SG_ VehicleSpeed : 15|16@0+ (0.01,0) [0|300] "km/h" Dashboard,BrakeUnit,Gateway'));
  assert.ok(l.includes(' SG_ PageIndex M : 0|8@1+ (1,0) [0|3] "" Gateway'));
  assert.ok(l.includes(' SG_ TripDistance m0 : 8|24@1+ (0.1,0) [0|1677721.5] "km" Gateway'));
  assert.ok(l.includes('CM_ SG_ 256 EngineSpeed "Crankshaft speed.";'));
  assert.ok(l.includes('CM_ BO_ 256 "Engine speed, coolant temperature, throttle position and torque.";'));
  assert.ok(l.includes('VAL_ 256 EngineRunning 1 "Running" 0 "Stopped" ;'));
  assert.ok(l.includes('SIG_VALTYPE_ 768 AmbientPressure : 1;'));
  assert.ok(l.includes('BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;'));
  assert.ok(l.includes('BA_DEF_DEF_ "GenMsgCycleTime" 0;'));
  assert.ok(l.includes('BA_ "GenMsgCycleTime" BO_ 256 10;'));
  assert.ok(l.includes('BA_ "GenMsgCycleTime" BO_ 2566869221 100;'));
});

test('import: the written DBC reads back without new problems', () => {
  const t = roundTrip(sample);
  assert.deepEqual(compare(sample, t.db), []);
  const before = codesOf(sample, sampleText);
  for (const c of codesOf(t.db, t.result.dbc)) assert.ok(before.has(c), c);
  assert.equal(codesOf(t.db, t.result.dbc).size, 0);
});

test('round trip: the sample with six planted problems keeps its signals', () => {
  const db = P.parseDbc(sampleFor('problems').text);
  const t = roundTrip(db);
  // Three planted problems cannot be written: the signal beyond the data length, the second message
  // with the ID 288 and the ID above 0x7FF without the extended flag. Every other row survives.
  const refused = t.result.problems.filter(function (p) { return p.refused; });
  assert.equal(refused.length, 3);
  assert.ok(refused.some(function (p) { return /does not fit into the 8 data bytes/.test(p.message); }));
  assert.ok(refused.some(function (p) { return /already used by the message GearStatus/.test(p.message); }));
  assert.ok(refused.some(function (p) { return /11 bits/.test(p.message); }));
  assert.equal(t.result.messages, 2);
  assert.equal(t.result.signals, 3);
  assert.ok(t.result.problems.some(function (p) { return !p.refused && /minimum of GearSelected is greater/.test(p.message); }));
});

test('round trip: 200 seeded random databases come back unchanged and without new problems', () => {
  let signals = 0;
  let floats = 0;
  let multiplexed = 0;
  let values = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const text = randomDbc(seed * 7919);
    const db = P.parseDbc(text);
    assert.deepEqual(db.problems, [], 'seed ' + seed + ' did not parse');
    const t = roundTrip(db);
    assert.deepEqual(t.result.problems, [], 'seed ' + seed + ': ' + JSON.stringify(t.result.problems.slice(0, 2)));
    assert.deepEqual(compare(db, t.db), [], 'seed ' + seed);
    const before = codesOf(db, text);
    for (const c of codesOf(t.db, t.result.dbc)) assert.ok(before.has(c), 'seed ' + seed + ' gained ' + c);
    for (const m of db.messages) for (const s of m.signals) { signals++; if (s.valueType) floats++; if (s.muxText) multiplexed++; if (s.values) values++; }
  }
  assert.ok(signals > 400, 'only ' + signals + ' signals were built');
  assert.ok(floats > 10 && multiplexed > 10 && values > 30, floats + ' floats, ' + multiplexed + ' multiplexed, ' + values + ' with values');
});

// ---- reading the table -------------------------------------------------------------------------

test('import: semicolon and tab delimiters, a byte order mark and other line ends', () => {
  const rows = [row({}), row({ message_id: '0x101', message: 'M2', signal: 'T', start_bit: '8' })];
  const comma = table.apply(null, rows);
  const base = csvToDbc(comma);
  assert.deepEqual(base.problems, []);
  for (const [name, text] of [
    ['semicolon', comma.split('\r\n').map(function (l) { return U.parseCsv(l).rows.map(function (r) { return r.join(';'); }).join(''); }).join('\r\n')],
    ['tab', comma.split('\r\n').map(function (l) { return U.parseCsv(l).rows.map(function (r) { return r.join('\t'); }).join(''); }).join('\r\n')],
    ['bom', '\uFEFF' + comma],
    ['lf', comma.replace(/\r\n/g, '\n')],
    ['cr', comma.replace(/\r\n/g, '\r')]
  ]) {
    const r = csvToDbc(text);
    assert.deepEqual(r.problems, [], name);
    assert.equal(r.dbc, base.dbc, name);
  }
});

test('import: header names are case-insensitive, other column names and orders work, extra columns are ignored', () => {
  const text = 'Signal,Length,"Start Bit",Notes,MESSAGE,Message ID\r\nSpeed,16,0,ignored,Drive,0x10\r\nTemp,8,16,ignored too,Drive,0x10\r\n';
  const r = csvToDbc(text);
  assert.deepEqual(r.problems, []);
  assert.equal(r.messages, 1);
  assert.equal(r.signals, 2);
  const l = r.dbc.split('\n');
  assert.ok(l.includes('BO_ 16 Drive: 8 Vector__XXX'));
  assert.ok(l.includes(' SG_ Speed : 0|16@1+ (1,0) [0|0] "" Vector__XXX'));
  assert.ok(l.includes(' SG_ Temp : 16|8@1+ (1,0) [0|0] "" Vector__XXX'));
});

test('import: a standard-length ID above 0x7FF without the extended cell is read as extended', () => {
  const r = csvToDbc('message_id,message,signal,start_bit,length\r\n0x18FEF100,Engine,Speed,0,8\r\n0x7FF,Low,Speed,0,8\r\n');
  assert.deepEqual(r.problems, []);
  assert.ok(r.dbc.includes('BO_ ' + (0x18FEF100 + 0x80000000) + ' Engine: 8 Vector__XXX'));
  assert.ok(r.dbc.includes('BO_ 2047 Low: 8 Vector__XXX'));
});

test('import: rows that only define a message, and a table with no signal column', () => {
  const a = csvToDbc(table(row({ signal: '', start_bit: '', length: '', receivers: '' })));
  assert.deepEqual(a.problems, []);
  assert.equal(a.messages, 1);
  assert.equal(a.signals, 0);
  assert.ok(a.dbc.includes('BO_ 256 M: 8 N\n'));
  const b = csvToDbc('message_id,message,dlc\r\n0x20,Plain,4\r\n');
  assert.equal(b.messages, 1);
  assert.ok(b.dbc.includes('BO_ 32 Plain: 4 Vector__XXX'));
});

const REFUSED = [
  ['a message_id that is not an ID', { message_id: 'zz' }, /message_id "zz"/],
  ['a standard ID above 0x7FF', { message_id: '0x800', extended: 'FALSE' }, /11 bits/],
  ['an ID above 29 bits', { message_id: '0x20000000', extended: 'TRUE' }, /29 bits/],
  ['an extended cell that is not yes or no', { extended: 'maybe' }, /not TRUE or FALSE/],
  ['a message name that starts with a digit', { message: '1abc' }, /message name/],
  ['a message named like a DBC keyword', { message: 'CM_' }, /message name/],
  ['a dlc that is not a frame length', { dlc: '9' }, /not a data length/],
  ['a dlc that is not a number', { dlc: 'eight' }, /not a data length/],
  ['a sender with a space', { sender: 'A B' }, /sender/],
  ['a cycle time below zero', { cycle_time_ms: '-5' }, /cycle_time_ms/],
  ['a cycle time above one hour', { cycle_time_ms: '3600001' }, /cycle_time_ms/],
  ['a signal name with a space', { signal: 'a b' }, /signal name/],
  ['a start bit that is not a number', { start_bit: 'a' }, /start_bit/],
  ['a length of 0', { length: '0' }, /length/],
  ['a length of 65', { length: '65' }, /length/],
  ['a signal beyond the data length', { start_bit: '60', length: '8' }, /does not fit/],
  ['a big-endian signal beyond the data length', { start_bit: '63', length: '16', byte_order: 'motorola' }, /does not fit/],
  ['a decimal comma in the factor', { factor: '1,5' }, /decimal separator/],
  ['a factor that is not a number', { factor: 'abc' }, /factor/],
  ['an offset with an exponent that is too large', { offset: '1e999' }, /offset/],
  ['a byte order that is neither intel nor motorola', { byte_order: 'sideways' }, /byte_order/],
  ['a sign that is neither signed nor unsigned', { sign: 'maybe' }, /sign/],
  ['an unknown value type', { value_type: 'complex' }, /value_type/],
  ['a 32-bit float with 16 bits', { value_type: 'float32', length: '16' }, /32-bit float/],
  ['a 64-bit float with 32 bits', { value_type: 'float64', length: '32' }, /64-bit float/],
  ['float with a length that is neither 32 nor 64', { value_type: 'float', length: '12' }, /32 or 64/],
  ['a multiplexer marker that is not valid', { mux: 'x1' }, /mux cell/],
  ['a receiver that starts with a digit', { receivers: '9x' }, /receiver/],
  ['a values entry without an equals sign', { values: 'abc' }, /without "raw=text"/],
  ['a values entry with a raw value that is not whole', { values: '1.5=a' }, /not a whole number/],
  ['a raw value that is described twice', { values: '1=a;1=b' }, /described twice/]
];

for (const [name, over, pattern] of REFUSED) {
  test('import refuses ' + name + ' with its line number and writes nothing for it', () => {
    const r = csvToDbc(table(row(over)));
    assert.equal(r.problems.length, 1, JSON.stringify(r.problems));
    assert.equal(r.problems[0].line, 2);
    assert.equal(r.problems[0].refused, true);
    assert.match(r.problems[0].message, pattern);
    assert.equal(r.messages, 0);
    assert.equal(r.signals, 0);
    assert.equal(r.dbc, '');
  });
}

test('import: rows that disagree with earlier rows of the same message are refused at their own line', () => {
  const r = csvToDbc(table(
    row({}),
    row({ message: 'Other', signal: 'T', start_bit: '8' }),
    row({ message_id: '0x101', message: 'M', signal: 'T', start_bit: '8' }),
    row({ signal: 'S', start_bit: '8' }),
    row({ signal: 'U', start_bit: '8', dlc: '4' }),
    row({ signal: 'V', start_bit: '8', sender: 'Z' }),
    row({ signal: 'W', start_bit: '8', cycle_time_ms: '10' }),
    row({ signal: 'X', start_bit: '16' })
  ));
  const refused = r.problems.filter(function (p) { return p.refused; });
  assert.deepEqual(refused.map(function (p) { return p.line; }), [3, 4, 5, 6, 7]);
  assert.match(refused[0].message, /already used by the message M/);
  assert.match(refused[1].message, /name M is already used by another ID/);
  assert.match(refused[2].message, /already has a signal named S/);
  assert.match(refused[3].message, /dlc 4 differs/);
  assert.match(refused[4].message, /sender Z differs/);
  assert.equal(r.problems.length, 5);
  // Row 7 (cycle time 10) is accepted because the message had no cycle time yet; row 8 follows.
  assert.equal(r.signals, 3);
});

test('import: good rows are still converted when other rows are refused', () => {
  const r = csvToDbc(table(row({}), row({ signal: 'T', start_bit: 'x' }), row({ signal: 'U', start_bit: '16' })));
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].line, 3);
  assert.equal(r.signals, 2);
  assert.ok(r.dbc.includes(' SG_ S : 0|8@1+'));
  assert.ok(r.dbc.includes(' SG_ U : 16|8@1+'));
  assert.ok(!r.dbc.includes(' SG_ T '));
});

test('import: line numbers count the lines inside quoted cells', () => {
  const r = csvToDbc(table(row({ comment: 'one\ntwo\nthree' }), row({ signal: 'T', start_bit: 'x' })));
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].line, 5);
  const b = csvToDbc(table(row({ comment: 'x\r\ny' }), row({ signal: 'T', start_bit: 'x' })));
  assert.equal(b.problems[0].line, 4);
});

test('import: structural problems of the whole table', () => {
  const noId = csvToDbc('message,signal\r\nM,S\r\n');
  assert.equal(noId.dbc, '');
  assert.match(noId.problems[0].message, /no column "message_id"/);
  assert.equal(noId.problems[0].line, 1);
  const empty = csvToDbc('');
  assert.equal(empty.dbc, '');
  assert.match(empty.problems[0].message, /no rows/);
  const headerOnly = csvToDbc(U.csvRow(COLUMNS, false));
  assert.equal(headerOnly.dbc, '');
  assert.deepEqual(headerOnly.problems, []);
  const wide = csvToDbc(table(row({}).replace(/\r\n$/, ',extra,cells\r\n'), row({ signal: 'T', start_bit: '8' })));
  assert.equal(wide.problems.length, 1);
  assert.match(wide.problems[0].message, /has 24 cells but the header has 22/);
  assert.equal(wide.signals, 1);
  const open = csvToDbc(table(row({}), 'x,"never closed\r\nmore\r\n'));
  assert.equal(open.problems.length, 1);
  assert.equal(open.problems[0].line, 3);
  assert.match(open.problems[0].message, /never closed/);
  assert.equal(open.signals, 1);
});

test('import: a zero factor and an inverted range are kept with a warning', () => {
  const r = csvToDbc(table(row({ factor: '0' }), row({ signal: 'T', start_bit: '8', minimum: '10', maximum: '1' })));
  assert.equal(r.signals, 2);
  assert.deepEqual(r.problems.map(function (p) { return [p.line, p.refused]; }), [[2, false], [3, false]]);
  assert.match(r.problems[0].message, /factor of S is 0/);
  assert.match(r.problems[1].message, /minimum of T is greater/);
});

test('import: decimals stay exact, also beyond what a binary float can hold', () => {
  const r = csvToDbc(table(
    row({ factor: '0.000000000000000001', offset: '-123456789012345678.123456789', minimum: '0', maximum: '18446744073709551.615' }),
    row({ signal: 'T', start_bit: '8', factor: '1E-3', offset: '+.5', minimum: '1e2', maximum: '2.5E+3' })
  ));
  assert.deepEqual(r.problems, []);
  assert.ok(r.dbc.includes(' SG_ S : 0|8@1+ (0.000000000000000001,-123456789012345678.123456789) [0|18446744073709551.615] "" R'));
  assert.ok(r.dbc.includes(' SG_ T : 8|8@1+ (0.001,0.5) [100|2500] "" R'));
});

test('import: value descriptions with quotes, backslashes, semicolons and equals signs survive', () => {
  const values = '3=say "hi"\\; bye;2=back\\\\slash;1=a=b';
  const r = csvToDbc(table(row({ values: values })));
  assert.deepEqual(r.problems, []);
  assert.ok(r.dbc.includes('VAL_ 256 S 3 "say \\"hi\\"; bye" 2 "back\\\\slash" 1 "a=b" ;'));
  const back = P.parseDbc(r.dbc).messages[0].signals[0].values.map(function (e) { return e.value + '=' + e.text; });
  assert.deepEqual(back, ['3=say "hi"; bye', '2=back\\slash', '1=a=b']);
});

test('import: quotes and backslashes in comments and units are written as DBC files write them', () => {
  const r = csvToDbc(table(row({ comment: 'say "hi" \\ done', unit: 'deg"C', message_comment: 'path C:\\x\\y' })));
  assert.ok(r.dbc.includes(' SG_ S : 0|8@1+ (1,0) [0|0] "deg\\"C" R'));
  assert.ok(r.dbc.includes('CM_ SG_ 256 S "say \\"hi\\" \\\\ done";'));
  assert.ok(r.dbc.includes('CM_ BO_ 256 "path C:\\\\x\\\\y";'));
  const db = P.parseDbc(r.dbc);
  assert.equal(db.messages[0].signals[0].comment, 'say "hi" \\ done');
  assert.equal(db.messages[0].signals[0].unit, 'deg"C');
  assert.equal(db.messages[0].comment, 'path C:\\x\\y');
});

test('import: a comment cannot end itself early or smuggle in a statement', () => {
  const evil = 'first line\nBO_ 5 Evil: 8 X\n SG_ Bad : 0|8@1+ (1,0) [0|0] "" X\nCM_ "fake";\nlast line';
  const r = csvToDbc(table(row({ comment: evil, message_comment: 'a\nVAL_ 1 S 1 "x" ;\nb' })));
  assert.deepEqual(r.problems, []);
  const db = P.parseDbc(r.dbc);
  assert.deepEqual(db.problems, []);
  assert.equal(db.messages.length, 1);
  assert.equal(db.messages[0].signals.length, 1);
  // The three lines that look like statements are joined to the line before them; the last line stays on its own line.
  assert.equal(db.messages[0].signals[0].comment, 'first line BO_ 5 Evil: 8 X  SG_ Bad : 0|8@1+ (1,0) [0|0] "" X CM_ "fake";\nlast line');
  assert.equal(db.messages[0].comment, 'a VAL_ 1 S 1 "x" ;\nb');
});

test('import: the apostrophe of a neutralised cell is removed, and only that', () => {
  const text = 'VERSION ""\nBU_: N\nBO_ 1 M: 8 N\n SG_ S : 0|8@1+ (1,0) [0|0] "=1+1" N\nCM_ SG_ 1 S "=SUM(1)";\nCM_ BO_ 1 "\'plain";\n';
  const db = P.parseDbc(text);
  const t = roundTrip(db);
  assert.deepEqual(compare(db, t.db), []);
  assert.equal(t.db.messages[0].signals[0].unit, '=1+1');
  assert.equal(t.db.messages[0].signals[0].comment, '=SUM(1)');
  assert.equal(t.db.messages[0].comment, '\'plain');
});

test('import: cycle times become an INT attribute, or a FLOAT attribute when one is fractional', () => {
  const whole = csvToDbc(table(row({ cycle_time_ms: '10' })));
  assert.ok(whole.dbc.includes('BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;'));
  assert.ok(whole.dbc.includes('BA_ "GenMsgCycleTime" BO_ 256 10;'));
  const frac = csvToDbc(table(row({ cycle_time_ms: '2.5' })));
  assert.ok(frac.dbc.includes('BA_DEF_ BO_ "GenMsgCycleTime" FLOAT 0 3600000;'));
  assert.ok(frac.dbc.includes('BA_ "GenMsgCycleTime" BO_ 256 2.5;'));
  assert.equal(P.cycleTimeOf(P.parseDbc(frac.dbc), P.parseDbc(frac.dbc).messages[0]), 2.5);
  const none = csvToDbc(table(row({ cycle_time_ms: '0' })));
  assert.ok(!none.dbc.includes('GenMsgCycleTime'));
});

test('import: the VERSION text can be given and stays on one line', () => {
  const r = csvToDbc(table(row({})), { version: '2.1 "beta"\nline' });
  assert.equal(r.dbc.split('\n')[0], 'VERSION "2.1 \\"beta\\" line"');
});

test('import: 20,000 rows are converted in under 5 seconds', () => {
  const rows = [];
  for (let i = 0; i < 20000; i++) rows.push(row({ message_id: '0x' + (i + 1).toString(16), extended: 'TRUE', message: 'Msg' + i, signal: 'Sig' + i, factor: '0.1', maximum: '25.5' }));
  const t = Date.now();
  const r = csvToDbc(table.apply(null, rows));
  const ms = Date.now() - t;
  assert.equal(r.signals, 20000);
  assert.deepEqual(r.problems, []);
  assert.ok(ms < 5000, ms + ' ms');
});
