'use strict';
// Multiplexing: simple and extended, nesting, loops, depth limit, conditions, groups, and the
// overlap check that knows which signals can be present in the same frame.

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/dbc/parse');
const V = require('../src/dbc/validate');
const M = require('../src/dbc/mux');
const C = require('../src/dbc/codec');
const { timed } = require('./helpers/hostile');

const HEAD = 'VERSION ""\n\nBS_:\n\nBU_: A B\n\n';

function sig(name, mux, start, len, extra) {
  return ' SG_ ' + name + (mux ? ' ' + mux : '') + ' : ' + start + '|' + len + (extra && extra.order ? '@' + extra.order : '@1') + (extra && extra.sign ? extra.sign : '+') + ' (1,0) [0|0] "" B';
}

function load(body, options) {
  const text = HEAD + body.join('\n') + '\n';
  const db = P.parseDbc(text);
  const result = V.validate(db, Object.assign({ text: text, maxProblems: 100000 }, options || {}));
  return { text: text, db: db, result: result, m: db.messages[0], codes: result.problems.map(function (p) { return p.code; }) };
}

function rows(m, bytes) {
  const out = {};
  for (const r of C.decodeMessage(m, Uint8Array.from(bytes), bytes.length).rows) out[r.signal.name] = r;
  return out;
}

const SIMPLE = [
  'BO_ 100 Page: 8 A',
  sig('Sel', 'M', 0, 8),
  sig('P0', 'm0', 8, 8),
  sig('P1', 'm1', 8, 16),
  sig('Always', '', 24, 8)
];

test('simple multiplexing: the selected page is decoded, the others are absent', () => {
  const t = load(SIMPLE);
  assert.deepEqual(t.codes, []);
  const r = rows(t.m, [1, 0x34, 0x12, 7, 0, 0, 0, 0]);
  assert.equal(r.Sel.rawText, '1');
  assert.equal(r.P0.status, 'absent');
  assert.equal(r.P1.status, 'ok');
  assert.equal(r.P1.rawText, String(0x1234));
  assert.equal(r.Always.rawText, '7');
  const r0 = rows(t.m, [0, 0x34, 0x12, 7, 0, 0, 0, 0]);
  assert.equal(r0.P0.status, 'ok');
  assert.equal(r0.P0.rawText, String(0x34));
  assert.equal(r0.P1.status, 'absent');
  const r2 = rows(t.m, [2, 0x34, 0x12, 7, 0, 0, 0, 0]);
  assert.equal(r2.P0.status, 'absent');
  assert.equal(r2.P1.status, 'absent');
});

test('conditions are written in plain words', () => {
  const t = load(SIMPLE);
  const mux = M.analyseMux(t.m);
  const by = t.m.signalIndex;
  assert.equal(M.conditionText(mux, by.get('P0')), 'present when Sel = 0');
  assert.equal(M.conditionText(mux, by.get('P1')), 'present when Sel = 1');
  assert.equal(M.conditionText(mux, by.get('Always')), '');
  assert.equal(M.conditionText(mux, by.get('Sel')), '');
  assert.equal(mux.any, true);
  assert.deepEqual(mux.switches.map(function (s) { return s.name; }), ['Sel']);
});

test('the analysis is kept on the message and gives the same answer twice', () => {
  const t = load(SIMPLE);
  assert.equal(M.analyseMux(t.m), M.analyseMux(t.m));
});

test('a message without multiplexing has no multiplexor and every signal is present in every frame', () => {
  const t = load(['BO_ 1 Plain: 8 A', sig('X', '', 0, 8), sig('Y', '', 8, 8)]);
  const mux = M.analyseMux(t.m);
  assert.equal(mux.any, false);
  assert.equal(mux.info.get(t.m.signals[0]).status, 'ok');
  assert.equal(mux.info.get(t.m.signals[1]).cond.size, 0);
  const g = M.groupsOf(t.m);
  assert.equal(g.groups.length, 1);
  assert.equal(g.groups[0].title, 'All signals');
  assert.equal(g.groups[0].signals.length, 2);
});

