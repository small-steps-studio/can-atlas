'use strict';
// The reader (src/dbc/parse.js): every kind of statement, the text offsets of names, numbers and
// specifications, linking of later statements to messages and signals, recovery after errors.

const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../src/dbc/parse');

const FULL = [
  'VERSION "3.1 beta"',
  '',
  'NS_ :',
  '\tCM_',
  '\tBA_',
  '',
  'BS_:',
  '',
  'BU_: Alpha Beta Gamma',
  ' Delta',
  '',
  'VAL_TABLE_ Gears 2 "Two" 1 "One" 0 "N" ;',
  '',
  'BO_ 100 First: 8 Alpha',
  ' SG_ Mux M : 0|4@1+ (1,0) [0|15] "" Beta',
  ' SG_ Speed m1 : 8|16@0- (0.01,-5) [-327.68|327.67] "km/h" Beta,Gamma',
  '',
  'BO_ 2147483748 Second: 4 Vector__XXX',
  ' SG_ Flag : 0|1@1+ (1,0) [0|1] "" Gamma',
  '',
  'BO_TX_BU_ 100 : Beta,Gamma;',
  'CM_ "Network";',
  'CM_ BU_ Alpha "Node";',
  'CM_ BO_ 100 "Msg";',
  'CM_ SG_ 100 Speed "Sig";',
  'BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;',
  'BA_DEF_ SG_ "Mode" ENUM "A","B";',
  'BA_DEF_ "Name" STRING ;',
  'BA_DEF_ "Ratio" FLOAT 0 1;',
  'BA_DEF_ BO_ "Mask" HEX 0 255;',
  'BA_DEF_DEF_ "GenMsgCycleTime" 0;',
  'BA_ "GenMsgCycleTime" BO_ 100 20;',
  'BA_ "Name" "Net";',
  'BA_ "Mode" SG_ 100 Speed 1;',
  'VAL_ 100 Mux 1 "One" 0 "Zero" ;',
  'SIG_VALTYPE_ 2147483748 Flag : 1;',
  'SG_MUL_VAL_ 100 Speed Mux 1-2, 5-5;',
  ''
].join('\n');

const db = P.parseDbc(FULL);
const slice = function (a, b) { return FULL.slice(a, b); };

test('a complete file is read without a single problem', () => {
  assert.deepEqual(db.problems, []);
  assert.equal(db.length, FULL.length);
  assert.equal(db.messages.length, 2);
  assert.equal(db.orphanSignals.length, 0);
});

test('VERSION, nodes (also on a continuation line) and value tables', () => {
  assert.equal(db.version.text, '3.1 beta');
  assert.equal(slice(db.version.start, db.version.end), 'VERSION "3.1 beta"');
  assert.deepEqual(db.nodes.map(function (n) { return n.name; }), ['Alpha', 'Beta', 'Gamma', 'Delta']);
  for (const n of db.nodes) assert.equal(slice(n.start, n.end), n.name);
  assert.equal(db.nodeByName.get('Delta'), db.nodes[3]);
  assert.equal(db.valueTables.length, 1);
  const t = db.valueTables[0];
  assert.equal(t.name, 'Gears');
  assert.equal(slice(t.nameStart, t.nameEnd), 'Gears');
  assert.deepEqual(t.entries.map(function (e) { return [e.value, e.text]; }), [[2n, 'Two'], [1n, 'One'], [0n, 'N']]);
  assert.equal(slice(t.entries[0].start, t.entries[0].end), '2 "Two"');
  assert.equal(db.valueTableByName.get('Gears'), t);
});

test('messages: identifier, extended flag, name, length, sender and their offsets', () => {
  const [first, second] = db.messages;
  assert.equal(first.name, 'First');
  assert.equal(first.rawId, 100);
  assert.equal(first.idText, '100');
  assert.equal(first.extended, false);
  assert.equal(first.frameId, 100);
  assert.equal(first.size, 8);
  assert.equal(first.sender, 'Alpha');
  assert.equal(first.pseudo, false);
  assert.equal(slice(first.start, first.start + 3), 'BO_');
  assert.equal(slice(first.idStart, first.idEnd), '100');
  assert.equal(slice(first.nameStart, first.nameEnd), 'First');
  assert.equal(slice(first.sizeStart, first.sizeEnd), '8');
  assert.equal(slice(first.senderStart, first.senderEnd), 'Alpha');
  assert.equal(slice(first.start, first.headerEnd), 'BO_ 100 First: 8 Alpha');
  assert.equal(first.end, first.signals[1].end);
  assert.equal(second.rawId, 2147483748);
  assert.equal(second.extended, true);
  assert.equal(second.frameId, 100);
  assert.equal(second.sender, 'Vector__XXX');
  assert.equal(second.index, 1);
  assert.equal(db.messageByRawId.get(100), first);
  assert.equal(db.messageByRawId.get(2147483748), second);
  assert.equal(db.messageByName.get('Second'), second);
});

test('signals: every field and every offset', () => {
  const [mux, speed] = db.messages[0].signals;
  assert.equal(mux.name, 'Mux');
  assert.equal(mux.isMultiplexor, true);
  assert.equal(mux.muxText, 'M');
  assert.equal(mux.muxValue, null);
  assert.equal(slice(mux.muxStart, mux.muxEnd), 'M');
  assert.equal(speed.name, 'Speed');
  assert.equal(speed.isMultiplexor, false);
  assert.equal(speed.muxValue, 1n);
  assert.equal(speed.muxText, 'm1');
  assert.equal(speed.startBit, 8);
  assert.equal(speed.length, 16);
  assert.equal(speed.little, false);
  assert.equal(speed.signed, true);
  assert.equal(speed.factorText, '0.01');
  assert.equal(speed.offsetText, '-5');
  assert.equal(speed.minText, '-327.68');
  assert.equal(speed.maxText, '327.67');
  assert.equal(speed.unit, 'km/h');
  assert.deepEqual(speed.receivers, ['Beta', 'Gamma']);
  assert.equal(slice(speed.start, speed.start + 3), 'SG_');
  assert.equal(slice(speed.nameStart, speed.nameEnd), 'Speed');
  assert.equal(slice(speed.specStart, speed.specEnd), '8|16@0-');
  assert.equal(slice(speed.scaleStart, speed.scaleEnd), '(0.01,-5)');
  assert.equal(slice(speed.rangeStart, speed.rangeEnd), '[-327.68|327.67]');
  assert.equal(slice(speed.unitStart, speed.unitEnd), '"km/h"');
  assert.equal(slice(speed.receiverPos[0], speed.receiverPos[1]), 'Beta');
  assert.equal(slice(speed.receiverPos[2], speed.receiverPos[3]), 'Gamma');
  assert.equal(speed.index, 1);
  assert.equal(speed.valueType, 0);
  assert.equal(db.messages[0].signalIndex.get('Speed'), speed);
  const flag = db.messages[1].signals[0];
  assert.equal(flag.little, true);
  assert.equal(flag.signed, false);
  assert.equal(flag.length, 1);
});

test('later statements are linked to their message, signal and node', () => {
  const [first] = db.messages;
  const speed = first.signals[1];
  assert.deepEqual(first.transmitters, ['Beta', 'Gamma']);
  assert.equal(db.fileComment, 'Network');
  assert.equal(db.nodeByName.get('Alpha').comment, 'Node');
  assert.equal(first.comment, 'Msg');
  assert.equal(speed.comment, 'Sig');
  assert.deepEqual(first.signals[0].values.map(function (e) { return [e.value, e.text]; }), [[1n, 'One'], [0n, 'Zero']]);
  assert.equal(db.messages[1].signals[0].valueType, 1);
  assert.equal(speed.muxSpec.switchName, 'Mux');
  assert.deepEqual(speed.muxSpec.ranges.map(function (r) { return [r.lo, r.hi]; }), [[1n, 2n], [5n, 5n]]);
  assert.equal(slice(speed.muxSpec.ranges[0].start, speed.muxSpec.ranges[0].end), '1-2');
  assert.equal(slice(speed.muxSpec.ranges[1].start, speed.muxSpec.ranges[1].end), '5-5');
  assert.equal(db.transmitters.length, 1);
  assert.equal(db.comments.length, 4);
  assert.deepEqual(db.comments.map(function (c) { return c.target.kind; }), ['file', 'node', 'message', 'signal']);
  assert.equal(db.comments.every(function (c) { return !c.unknown; }), true);
});