test('extended multiplexing: ranges of multiplexor values select a signal, the written m value is only a hint', () => {
  const t = load(['BO_ 101 Ext: 8 A', sig('Sel', 'M', 0, 8), sig('R', 'm0', 8, 8), 'SG_MUL_VAL_ 101 R Sel 3-5, 9-9;']);
  assert.deepEqual(t.codes, ['DBC-MUX-EXTENDED-MISMATCH']);
  assert.equal(rows(t.m, [4, 77, 0, 0, 0, 0, 0, 0]).R.status, 'ok');
  assert.equal(rows(t.m, [4, 77, 0, 0, 0, 0, 0, 0]).R.rawText, '77');
  assert.equal(rows(t.m, [0, 77, 0, 0, 0, 0, 0, 0]).R.status, 'absent');
  assert.equal(rows(t.m, [9, 77, 0, 0, 0, 0, 0, 0]).R.status, 'ok');
  assert.equal(rows(t.m, [6, 77, 0, 0, 0, 0, 0, 0]).R.status, 'absent');
  assert.equal(M.conditionText(M.analyseMux(t.m), t.m.signalIndex.get('R')), 'present when Sel = 3-5, 9');
});

test('extended multiplexing without a mismatch gives no problem', () => {
  const t = load(['BO_ 101 Ext: 8 A', sig('Sel', 'M', 0, 8), sig('R', 'm4', 8, 8), 'SG_MUL_VAL_ 101 R Sel 3-5;']);
  assert.deepEqual(t.codes, []);
});

const NESTED = [
  'BO_ 102 Nest: 8 A',
  sig('Top', 'M', 0, 4),
  sig('Mid', 'm1M', 4, 4),
  sig('Leaf', 'm2', 8, 8),
  'SG_MUL_VAL_ 102 Mid Top 1-1;',
  'SG_MUL_VAL_ 102 Leaf Mid 2-2;'
];

test('nested multiplexors: a leaf is present only when every multiplexor above it holds the right value', () => {
  const t = load(NESTED);
  assert.deepEqual(t.codes, []);
  const mux = M.analyseMux(t.m);
  const by = t.m.signalIndex;
  assert.equal(mux.info.get(by.get('Top')).depth, 0);
  assert.equal(mux.info.get(by.get('Mid')).depth, 1);
  assert.equal(mux.info.get(by.get('Leaf')).depth, 2);
  assert.equal(M.conditionText(mux, by.get('Leaf')), 'present when Top = 1 and Mid = 2');
  const all = rows(t.m, [0x21, 0x55, 0, 0, 0, 0, 0, 0]);
  assert.equal(all.Top.rawText, '1');
  assert.equal(all.Mid.rawText, '2');
  assert.equal(all.Leaf.status, 'ok');
  assert.equal(all.Leaf.rawText, '85');
  const wrongTop = rows(t.m, [0x22, 0x55, 0, 0, 0, 0, 0, 0]);
  assert.equal(wrongTop.Mid.status, 'absent');
  assert.equal(wrongTop.Leaf.status, 'absent');
  const wrongMid = rows(t.m, [0x11, 0x55, 0, 0, 0, 0, 0, 0]);
  assert.equal(wrongMid.Mid.status, 'ok');
  assert.equal(wrongMid.Leaf.status, 'absent');
});

test('encoding writes the multiplexors first and refuses to write an absent signal', () => {
  const t = load(NESTED);
  const ok = C.encodeMessage(t.db, t.m, { Top: '1', Mid: '2', Leaf: '85' });
  assert.equal(ok.ok, true);
  assert.deepEqual(Array.from(ok.bytes), [0x21, 0x55, 0, 0, 0, 0, 0, 0]);
  const absent = C.encodeMessage(t.db, t.m, { Top: '1', Mid: '1', Leaf: '85' });
  assert.equal(absent.ok, true);
  assert.equal(absent.rows[2].encoded, false);
  assert.ok(absent.warnings.some(function (w) { return /Leaf/.test(w); }));
});

test('two multiplexors without SG_MUL_VAL_ make a multiplexed signal ambiguous and it is not decoded', () => {
  const t = load(['BO_ 103 Two: 8 A', sig('S1', 'M', 0, 8), sig('S2', 'M', 8, 8), sig('X', 'm0', 16, 8)]);
  assert.ok(t.codes.includes('DBC-MUX-AMBIGUOUS'));
  const issue = t.result.problems.find(function (p) { return p.code === 'DBC-MUX-AMBIGUOUS'; });
  assert.match(issue.message, /S1, S2/);
  assert.equal(rows(t.m, [0, 0, 5, 0, 0, 0, 0, 0]).X.status, 'undecodable');
  assert.equal(M.analyseMux(t.m).info.get(t.m.signalIndex.get('X')).status, 'bad');
});

test('a multiplexed signal in a message without any multiplexor is reported and not decoded', () => {
  const t = load(['BO_ 104 None: 8 A', sig('X', 'm0', 0, 8)]);
  assert.ok(t.codes.includes('DBC-MUX-NO-MULTIPLEXOR'));
  assert.equal(rows(t.m, [1, 0, 0, 0, 0, 0, 0, 0]).X.status, 'undecodable');
});

test('SG_MUL_VAL_ that names a signal that is not a multiplexor, or that does not exist', () => {
  const plain = load(['BO_ 105 P: 8 A', sig('Sel', 'M', 0, 8), sig('Plain', '', 8, 8), sig('X', 'm0', 16, 8), 'SG_MUL_VAL_ 105 X Plain 0-0;']);
  assert.ok(plain.codes.includes('DBC-MUX-EXTENDED-UNKNOWN'));
  assert.equal(rows(plain.m, [0, 0, 5, 0, 0, 0, 0, 0]).X.status, 'undecodable');
  const missing = load(['BO_ 105 P: 8 A', sig('Sel', 'M', 0, 8), sig('X', 'm0', 16, 8), 'SG_MUL_VAL_ 105 X Nope 0-0;']);
  assert.ok(missing.codes.includes('DBC-MUX-EXTENDED-UNKNOWN'));
  const self = load(['BO_ 105 P: 8 A', sig('Sel', 'M', 0, 8), sig('X', 'm0M', 16, 8), 'SG_MUL_VAL_ 105 X X 0-0;']);
  assert.ok(self.codes.includes('DBC-MUX-EXTENDED-UNKNOWN'));
  const wrongMessage = load(['BO_ 105 P: 8 A', sig('Sel', 'M', 0, 8), sig('X', 'm0', 16, 8), 'SG_MUL_VAL_ 999 X Sel 0-0;']);
  assert.ok(wrongMessage.codes.includes('DBC-MUX-EXTENDED-UNKNOWN'));
});

test('SG_MUL_VAL_ for a signal that is not written as multiplexed is reported', () => {
  const t = load(['BO_ 106 P: 8 A', sig('Sel', 'M', 0, 8), sig('X', '', 8, 8), 'SG_MUL_VAL_ 106 X Sel 0-0;']);
  assert.ok(t.codes.includes('DBC-MUX-NOT-MULTIPLEXED'));
  assert.equal(rows(t.m, [9, 5, 0, 0, 0, 0, 0, 0]).X.status, 'ok');
});

test('a second SG_MUL_VAL_ for the same signal is reported and not used', () => {
  const t = load(['BO_ 107 P: 8 A', sig('Sel', 'M', 0, 8), sig('X', 'm1', 8, 8), 'SG_MUL_VAL_ 107 X Sel 1-1;', 'SG_MUL_VAL_ 107 X Sel 2-2;']);
  assert.ok(t.codes.includes('DBC-MUX-EXTENDED-DUPLICATE'));
  assert.equal(rows(t.m, [1, 5, 0, 0, 0, 0, 0, 0]).X.status, 'ok');
  assert.equal(rows(t.m, [2, 5, 0, 0, 0, 0, 0, 0]).X.status, 'absent');
});

test('an inverted range of multiplexor values is an error and the signal is not decoded', () => {
  const t = load(['BO_ 108 P: 8 A', sig('Sel', 'M', 0, 8), sig('X', 'm0', 8, 8), 'SG_MUL_VAL_ 108 X Sel 5-3;']);
  assert.ok(t.codes.includes('DBC-MUX-EXTENDED-RANGE'));
  assert.equal(rows(t.m, [4, 5, 0, 0, 0, 0, 0, 0]).X.status, 'undecodable');
});