test('attribute definitions, defaults and values', () => {
  assert.deepEqual(db.attributeDefs.map(function (d) { return [d.name, d.objectType, d.type, d.min, d.max]; }), [
    ['GenMsgCycleTime', 'BO_', 'INT', '0', '65535'], ['Mode', 'SG_', 'ENUM', null, null], ['Name', '', 'STRING', null, null], ['Ratio', '', 'FLOAT', '0', '1'], ['Mask', 'BO_', 'HEX', '0', '255']]);
  assert.deepEqual(db.attributeDefs[1].enumValues, ['A', 'B']);
  assert.equal(slice(db.attributeDefs[0].nameStart, db.attributeDefs[0].nameEnd), '"GenMsgCycleTime"');
  assert.equal(db.attributeDefaults.length, 1);
  assert.equal(db.attributeDefaults[0].value.text, '0');
  assert.equal(db.attributeDefaults[0].value.isString, false);
  const [first, second] = db.messages;
  const v = P.attributeValue(db, first, 'GenMsgCycleTime');
  assert.deepEqual([v.text, v.number, v.explicit, v.isString], ['20', 20, true, false]);
  const d = P.attributeValue(db, second, 'GenMsgCycleTime');
  assert.deepEqual([d.text, d.number, d.explicit], ['0', 0, false], 'the default of the definition applies');
  const net = P.attributeValue(db, db.network, 'Name');
  assert.deepEqual([net.text, net.isString, net.number], ['Net', true, null]);
  const mode = P.attributeValue(db, first.signals[1], 'Mode');
  assert.equal(mode.enumText, 'B', 'an ENUM value given as an index is named');
  assert.equal(P.attributeValue(db, first, 'Nothing'), null);
  assert.equal(P.cycleTimeOf(db, first), 20);
  assert.equal(P.cycleTimeOf(db, second), null, 'a cycle time of 0 means none');
});

test('the names used in later statements are collected in text order, with their offsets', () => {
  assert.ok(db.refs.length >= 9);
  for (let i = 1; i < db.refs.length; i++) assert.ok(db.refs[i].start >= db.refs[i - 1].start, 'refs sorted');
  for (const r of db.refs) {
    if (r.kind === 'node') assert.equal(slice(r.start, r.end), r.name);
    if (r.kind === 'signal') assert.equal(slice(r.start, r.end), r.name);
    if (r.kind === 'message') assert.equal(slice(r.start, r.end), String(r.rawId));
  }
});

test('the cycle time also comes from the attribute CycleTime, and is ignored when it is not a positive number', () => {
  const text = ['BU_: A', 'BO_ 1 M: 8 A', ' SG_ S : 0|8@1+ (1,0) [0|0] "" A', 'BA_DEF_ BO_ "CycleTime" INT 0 100;', 'BA_ "CycleTime" BO_ 1 50;', ''].join('\n');
  const d = P.parseDbc(text);
  assert.equal(P.cycleTimeOf(d, d.messages[0]), 50);
  const e = P.parseDbc(text.replace('BO_ 1 50', 'BO_ 1 -5'));
  assert.equal(P.cycleTimeOf(e, e.messages[0]), null);
});

test('the pseudo message for signals without a message is recognised', () => {
  const d = P.parseDbc(['BU_: A', 'BO_ 3221225472 VECTOR__INDEPENDENT_SIG_MSG: 0 Vector__XXX', ' SG_ Free : 0|8@1+ (1,0) [0|0] "" A', ''].join('\n'));
  assert.equal(d.messages[0].pseudo, true);
  assert.equal(d.messages[0].signals.length, 1);
});

test('statements of other kinds are passed over without an error', () => {
  const text = ['BU_: A', 'BO_ 1 M: 8 A', ' SG_ S : 0|8@1+ (1,0) [0|0] "" A',
    'EV_ Temp: 0 [-40|85] "degC" 0 1 DUMMY_NODE_VECTOR0 Vector__XXX;', 'ENVVAR_DATA_ Temp: 8;', 'SIG_GROUP_ 1 Grp 1 : S;', 'CAT_DEF_ 1 "x" 1;', 'FILTER "f";',
    'BA_DEF_REL_ BU_SG_REL_ "Rel" STRING ;', 'BA_REL_ "Rel" BU_SG_REL_ A SG_ 1 S "v";', 'SGTYPE_ t : 8@1+ (1,0) [0|1] "" 0,Tab;', 'CM_ EV_ Temp "c";', ''].join('\n');
  const d = P.parseDbc(text);
  assert.deepEqual(d.problems, []);
  assert.equal(d.messages[0].signals.length, 1);
  assert.deepEqual(d.envVars.map(function (e) { return e.name; }), ['Temp']);
  assert.equal(d.signalTypes.length, 1);
  assert.equal(d.signalTypes[0].table.name, 'Tab');
  assert.equal(d.comments[0].unknown, false);
});