test('multiplexors that select each other in a loop are reported; a signal that only depends on the loop is not', () => {
  const t = load(['BO_ 109 L: 8 A', sig('LA', 'm0M', 0, 4), sig('LB', 'm0M', 4, 4), sig('Dep', 'm0', 8, 8),
    'SG_MUL_VAL_ 109 LA LB 0-0;', 'SG_MUL_VAL_ 109 LB LA 0-0;', 'SG_MUL_VAL_ 109 Dep LA 0-0;']);
  const cycles = t.result.problems.filter(function (p) { return p.code === 'DBC-MUX-CYCLE'; });
  assert.equal(cycles.length, 2);
  const mux = M.analyseMux(t.m);
  assert.equal(mux.info.get(t.m.signalIndex.get('LA')).status, 'cycle');
  assert.equal(mux.info.get(t.m.signalIndex.get('LB')).status, 'cycle');
  const dep = mux.info.get(t.m.signalIndex.get('Dep'));
  assert.equal(dep.status, 'parent');
  assert.match(dep.reason, /part of a loop/);
  assert.equal(rows(t.m, [0, 0, 5, 0, 0, 0, 0, 0]).Dep.status, 'undecodable');
});

test('a loop of three and a signal that selects itself are found', () => {
  const three = load(['BO_ 110 L: 8 A', sig('A1', 'm0M', 0, 2), sig('A2', 'm0M', 2, 2), sig('A3', 'm0M', 4, 2),
    'SG_MUL_VAL_ 110 A1 A2 0-0;', 'SG_MUL_VAL_ 110 A2 A3 0-0;', 'SG_MUL_VAL_ 110 A3 A1 0-0;']);
  assert.equal(three.result.problems.filter(function (p) { return p.code === 'DBC-MUX-CYCLE'; }).length, 3);
  const mux = M.analyseMux(three.m);
  for (const s of three.m.signals) assert.equal(mux.info.get(s).status, 'cycle');
});

test('the depth limit is 32 levels below the first multiplexor', () => {
  function chain(count) {
    const lines = ['BO_ 111 Deep: 64 A', sig('S0', 'M', 0, 1)];
    for (let k = 1; k < count; k++) lines.push(sig('S' + k, 'm0M', k % 500, 1));
    for (let k = 1; k < count; k++) lines.push('SG_MUL_VAL_ 111 S' + k + ' S' + (k - 1) + ' 0-0;');
    return load(lines, { maxProblems: 1000 });
  }
  const ok = chain(33);
  assert.equal(ok.codes.includes('DBC-MUX-TOO-DEEP'), false, 'S0 to S32 are depths 0 to 32');
  assert.equal(M.analyseMux(ok.m).info.get(ok.m.signalIndex.get('S32')).depth, 32);
  const deep = chain(36);
  const flagged = deep.result.problems.filter(function (p) { return p.code === 'DBC-MUX-TOO-DEEP'; });
  assert.equal(flagged.length, 3, 'S33, S34 and S35');
  const mux = M.analyseMux(deep.m);
  assert.equal(mux.info.get(deep.m.signalIndex.get('S33')).status, 'bad');
  assert.equal(mux.info.get(deep.m.signalIndex.get('S32')).status, 'ok');
  assert.equal(rows(deep.m, new Array(64).fill(0)).S33.status, 'undecodable');
  assert.equal(rows(deep.m, new Array(64).fill(0)).S32.status, 'ok');
});

test('a multiplexor that is a floating-point signal cannot select anything', () => {
  const t = load(['BO_ 112 F: 8 A', sig('Sel', 'M', 0, 32), sig('X', 'm0', 32, 8), 'SIG_VALTYPE_ 112 Sel : 1;']);
  assert.ok(t.codes.includes('DBC-MUX-SWITCH-FLOAT'));
  assert.equal(rows(t.m, [0, 0, 0, 0, 5, 0, 0, 0]).X.status, 'undecodable');
});

test('a signed multiplexor compares its signed value; a range it can never hold is reported', () => {
  const t = load(['BO_ 113 S: 8 A', sig('Sel', 'M', 0, 8, { sign: '-' }), sig('X1', 'm1', 8, 8), sig('X255', 'm255', 16, 8)]);
  assert.ok(t.codes.includes('DBC-MUX-VALUE-RANGE'));
  const issue = t.result.problems.find(function (p) { return p.code === 'DBC-MUX-VALUE-RANGE'; });
  assert.match(issue.message, /can never hold 255/);
  assert.equal(rows(t.m, [1, 9, 8, 0, 0, 0, 0, 0]).X1.status, 'ok');
  const minusOne = rows(t.m, [0xFF, 9, 8, 0, 0, 0, 0, 0]);
  assert.equal(minusOne.Sel.rawText, '-1');
  assert.equal(minusOne.X1.status, 'absent');
  assert.equal(minusOne.X255.status, 'absent', '255 is not -1');
});

test('a multiplexor that selects nothing is a note', () => {
  const t = load(['BO_ 114 U: 8 A', sig('Sel', 'M', 0, 8), sig('Plain', '', 8, 8)]);
  assert.deepEqual(t.codes, ['DBC-MUX-UNUSED']);
});

test('groups: signals present in every frame, then one group per combination of multiplexor values', () => {
  const t = load(SIMPLE);
  const g = M.groupsOf(t.m);
  assert.equal(g.more, 0);
  assert.deepEqual(g.groups.map(function (x) { return x.title; }), ['Signals present in every frame', 'Sel = 0', 'Sel = 1']);
  assert.deepEqual(g.groups[0].signals.map(function (s) { return s.name; }), ['Sel', 'Always']);
  // each combination also shows the signals that are present in every frame
  assert.deepEqual(g.groups[1].signals.map(function (s) { return s.name; }), ['Sel', 'P0', 'Always']);
  assert.deepEqual(g.groups[2].signals.map(function (s) { return s.name; }), ['Sel', 'P1', 'Always']);
  assert.deepEqual(g.undecodable, []);
});

test('groups of nested multiplexors list the signals that belong to each combination', () => {
  const t = load(NESTED);
  const g = M.groupsOf(t.m);
  assert.deepEqual(g.groups.map(function (x) { return x.title; }), ['Signals present in every frame', 'Top = 1', 'Top = 1, Mid = 2']);
  assert.deepEqual(g.groups[0].signals.map(function (s) { return s.name; }), ['Top']);
  assert.deepEqual(g.groups[1].signals.map(function (s) { return s.name; }), ['Top', 'Mid']);
  assert.deepEqual(g.groups[2].signals.map(function (s) { return s.name; }), ['Top', 'Mid', 'Leaf']);
});

test('groups name the signals that are not decoded', () => {
  const t = load(['BO_ 103 Two: 8 A', sig('S1', 'M', 0, 8), sig('S2', 'M', 8, 8), sig('X', 'm0', 16, 8)]);
  const g = M.groupsOf(t.m);
  assert.deepEqual(g.undecodable.map(function (s) { return s.name; }), ['X']);
});

test('groups are limited and the number left out is reported', () => {
  const lines = ['BO_ 115 Many: 8 A', sig('Sel', 'M', 0, 8)];
  for (let k = 0; k < 100; k++) lines.push(sig('V' + k, 'm' + k, 8, 8));
  const t = load(lines);
  const g = M.groupsOf(t.m, 10);
  assert.equal(g.groups.length, 11);
  assert.equal(g.more, 90);
  assert.equal(M.groupsOf(t.m).more, 36, 'the default limit is 64 groups');
});

test('two signals are compatible unless a multiplexor holds different values for them', () => {
  const t = load(SIMPLE);
  const by = t.m.signalIndex;
  const mux = M.analyseMux(t.m);
  assert.equal(M.compatible(mux, by.get('P0'), by.get('P1')), false);
  assert.equal(M.compatible(mux, by.get('P0'), by.get('P0')), true);
  assert.equal(M.compatible(mux, by.get('P0'), by.get('Always')), true);
  assert.equal(M.compatible(mux, by.get('Always'), by.get('Sel')), true);
  const n = load(NESTED);
  const nm = M.analyseMux(n.m);
  assert.equal(M.compatible(nm, n.m.signalIndex.get('Leaf'), n.m.signalIndex.get('Mid')), true);
  const e = load(['BO_ 101 Ext: 8 A', sig('Sel', 'M', 0, 8), sig('R', 'm0', 8, 8), sig('Q', 'm0', 8, 8), 'SG_MUL_VAL_ 101 R Sel 3-5;', 'SG_MUL_VAL_ 101 Q Sel 5-7;']);
  const em = M.analyseMux(e.m);
  assert.equal(M.compatible(em, e.m.signalIndex.get('R'), e.m.signalIndex.get('Q')), true, 'both can be present when Sel is 5');
  assert.equal(M.intersects([[3n, 5n]], [[6n, 9n]]), false);
  assert.equal(M.intersects([[3n, 5n]], [[5n, 9n]]), true);
  assert.equal(M.within([[3n, 4n]], [[3n, 5n]]), true);
  assert.equal(M.within([[3n, 6n]], [[3n, 5n]]), false);
});