test('after a broken statement the reader continues with the next one', () => {
  const text = ['BU_: A B', 'BO_ 1 M: 8 A', ' SG_ Bad : 0|x@1+ (1,0) [0|0] "" B', ' SG_ Good : 8|8@1+ (1,0) [0|0] "" B', 'BO_ x Broken: 8 A', 'BO_ 2 Next: 8 A', ' SG_ Two : 0|8@1+ (1,0) [0|0] "" B', ''].join('\n');
  const d = P.parseDbc(text);
  assert.deepEqual(d.problems.map(function (p) { return p.code; }), ['DBC-SYNTAX', 'DBC-SYNTAX']);
  assert.deepEqual(d.messages.map(function (m) { return m.name; }), ['M', 'Next']);
  assert.deepEqual(d.messages[0].signals.map(function (s) { return s.name; }), ['Good']);
  assert.deepEqual(d.messages[1].signals.map(function (s) { return s.name; }), ['Two']);
  const [p1, p2] = d.problems;
  assert.match(p1.message, /Expected the length in bits after "\|", found "x@1\+/);
  assert.equal(text.slice(p1.start, p1.start + 1), 'x');
  assert.match(p2.message, /Expected the message ID \(a whole number\) after BO_, found "x Broken/);
  assert.equal(text.slice(p2.start, p2.start + 1), 'x');
});

test('error positions point at the offending text', () => {
  const cases = [
    ['BO_ 1 M 8 A', /Expected ":" after the message name/, '8'],
    ['BO_ 1 M: A', /Expected the data length in bytes/, 'A'],
    ['BU_ A B', /Expected ":" after BU_/, null],
    [' SG_ S 0|8@1+ (1,0) [0|0] "" A', /Expected ":" or a multiplexer indicator|Expected ":" after the signal name/, null],
    ['BO_ 1 M: 8 A\n SG_ S : 0|8@2+ (1,0) [0|0] "" A', /byte order after "@" must be 1 \(little-endian\) or 0 \(big-endian\)/, '2'],
    ['BO_ 1 M: 8 A\n SG_ S : 0|8@1* (1,0) [0|0] "" A', /followed by \+ \(unsigned\) or - \(signed\)/, '*'],
    ['BO_ 1 M: 8 A\n SG_ S : 0|8@1+ (1;0) [0|0] "" A', /Expected "," between the factor and the offset/, ';'],
    ['BO_ 1 M: 8 A\n SG_ S : 0|8@1+ (1,0) [0,0] "" A', /Expected "\|" between the minimum and the maximum/, ','],
    ['BO_ 1 M: 8 A\n SG_ S : 0|8@1+ (1,0) [0|0] A', /Expected the unit in double quotes/, 'A']
  ];
  for (const [text, pattern, token] of cases) {
    const d = P.parseDbc(text + '\n');
    assert.ok(d.problems.length >= 1, text);
    const p = d.problems[0];
    assert.match(p.message, pattern, text);
    assert.equal(p.code, 'DBC-SYNTAX');
    assert.ok(p.end > p.start && p.end <= text.length + 1);
    if (token !== null) assert.equal(text.slice(p.start, p.start + token.length), token, text);
  }
});

test('strings: escapes, line breaks inside comments, and the end of a string that never closes', () => {
  const text = ['BU_: A', 'BO_ 1 M: 8 A', ' SG_ S : 0|8@1+ (1,0) [0|0] "" A', String.raw`CM_ SG_ 1 S "a \"quoted\" word and a back\\slash";`, 'CM_ BO_ 1 "line one', 'line two;', 'line three";',
    'VAL_ 1 S 0 "zero; with semicolon" 1 "x" ;', ''].join('\n');
  const d = P.parseDbc(text);
  assert.deepEqual(d.problems, []);
  assert.equal(d.messages[0].signals[0].comment, 'a "quoted" word and a back\\slash');
  assert.equal(d.messages[0].comment, 'line one\nline two;\nline three');
  assert.deepEqual(d.messages[0].signals[0].values.map(function (e) { return e.text; }), ['zero; with semicolon', 'x']);
  // A comment line that looks like a statement ends the comment: the string is reported as not closed.
  const cut = P.parseDbc(['BU_: A', 'CM_ "first line', 'BO_ 7 NotReally: 8 A', 'still comment";', ''].join('\n'));
  assert.ok(cut.problems.some(function (p) { return p.code === 'DBC-STRING-UNTERMINATED'; }));
  assert.equal(cut.messages.length, 1);
  assert.equal(cut.messages[0].name, 'NotReally');
});

test('numbers: signs, decimals and exponents in factors, offsets and ranges', () => {
  const d = P.parseDbc(['BU_: A', 'BO_ 1 M: 8 A', ' SG_ S : 0|8@1+ (+1.5E-3,-.25) [-1e2|+2.5e+3] "" A', ''].join('\n'));
  assert.deepEqual(d.problems, []);
  const s = d.messages[0].signals[0];
  assert.deepEqual([s.factorText, s.offsetText, s.minText, s.maxText], ['+1.5E-3', '-.25', '-1e2', '+2.5e+3']);
});

test('huge identifiers and sizes do not become wrong numbers', () => {
  const d = P.parseDbc(['BU_: A', 'BO_ 99999999999999999999 Big: 99999999999999999999 A', ''].join('\n'));
  assert.equal(d.messages[0].rawId, Infinity);
  assert.equal(d.messages[0].idText, '99999999999999999999');
  assert.equal(d.messages[0].size, Infinity);
  assert.equal(d.messages[0].extended, false);
  const e = P.parseDbc('BO_ 4294967295 Top: 8 A\n');
  assert.equal(e.messages[0].extended, true);
  assert.equal(e.messages[0].frameId, 2147483647);
});

test('line ends and byte order marks do not change what is read', () => {
  const lf = P.parseDbc(FULL);
  const crlf = P.parseDbc(FULL.replace(/\n/g, '\r\n'));
  const cr = P.parseDbc(FULL.replace(/\n/g, '\r'));
  const bom = P.parseDbc('﻿' + FULL);
  const shape = function (x) { return JSON.stringify([x.problems.length, x.messages.map(function (m) { return [m.name, m.signals.map(function (s) { return s.name + s.comment; }), m.comment, m.transmitters]; }), x.nodes.length, x.valueTables.length, x.attributes.length]); };
  assert.equal(shape(crlf), shape(lf));
  assert.equal(shape(cr), shape(lf));
  assert.equal(shape(bom), shape(lf));
  assert.equal(crlf.messages[0].comment, 'Msg');
});

test('input that is not text and text that is not a DBC file never throw', () => {
  for (const input of [undefined, null, 5, {}, '', ' ', '\n\n', '\0\0\0', '"', '(', ')', ';;;;', 'BO_', 'SG_', 'BO_ 1', 'CM_', 'VAL_', 'BA_', 'BA_DEF_', 'SG_MUL_VAL_', 'SIG_VALTYPE_', 'BO_TX_BU_', 'SGTYPE_', 'EV_', 'NS_', 'BU_:', 'VERSION', 'VAL_TABLE_']) {
    const d = P.parseDbc(input);
    assert.ok(Array.isArray(d.messages));
    assert.ok(Array.isArray(d.problems));
  }
  assert.equal(P.parseDbc(undefined).length, 0);
  assert.equal(P.parseDbc(12345).length, 5);
});

test('every problem found by the reader lies inside the text and has a message', () => {
  const junk = ['BO_ 1 M: 8 A\n SG_ S : 0|8@1+ (1,0) [0|0] "" A\nCM_ "x\n', 'VAL_ 1 S 1 "a" 2\n', 'BA_ "x" BO_ 1\n', '"""\n', 'SG_MUL_VAL_ 1 S X 1-\n', 'BA_DEF_ BO_ "x" ENUM "a",\n'];
  for (const text of junk) {
    const d = P.parseDbc(text);
    for (const p of d.problems) {
      assert.ok(p.start >= 0 && p.end >= p.start && p.end <= text.length, JSON.stringify(text) + ' ' + p.start + '-' + p.end);
      assert.ok(p.message.length > 5);
      assert.ok(['error', 'warning'].indexOf(p.severity) !== -1);
    }
  }
});

test('a value description whose raw value is not a whole number is ignored with a warning', () => {
  const d = P.parseDbc(['BU_: A', 'BO_ 1 M: 8 A', ' SG_ S : 0|8@1+ (1,0) [0|0] "" A', 'VAL_ 1 S 1.5 "half" 2 "two" ;', ''].join('\n'));
  assert.deepEqual(d.problems.map(function (p) { return p.code; }), ['DBC-VALUE-NOT-WHOLE']);
  assert.deepEqual(d.messages[0].signals[0].values.map(function (e) { return e.value; }), [2n]);
});

test('statements are found only at the start of a line, so a keyword inside a name or a string does not start one', () => {
  const d = P.parseDbc(['BU_: A', 'BO_ 1 M: 8 A', ' SG_ BO_Value : 0|8@1+ (1,0) [0|0] "BO_ 5 X: 8 A" A', ''].join('\n'));
  assert.deepEqual(d.problems, []);
  assert.equal(d.messages.length, 1);
  assert.equal(d.messages[0].signals[0].name, 'BO_Value');
  assert.equal(d.messages[0].signals[0].unit, 'BO_ 5 X: 8 A');
});