test('signals under different multiplexor values may share bits; under the same value they overlap', () => {
  const shared = load(SIMPLE);
  assert.equal(shared.codes.includes('DBC-SIGNAL-OVERLAP'), false);
  const same = load(['BO_ 116 O: 8 A', sig('Sel', 'M', 0, 8), sig('P0a', 'm0', 8, 8), sig('P0b', 'm0', 12, 8)]);
  const overlap = same.result.problems.filter(function (p) { return p.code === 'DBC-SIGNAL-OVERLAP'; });
  assert.equal(overlap.length, 1);
  assert.match(overlap[0].message, /^"P0b" uses bits 12 to 15, which "P0a" uses as well/);
  const unmuxed = load(['BO_ 117 O: 8 A', sig('A', '', 0, 8), sig('B', '', 4, 8)]);
  const o2 = unmuxed.result.problems.filter(function (p) { return p.code === 'DBC-SIGNAL-OVERLAP'; });
  assert.equal(o2.length, 1);
  assert.match(o2[0].message, /^"B" uses bits 4 to 7, which "A" uses as well/);
  const wide = load(['BO_ 118 O: 8 A', sig('Sel', 'M', 0, 8), sig('P0', 'm0', 8, 8), sig('P1', 'm1', 8, 8), sig('Wide', '', 8, 8)]);
  const o3 = wide.result.problems.filter(function (p) { return p.code === 'DBC-SIGNAL-OVERLAP'; });
  assert.equal(o3.length, 1);
  assert.match(o3[0].message, /^"Wide" uses bits 8 to 15, which "P0" uses as well \(it also overlaps "P1"\)/);
});

test('an overlap between a Motorola and an Intel signal is found by bit, not by byte', () => {
  // Intel 0|12 covers bits 0 to 11; Motorola start 15, length 4 covers bits 15 to 12 (byte 1, upper nibble).
  const apart = load(['BO_ 119 O: 8 A', sig('I', '', 0, 12), sig('Mo', '', 15, 4, { order: '0' })]);
  assert.equal(apart.codes.includes('DBC-SIGNAL-OVERLAP'), false);
  // Motorola start 11, length 4 covers bits 11 to 8 and meets the Intel signal on bits 8 to 11.
  const meet = load(['BO_ 119 O: 8 A', sig('I', '', 0, 12), sig('Mo', '', 11, 4, { order: '0' })]);
  const o = meet.result.problems.filter(function (p) { return p.code === 'DBC-SIGNAL-OVERLAP'; });
  assert.equal(o.length, 1);
  assert.match(o[0].message, /uses bits 8 to 11/);
});

test('an overlap check that would take too long stops early and says so', () => {
  const lines = ['BO_ 120 Pile: 8 A'];
  for (let k = 0; k < 3000; k++) lines.push(sig('P' + k, '', 0, 1));
  const run = timed(function () { return load(lines); });
  assert.ok(run.ms < 5000, 'took ' + run.ms + ' ms');
  assert.ok(run.value.codes.includes('DBC-CHECK-LIMIT'));
  assert.ok(run.value.codes.includes('DBC-SIGNAL-OVERLAP'));
  const few = load(lines.slice(0, 501));
  assert.equal(few.codes.includes('DBC-CHECK-LIMIT'), false);
  assert.equal(few.result.problems.filter(function (p) { return p.code === 'DBC-SIGNAL-OVERLAP'; }).length, 499);
});

test('the issues of the analysis point into the text', () => {
  const t = load(['BO_ 103 Two: 8 A', sig('S1', 'M', 0, 8), sig('S2', 'M', 8, 8), sig('X', 'm0', 16, 8), 'SG_MUL_VAL_ 103 X Nope 5-3;']);
  for (const p of t.result.problems) {
    assert.ok(p.start >= 0 && p.start <= p.end && p.end <= t.text.length, p.code + ' ' + p.start + '-' + p.end);
  }
});

test('many multiplexors and many multiplexed signals are analysed without quadratic work', () => {
  const lines = ['BO_ 121 Wide: 8 A'];
  for (let k = 0; k < 20000; k++) lines.push(sig('S' + k, 'M', 0, 1));
  lines.push(sig('Lone', 'm0', 8, 8));
  const run = timed(function () { return load(lines, { maxProblems: 10 }); });
  assert.ok(run.ms < 5000, 'took ' + run.ms + ' ms');
  assert.ok(run.value.codes.includes('DBC-MUX-AMBIGUOUS') || run.value.result.counts.error > 0);
});
