'use strict';
// The checks (src/dbc/validate.js): messages that name the right things, severities, limits, and
// the guarantee that every documented code is produced by the corpus or by a test in this file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../src/dbc/parse');
const V = require('../src/dbc/validate');
const U = require('../src/util');

function run(text, options) {
  const db = P.parseDbc(text);
  return V.validate(db, Object.assign({ text: text }, options || {}));
}
function codes(text, options) { return run(text, options).problems.map(function (p) { return p.code; }).sort(); }
function find(text, code, options) { return run(text, options).problems.filter(function (p) { return p.code === code; }); }
function sig(name, spec, mux, receivers) { return ' SG_ ' + name + (mux ? ' ' + mux : '') + ' : ' + spec + ' (1,0) [0|0] "" ' + (receivers || 'B'); }
function msg(signals, size, extra, id) { return ['BU_: A B', 'BO_ ' + (id || 1) + ' M: ' + (size === undefined ? 8 : size) + ' A'].concat(signals, extra || [], ['']).join('\n'); }

test('overlaps name both signals and the shared bits', () => {
  let p = find(msg([sig('A', '0|8@1+'), sig('B', '4|8@1+')]), 'DBC-SIGNAL-OVERLAP');
  assert.equal(p.length, 1);
  assert.match(p[0].message, /^"B" uses bits 4 to 7, which "A" uses as well; both can be present in the same frame/);
  p = find(msg([sig('A', '0|16@1+'), sig('B', '7|8@0+')]), 'DBC-SIGNAL-OVERLAP');
  assert.match(p[0].message, /^"B" uses bits 0 to 7, which "A" uses as well/, 'Intel against Motorola');
  p = find(msg([sig('A', '0|8@1+'), sig('B', '7|8@1+')]), 'DBC-SIGNAL-OVERLAP');
  assert.match(p[0].message, /^"B" uses bit 7, which "A" uses as well/);
  p = find(msg([sig('A', '0|8@1+'), sig('B', '8|8@1+'), sig('C', '4|8@1+')]), 'DBC-SIGNAL-OVERLAP');
  assert.equal(p.length, 1);
  assert.match(p[0].message, /^"C" uses bits 4 to 7, which "A" uses as well \(it also overlaps "B"\)/);
  // Two Motorola signals that look apart by start bit but share bits.
  p = find(msg([sig('A', '7|16@0+'), sig('B', '15|8@0+')]), 'DBC-SIGNAL-OVERLAP');
  assert.match(p[0].message, /^"B" uses bits 8 to 15, which "A" uses as well/);
  assert.deepEqual(codes(msg([sig('A', '7|8@0+'), sig('B', '15|8@0+'), sig('C', '16|8@1+')])), []);
  // The problem points at the specification of the second signal.
  const text = msg([sig('A', '0|8@1+'), sig('B', '4|8@1+')]);
  const q = find(text, 'DBC-SIGNAL-OVERLAP')[0];
  assert.equal(text.slice(q.start, q.end), '4|8@1+');
});

test('signals multiplexed on different values do not overlap, on the same value they do', () => {
  const sel = sig('Sel', '0|8@1+', 'M');
  assert.deepEqual(codes(msg([sel, sig('A', '8|8@1+', 'm0'), sig('B', '8|8@1+', 'm1')])), []);
  assert.deepEqual(codes(msg([sel, sig('A', '8|8@1+', 'm0'), sig('B', '8|8@1+', 'm0')])), ['DBC-SIGNAL-OVERLAP']);
  assert.deepEqual(codes(msg([sel, sig('A', '8|8@1+', 'm0'), sig('B', '12|8@1+')])), ['DBC-SIGNAL-OVERLAP'], 'a signal in every frame overlaps a multiplexed one');
  assert.deepEqual(codes(msg([sel, sig('A', '0|4@1+', 'm1')])), ['DBC-SIGNAL-OVERLAP'], 'a multiplexed signal on the bits of the multiplexor');
});

test('signals beyond the data length say how many bytes there are and, for Motorola, remind that the start bit is the most significant bit', () => {
  let p = find(msg([sig('A', '8|16@1+')], 2), 'DBC-SIGNAL-OUTSIDE-FRAME');
  assert.equal(p.length, 1);
  assert.match(p[0].message, /^"A" \(little-endian, bits 8 to 23, up to byte 2\) does not fit into the 2 data bytes of the message\.$/);
  p = find(msg([sig('A', '15|16@0+')], 2), 'DBC-SIGNAL-OUTSIDE-FRAME');
  assert.match(p[0].message, /^"A" \(big-endian, most significant bit 15, least significant bit 16 in byte 2\) does not fit into the 2 data bytes of the message\. For big-endian signals the start bit is the most significant bit\.$/);
  p = find(msg([sig('A', '0|9@1+')], 1), 'DBC-SIGNAL-OUTSIDE-FRAME');
  assert.match(p[0].message, /does not fit into the 1 data byte of the message/);
  assert.deepEqual(codes(msg([sig('A', '7|16@0+')], 2)), []);
  assert.deepEqual(codes(msg([sig('A', '0|16@1+')], 2)), []);
  assert.deepEqual(codes(msg([sig('A', '0|1@1+')], 0)), ['DBC-SIGNAL-OUTSIDE-FRAME']);
  // A start bit that would wrap a 32-bit counter is still outside the frame.
  assert.deepEqual(codes(msg([sig('A', '2147483648|8@1+')], 8)), ['DBC-SIGNAL-OUTSIDE-FRAME']);
  assert.deepEqual(codes(msg([sig('A', '4294967296|8@0+')], 8)), ['DBC-SIGNAL-OUTSIDE-FRAME']);
});

test('lengths, float types and scaling numbers', () => {
  assert.match(find(msg([sig('A', '0|0@1+')]), 'DBC-SIGNAL-LENGTH')[0].message, /The length of "A" is 0 bits; a signal needs 1 to 64 bits/);
  assert.match(find(msg([sig('A', '0|65@1+')]), 'DBC-SIGNAL-LENGTH')[0].message, /is 65 bits/);
  const flt = msg([sig('F', '0|16@1+')], 8, ['SIG_VALTYPE_ 1 F : 2;']);
  assert.match(find(flt, 'DBC-VALTYPE-INVALID')[0].message, /"F" is declared as a 64-bit float \(value type 2\) and needs a length of 64 bits, not 16; it is not decoded\./);
  assert.deepEqual(codes(msg([sig('F', '0|32@1+')], 8, ['SIG_VALTYPE_ 1 F : 1;'])), []);
  assert.deepEqual(codes(msg([sig('F', '0|64@1+')], 8, ['SIG_VALTYPE_ 1 F : 2;'])), []);
  const zero = ['BU_: A B', 'BO_ 1 M: 8 A', ' SG_ Z : 0|8@1+ (0,5) [0|0] "" B', ''].join('\n');
  assert.match(find(zero, 'DBC-FACTOR-ZERO')[0].message, /The factor of "Z" is 0, so every raw value gives the same physical value/);
  const inv = ['BU_: A B', 'BO_ 1 M: 8 A', ' SG_ Z : 0|8@1+ (1,0) [10|5] "" B', ''].join('\n');
  assert.match(find(inv, 'DBC-RANGE-INVERTED')[0].message, /The minimum 10 of "Z" is greater than its maximum 5\./);
  const out = ['BU_: A B', 'BO_ 1 M: 8 A', ' SG_ Z : 0|8@1+ (1,0) [0|300] "" B', ' SG_ Y : 8|8@1- (0.5,-10) [-100|53.5] "" B', ''].join('\n');
  const o = find(out, 'DBC-RANGE-OUTSIDE-RAW');
  assert.equal(o.length, 2);
  assert.match(o[0].message, /goes beyond what its 8 unsigned raw bits can express with factor 1 and offset 0: 0 to 255\./);
  assert.match(o[1].message, /its 8 signed raw bits can express with factor 0.5 and offset -10: -74 to 53.5\./);
  const exact = ['BU_: A B', 'BO_ 1 M: 8 A', ' SG_ Z : 0|8@1+ (1,0) [0|255] "" B', ' SG_ Y : 8|8@1- (0.5,-10) [-74|53.5] "" B', ' SG_ X : 16|8@1+ (1,0) [0|0] "" B', ''].join('\n');
  assert.deepEqual(codes(exact), [], 'a range that equals the raw range is fine, and [0|0] means none');
  const huge = ['BU_: A B', 'BO_ 1 M: 8 A', ' SG_ Z : 0|8@1+ (1e999,0) [0|1] "" B', ''].join('\n');
  assert.match(find(huge, 'DBC-NUMBER')[0].message, /The factor "1e999" of "Z" cannot be read as an exact number/);
});

test('value descriptions that cannot occur say what to write instead', () => {
  const signed = msg([sig('S', '0|8@1-')], 8, ['VAL_ 1 S 255 "All" 0 "None" ;']);
  const p = find(signed, 'DBC-VALUE-OUTSIDE-RAW');
  assert.equal(p.length, 1);
  assert.match(p[0].message, /The described raw value 255 of "S" cannot occur: its 8 signed bits hold -128 to 127\. If the bit pattern is meant, write -1\./);
  const unsigned = msg([sig('S', '0|8@1+')], 8, ['VAL_ 1 S 300 "Big" ;']);
  const q = find(unsigned, 'DBC-VALUE-OUTSIDE-RAW');
  assert.match(q[0].message, /The described raw value 300 of "S" cannot occur: its 8 unsigned bits hold 0 to 255\.$/);
  assert.deepEqual(codes(msg([sig('S', '0|8@1-')], 8, ['VAL_ 1 S -128 "Min" 127 "Max" ;'])), []);
  assert.deepEqual(codes(msg([sig('S', '0|64@1+')], 8, ['VAL_ 1 S 18446744073709551615 "Max" ;'])), []);
  assert.deepEqual(codes(msg([sig('S', '0|64@1+')], 8, ['VAL_ 1 S 18446744073709551616 "Over" ;'])), ['DBC-VALUE-OUTSIDE-RAW']);
});

test('identifiers: the extended flag, the 29-bit limit and the 32-bit limit', () => {
  const idCodes = function (id) { return codes(msg([sig('S', '0|8@1+')], 8, [], id)); };
  assert.deepEqual(idCodes(0), []);
  assert.deepEqual(idCodes(2047), []);
  assert.deepEqual(idCodes(2048), ['DBC-MESSAGE-EXTENDED-FLAG']);
  assert.deepEqual(idCodes(536870911), ['DBC-MESSAGE-EXTENDED-FLAG']);
  assert.deepEqual(idCodes(2147483648), []);
  assert.deepEqual(idCodes(2684354559), []);
  assert.deepEqual(idCodes(2684354560), ['DBC-MESSAGE-ID-RANGE']);
  assert.deepEqual(idCodes(4294967295), ['DBC-MESSAGE-ID-RANGE']);
  assert.deepEqual(idCodes(4294967296), ['DBC-MESSAGE-ID-RANGE']);
  assert.deepEqual(idCodes('99999999999999999999'), ['DBC-MESSAGE-ID-RANGE']);
  const flag = find(msg([sig('S', '0|8@1+')], 8, [], 2048), 'DBC-MESSAGE-EXTENDED-FLAG')[0];
  assert.match(flag.message, /The ID 2048 \(0x800\) does not fit into the 11 bits of a standard identifier, but bit 31 .* is not set\. For an extended frame write 2147485696 \(2147483648 \+ 2048\)\./);
  const range = find(msg([sig('S', '0|8@1+')], 8, [], 2684354560), 'DBC-MESSAGE-ID-RANGE')[0];
  assert.match(range.message, /has the extended-frame flag \(bit 31\) set, but the remaining value 0x20000000 does not fit into the 29 bits/);
  const format = ['BU_: A B', 'BO_ 5 M: 8 A', sig('S', '0|8@1+'), 'BA_DEF_ BO_ "VFrameFormat" ENUM "StandardCAN","ExtendedCAN";', 'BA_DEF_DEF_ "VFrameFormat" "StandardCAN";', 'BA_ "VFrameFormat" BO_ 5 1;', ''].join('\n');
  assert.match(find(format, 'DBC-MESSAGE-FRAME-FORMAT')[0].message, /The attribute VFrameFormat says ExtendedCAN, but the ID 5 is written as a standard frame \(bit 31 not set\)\. Make the two agree\./);
});

test('data lengths', () => {
  const dlc = function (n) { return codes(msg([sig('S', '0|8@1+')], n)); };
  for (const n of [1, 2, 8, 12, 16, 20, 24, 32, 48, 64]) assert.deepEqual(dlc(n), [], String(n));
  for (const n of [9, 10, 11, 13, 15, 17, 63]) assert.deepEqual(dlc(n), ['DBC-MESSAGE-DLC-FD'], String(n));
  assert.deepEqual(dlc(65), ['DBC-MESSAGE-DLC']);
  assert.deepEqual(dlc(1000), ['DBC-MESSAGE-DLC']);
  assert.deepEqual(codes(msg([], 8)), ['DBC-MESSAGE-NO-SIGNALS']);
  assert.match(find(msg([sig('S', '0|8@1+')], 9), 'DBC-MESSAGE-DLC-FD')[0].message, /classic CAN carries 0 to 8 bytes, CAN FD also 12, 16, 20, 24, 32, 48 or 64/);
});

test('names: duplicates, invalid, too long, differing only in case', () => {
  assert.match(find(msg([sig('A', '0|8@1+'), sig('A', '8|8@1+')]), 'DBC-SIGNAL-NAME-DUPLICATE')[0].message, /The message "M" already has a signal named "A"/);
  const two = ['BU_: A B', 'BO_ 1 M: 8 A', sig('S', '0|8@1+'), 'BO_ 2 M: 8 A', sig('T', '0|8@1+'), ''].join('\n');
  assert.match(find(two, 'DBC-MESSAGE-NAME-DUPLICATE')[0].message, /The message name "M" is already used by the message with the ID 0x1\./);
  const same = ['BU_: A B', 'BO_ 1 M: 8 A', sig('S', '0|8@1+'), 'BO_ 1 N: 8 A', sig('T', '0|8@1+'), ''].join('\n');
  assert.match(find(same, 'DBC-MESSAGE-ID-DUPLICATE')[0].message, /The ID 0x1 is already used by the message "M"; every message needs its own ID\./);
  assert.match(find('BU_: A B A\n', 'DBC-NODE-DUPLICATE')[0].message, /The node "A" is listed twice in BU_\./);
  const bad = find(['BU_: A', 'BO_ 1 9x: 8 A', sig('S-1', '0|8@1+', '', 'A'), ''].join('\n'), 'DBC-NAME-INVALID');
  assert.equal(bad.length, 2);
  assert.match(bad[0].message, /The message name "9x" is not a valid DBC name/);
  assert.match(bad[1].message, /The signal name "S-1" is not a valid DBC name/);
  // A name that is a DBC keyword is not allowed either.
  assert.deepEqual(codes(['BU_: A', 'BO_ 1 SG_: 8 A', sig('S', '0|8@1+', '', 'A'), ''].join('\n')), ['DBC-NAME-INVALID']);
  const long = find(['BU_: A', 'BO_ 1 ' + 'x'.repeat(33) + ': 8 A', sig('S', '0|8@1+', '', 'A'), ''].join('\n'), 'DBC-NAME-LONG');
  assert.match(long[0].message, /has 33 characters; several CAN tools accept at most 32\./);
  const caseMsg = find(['BU_: Gate gate', 'BO_ 1 M: 8 Gate', sig('S', '0|8@1+', '', 'Gate'), ''].join('\n'), 'DBC-NAME-CASE');
  assert.match(caseMsg[0].message, /The node names "Gate" and "gate" differ only in upper and lower case/);
});

test('nodes: unknown senders and receivers, signals nobody receives', () => {
  const text = ['BU_: A B', 'BO_ 1 M: 8 Zed', sig('S', '0|8@1+', '', 'B,Ghost'), sig('T', '8|8@1+', '', 'Vector__XXX'), sig('U', '16|8@1+', '', 'B'), ''].join('\n');
  assert.match(find(text, 'DBC-SENDER-UNKNOWN')[0].message, /The sending node "Zed" is not listed in BU_\./);
  assert.match(find(text, 'DBC-RECEIVER-UNKNOWN')[0].message, /The receiving node "Ghost" of "S" is not listed in BU_\./);
  const none = find(text, 'DBC-SIGNAL-NO-RECEIVER');
  assert.equal(none.length, 1);
  assert.match(none[0].message, /"T" has no receiving node \(Vector__XXX\)\./);
  const t = run(text).problems.find(function (x) { return x.code === 'DBC-RECEIVER-UNKNOWN'; });
  assert.equal(text.slice(t.start, t.end), 'Ghost');
  assert.deepEqual(codes(['BU_: A', 'BO_ 1 M: 8 Vector__XXX', sig('S', '0|8@1+', '', 'A'), ''].join('\n')), []);
});

test('value tables: duplicates, unused, missing', () => {
  const tables = ['BU_: A B', 'VAL_TABLE_ T 0 "a" ;', 'VAL_TABLE_ T 1 "b" ;', 'VAL_TABLE_ Used 0 "x" 1 "y" ;', 'BO_ 1 M: 8 A', sig('S', '0|8@1+'), 'VAL_ 1 S 1 "y" 0 "x" ;', ''].join('\n');
  assert.deepEqual(codes(tables), ['DBC-VALUE-TABLE-DUPLICATE', 'DBC-VALUE-TABLE-UNUSED']);
  assert.match(find(tables, 'DBC-VALUE-TABLE-UNUSED')[0].message, /No signal uses the value table "T"/);
  assert.match(find(tables, 'DBC-VALUE-TABLE-DUPLICATE')[0].message, /The value table "T" is defined twice; only the first definition is used\./);
  const miss = ['BU_: A B', 'BO_ 1 M: 8 A', sig('S', '0|8@1+'), 'SGTYPE_ t1 : 8@1+ (1,0) [0|255] "" 0,Nope;', ''].join('\n');
  assert.match(find(miss, 'DBC-VALUE-TABLE-MISSING')[0].message, /The signal type "t1" refers to the value table "Nope", which is not defined \(VAL_TABLE_\)\./);
  const referenced = ['BU_: A B', 'VAL_TABLE_ Tab 0 "a" ;', 'BO_ 1 M: 8 A', sig('S', '0|8@1+'), 'SGTYPE_ t1 : 8@1+ (1,0) [0|255] "" 0,Tab;', ''].join('\n');
  assert.deepEqual(codes(referenced), [], 'a table that a signal type refers to is used');
});

test('multiplexing problems carry the signal name', () => {
  const sel = sig('Sel', '0|4@1+', 'M');
  assert.match(find(msg([sig('V', '8|8@1+', 'm2')]), 'DBC-MUX-NO-MULTIPLEXOR')[0].message, /^"V" is multiplexed \(m2\), but the message has no multiplexor signal \(M\); the signal is not decoded\./);
  assert.match(find(msg([sel, sig('Sel2', '4|4@1+', 'M'), sig('D', '8|8@1+', 'm0')]), 'DBC-MUX-AMBIGUOUS')[0].message, /several multiplexors \(Sel, Sel2\) and no SG_MUL_VAL_ statement says which one selects "D"/);
  assert.match(find(msg([sel, sig('W', '8|8@1+', 'm99')]), 'DBC-MUX-VALUE-RANGE')[0].message, /The multiplexor "Sel" \(4 bits, unsigned\) can never hold 99, so "W" is never present\./);
  assert.match(find(msg([sel]), 'DBC-MUX-UNUSED')[0].message, /"Sel" is written as a multiplexor, but no signal of this message is selected by it\./);
  const ext = msg([sel, sig('Q', '8|8@1+', 'm3')], 8, ['SG_MUL_VAL_ 1 Q Sel 5-4;']);
  assert.match(find(ext, 'DBC-MUX-EXTENDED-RANGE')[0].message, /The range 5-4 of multiplexor values for "Q" ends below its start/);
  const mismatch = msg([sel, sig('R', '8|8@1+', 'm3')], 8, ['SG_MUL_VAL_ 1 R Sel 5-6;']);
  assert.match(find(mismatch, 'DBC-MUX-EXTENDED-MISMATCH')[0].message, /"R" is written m3, but its SG_MUL_VAL_ ranges \(5-6\) do not contain 3; decoding follows SG_MUL_VAL_\./);
  const fl = msg([sig('F', '0|32@1+', 'M'), sig('G', '32|8@1+', 'm0')], 8, ['SIG_VALTYPE_ 1 F : 1;']);
  assert.match(find(fl, 'DBC-MUX-SWITCH-FLOAT')[0].message, /The multiplexor "F" is a floating-point signal/);
});

test('a multiplexor of a multiplexor selects by both values (extended multiplexing)', () => {
  const text = msg([sig('Sel', '0|4@1+', 'M'), sig('Sub', '4|4@1+', 'm1M'), sig('Y', '8|8@1+', 'm1'), sig('Z', '8|8@1+', 'm5')], 8, ['SG_MUL_VAL_ 1 Y Sub 0-3;', 'SG_MUL_VAL_ 1 Z Sub 4-7;']);
  assert.deepEqual(codes(text), []);
  // Y and Z are exclusive through Sub; a third signal on the same bits and Sub range overlaps.
  const clash = msg([sig('Sel', '0|4@1+', 'M'), sig('Sub', '4|4@1+', 'm1M'), sig('Y', '8|8@1+', 'm1'), sig('Z', '8|8@1+', 'm3')], 8, ['SG_MUL_VAL_ 1 Y Sub 0-3;', 'SG_MUL_VAL_ 1 Z Sub 3-7;']);
  assert.deepEqual(codes(clash), ['DBC-SIGNAL-OVERLAP']);
});

test('references to things that do not exist', () => {
  const text = msg([sig('S', '0|8@1+')], 8, ['VAL_ 9 S 1 "x" ;', 'VAL_ 1 Nope 1 "x" ;', 'CM_ BO_ 9 "c";', 'CM_ SG_ 1 Nope "c";', 'CM_ BU_ Ghost "c";', 'SIG_VALTYPE_ 1 Nope : 1;', 'SIG_VALTYPE_ 1 S : 9;',
    'BO_TX_BU_ 9 : A;', 'SG_MUL_VAL_ 9 S Sel 0-0;', 'SG_MUL_VAL_ 1 Nope Sel 0-0;']);
  const c = codes(text);
  assert.deepEqual(c, ['DBC-COMMENT-UNKNOWN', 'DBC-COMMENT-UNKNOWN', 'DBC-COMMENT-UNKNOWN', 'DBC-MUX-EXTENDED-UNKNOWN', 'DBC-MUX-EXTENDED-UNKNOWN', 'DBC-TRANSMITTER-UNKNOWN-MESSAGE',
    'DBC-VAL-UNKNOWN-MESSAGE', 'DBC-VAL-UNKNOWN-SIGNAL', 'DBC-VALTYPE-INVALID', 'DBC-VALTYPE-UNKNOWN']);
  assert.match(find(text, 'DBC-VAL-UNKNOWN-MESSAGE')[0].message, /VAL_ refers to the message ID 9, but no message has that ID/);
  assert.match(find(text, 'DBC-VAL-UNKNOWN-SIGNAL')[0].message, /VAL_ refers to the signal "Nope", but the message 1 has no signal of that name/);
  assert.match(find(text, 'DBC-VALTYPE-INVALID')[0].message, /The value type 9 is not known: use 0 \(integer\), 1 \(32-bit float\) or 2 \(64-bit float\)\./);
});

test('attributes: the value is checked against its definition', () => {
  const base = ['BU_: A B', 'BO_ 1 M: 8 A', sig('S', '0|8@1+'), 'BA_DEF_ BO_ "Prio" INT 0 7;', 'BA_DEF_ "Mode" ENUM "A","B";', 'BA_DEF_ "Label" STRING ;', 'BA_DEF_ "Ratio" FLOAT 0 1;', 'BA_DEF_ BO_ "Free" INT 0 0;'];
  const attr = function (line) { return codes(base.concat([line, '']).join('\n')); };
  assert.deepEqual(attr('BA_ "Prio" BO_ 1 7;'), []);
  assert.deepEqual(attr('BA_ "Prio" BO_ 1 8;'), ['DBC-ATTRIBUTE-VALUE']);
  assert.deepEqual(attr('BA_ "Prio" BO_ 1 -1;'), ['DBC-ATTRIBUTE-VALUE']);
  assert.deepEqual(attr('BA_ "Prio" BO_ 1 2.5;'), ['DBC-ATTRIBUTE-VALUE']);
  assert.deepEqual(attr('BA_ "Prio" BO_ 1 "x";'), ['DBC-ATTRIBUTE-VALUE']);
  assert.deepEqual(attr('BA_ "Free" BO_ 1 12345;'), [], 'a range of 0 to 0 means any value');
  assert.deepEqual(attr('BA_ "Mode" 1;'), []);
  assert.deepEqual(attr('BA_ "Mode" 2;'), ['DBC-ATTRIBUTE-VALUE']);
  assert.deepEqual(attr('BA_ "Mode" "B";'), []);
  assert.deepEqual(attr('BA_ "Mode" "C";'), ['DBC-ATTRIBUTE-VALUE']);
  assert.deepEqual(attr('BA_ "Label" "x";'), []);
  assert.deepEqual(attr('BA_ "Label" 5;'), ['DBC-ATTRIBUTE-VALUE']);
  assert.deepEqual(attr('BA_ "Ratio" 0.5;'), []);
  assert.deepEqual(attr('BA_ "Ratio" 1.5;'), ['DBC-ATTRIBUTE-VALUE']);
  assert.deepEqual(attr('BA_ "Nothing" 1;'), ['DBC-ATTRIBUTE-UNDEFINED']);
  assert.deepEqual(attr('BA_ "Prio" SG_ 1 S 1;'), ['DBC-ATTRIBUTE-OBJECT-TYPE']);
  assert.deepEqual(attr('BA_ "Prio" BO_ 2 1;'), ['DBC-ATTRIBUTE-UNKNOWN-OBJECT']);
  const p = find(base.concat(['BA_ "Prio" BO_ 1 8;', '']).join('\n'), 'DBC-ATTRIBUTE-VALUE')[0];
  assert.match(p.message, /The value 8 of the attribute "Prio" is not allowed: its definition \(INT\) expects a number from 0 to 7\./);
});

test('the message about a character that was not decoded points at it', () => {
  const text = ['BU_: A', 'BO_ 1 M: 8 A', sig('S', '0|8@1+', '', 'A'), 'CM_ "caf�";', ''].join('\n');
  const p = find(text, 'DBC-ENCODING')[0];
  assert.equal(text.slice(p.start, p.end), '�');
  assert.match(p.message, /Reopen with Encoding, Western/);
  assert.deepEqual(codes(text, { text: undefined }), [], 'without the text the check is skipped');
});

test('every problem has the severity of its code, and the counts add up', () => {
  const text = ['BU_: A A', 'BO_ 2048 M: 9 Zed', sig('S', '0|8@1+', '', 'Ghost'), sig('S', '4|8@1+', '', 'A'), ''].join('\n');
  const r = run(text);
  assert.ok(r.problems.length >= 6);
  const counted = { error: 0, warning: 0, info: 0 };
  for (const p of r.problems) { assert.equal(p.severity, V.CODES[p.code]); counted[p.severity]++; }
  assert.deepEqual(r.counts, counted);
  assert.equal(r.dropped, 0);
  // A few severities, written down from the design of the codes.
  assert.deepEqual([V.CODES['DBC-SIGNAL-OVERLAP'], V.CODES['DBC-NAME-LONG'], V.CODES['DBC-SIGNAL-NO-RECEIVER'], V.CODES['DBC-ENCODING'], V.CODES['DBC-FACTOR-ZERO'],
    V.CODES['DBC-RANGE-OUTSIDE-RAW'], V.CODES['DBC-MUX-UNUSED'], V.CODES['DBC-MUX-AMBIGUOUS'], V.CODES['DBC-VALUE-TABLE-UNUSED'], V.CODES['DBC-MESSAGE-DLC'], V.CODES['DBC-MESSAGE-DLC-FD']],
  ['error', 'info', 'info', 'warning', 'error', 'warning', 'info', 'error', 'info', 'error', 'warning']);
});

test('the list of problems is cut at maxProblems and says how many were left out', () => {
  const text = 'BU_: ' + new Array(52).join('A ') + '\n';
  const full = run(text, { maxProblems: 1000 });
  assert.equal(full.problems.length, 50);
  assert.equal(full.dropped, 0);
  const r = run(text, { maxProblems: 10 });
  assert.equal(r.problems.length, 11);
  assert.equal(r.dropped, 40);
  assert.equal(r.counts.warning, 50);
  const last = r.problems[10];
  assert.equal(last.code, 'DBC-LIST-CUT');
  assert.equal(last.severity, 'info');
  assert.match(last.message, /Only the first 10 problems are listed; 40 more were found \(setting canAtlas\.maxProblems\)\./);
  assert.equal(run(text, { maxProblems: -5 }).problems.length, 2, 'a limit below 1 is read as 1');
  assert.equal(run(text, { maxProblems: 0 }).problems.length, 50, 'no limit given (0) means the default');
  assert.equal(run(text, { maxProblems: undefined }).problems.length, 50, 'the default limit is 1000');
});

test('codes can be switched off', () => {
  const text = 'BU_: A A\n';
  assert.deepEqual(codes(text), ['DBC-NODE-DUPLICATE']);
  const r = run(text, { disabledCodes: ['DBC-NODE-DUPLICATE'] });
  assert.deepEqual(r.problems, []);
  assert.equal(r.counts.warning, 0, 'a disabled code is not counted either');
  assert.deepEqual(codes(text, { disabledCodes: ['DBC-OTHER'] }), ['DBC-NODE-DUPLICATE']);
});

test('multiplexors nested deeper than 32 levels are refused, also when the chain is thousands long (no recursion)', () => {
  function chain(n) {
    const lines = ['BU_: A B', 'BO_ 1 Deep: 64 A', sig('C0', '0|1@1+', 'M')];
    const extra = [];
    for (let k = 1; k <= n; k++) {
      lines.push(sig('C' + k, (k % 512) + '|1@1+', 'm0M'));
      extra.push('SG_MUL_VAL_ 1 C' + k + ' C' + (k - 1) + ' 0-0;');
    }
    lines.push(sig('Leaf', '511|1@1+', 'm0'));
    extra.push('SG_MUL_VAL_ 1 Leaf C' + n + ' 0-0;');
    return lines.concat(extra, ['']).join('\n');
  }
  const t40 = chain(40);
  const deep = find(t40, 'DBC-MUX-TOO-DEEP');
  assert.equal(deep.length, 9, 'C33 to C40 and the leaf');
  assert.match(deep[0].message, /The multiplexors of "C33" are nested more than 32 levels deep; the signal is not decoded\./);
  assert.equal(find(chain(32), 'DBC-MUX-TOO-DEEP').length, 1, 'only the leaf is the 33rd level');
  assert.equal(find(chain(31), 'DBC-MUX-TOO-DEEP').length, 0);
  const t0 = Date.now();
  const big = run(chain(30000), { maxProblems: 100000 });
  assert.ok(Date.now() - t0 < 10000, 'took ' + (Date.now() - t0) + ' ms');
  assert.equal(big.problems.filter(function (p) { return p.code === 'DBC-MUX-TOO-DEEP'; }).length, 30000 - 32 + 1);
});

test('multiplexors that select each other in a ring of thousands do not overflow the stack', () => {
  const n = 20000;
  const lines = ['BU_: A B', 'BO_ 1 Ring: 64 A'];
  const extra = [];
  for (let k = 0; k < n; k++) {
    lines.push(sig('R' + k, (k % 512) + '|1@1+', 'm0M'));
    extra.push('SG_MUL_VAL_ 1 R' + k + ' R' + ((k + 1) % n) + ' 0-0;');
  }
  const t0 = Date.now();
  const r = run(lines.concat(extra, ['']).join('\n'), { maxProblems: 100000 });
  assert.ok(Date.now() - t0 < 10000, 'took ' + (Date.now() - t0) + ' ms');
  assert.equal(r.problems.filter(function (p) { return p.code === 'DBC-MUX-CYCLE'; }).length, n);
});

test('a message with hundreds of signals on the same bits is checked within a budget and says so', () => {
  const lines = ['BU_: A B', 'BO_ 1 Wide: 8 A', sig('Sel', '0|16@1+', 'M')];
  for (let k = 0; k < 900; k++) lines.push(sig('V' + k, '16|8@1+', 'm' + k));
  const t0 = Date.now();
  const r = run(lines.concat(['']).join('\n'));
  const took = Date.now() - t0;
  const c = r.problems.map(function (p) { return p.code; });
  assert.deepEqual(c, ['DBC-CHECK-LIMIT']);
  assert.match(r.problems[0].message, /The overlap check of the message "Wide" stopped early/);
  assert.ok(took < 5000, 'took ' + took + ' ms');
  // Fewer signals: no limit, and no overlap because the multiplexor values differ.
  assert.deepEqual(codes(lines.slice(0, 300).concat(['']).join('\n')), []);
});

test('representable ranges and helpers', () => {
  const d = P.parseDbc('BU_: A\nBO_ 1 M: 8 A\n SG_ S : 0|8@1- (0.5,-10) [0|0] "" A\n SG_ N : 8|8@1+ (-1,0) [0|0] "" A\n SG_ F : 16|32@1+ (1,0) [0|0] "" A\nSIG_VALTYPE_ 1 F : 1;\n');
  const [s, n, f] = d.messages[0].signals;
  const D = require('../src/dbc/decimal');
  const r = V.representable(s, D.parse('0.5'), D.parse('-10'));
  assert.deepEqual([D.toString(r.lo), D.toString(r.hi)], ['-74', '53.5']);
  const rn = V.representable(n, D.parse('-1'), D.parse('0'));
  assert.deepEqual([D.toString(rn.lo), D.toString(rn.hi)], ['-255', '0'], 'a negative factor reverses the ends');
  assert.equal(V.representable(f, D.parse('1'), D.parse('0')), null);
  assert.equal(V.representable(s, D.parse('0'), D.parse('0')), null);
  assert.equal(V.hex(255), '0xFF');
  assert.equal(V.idText({ rawId: 291, frameId: 291, extended: false, idText: '291' }), '0x123');
  assert.equal(V.idText({ rawId: 0x98FEF100, frameId: 0x18FEF100, extended: true, idText: '2566844672' }), '0x18FEF100 (extended)');
  assert.equal(V.idText({ rawId: Infinity, idText: '99999999999999999999' }), '99999999999999999999');
  assert.equal(V.sameEntries([{ value: 1n, text: 'a' }], [{ value: 1n, text: 'a' }]), true);
  assert.equal(V.sameEntries([{ value: 1n, text: 'a' }], [{ value: 1n, text: 'b' }]), false);
  assert.equal(V.sameEntries([{ value: 1n, text: 'a' }], [{ value: 1n, text: 'a' }, { value: 2n, text: 'b' }]), false);
  assert.equal(V.sameEntries(null, []), false);
});

test('every code of the checks is produced by a corpus file or by a test in this file', () => {
  const seen = new Set();
  const dir = path.join(__dirname, 'fixtures', 'corpus');
  for (const f of fs.readdirSync(dir).filter(function (x) { return x.endsWith('.dbc'); })) {
    const text = U.decodeBytes(fs.readFileSync(path.join(dir, f))).text;
    for (const p of V.validate(P.parseDbc(text), { text: text, maxProblems: 100000 }).problems) seen.add(p.code);
  }
  // Produced by tests of this file (the corpus has no file for them on purpose: they need a very
  // long chain, a very large message or a low problem limit).
  for (const code of ['DBC-MUX-TOO-DEEP', 'DBC-CHECK-LIMIT', 'DBC-LIST-CUT']) seen.add(code);
  // DBC-FILE-LIMIT needs a file of tens of megabytes; it is produced and checked in test/dbc.adversarial.test.js.
  const adversarial = fs.readFileSync(path.join(__dirname, 'dbc.adversarial.test.js'), 'utf8');
  assert.ok(adversarial.includes('DBC-FILE-LIMIT'), 'the adversarial tests cover DBC-FILE-LIMIT');
  seen.add('DBC-FILE-LIMIT');
  const missing = Object.keys(V.CODES).filter(function (c) { return !seen.has(c); });
  assert.deepEqual(missing, [], 'codes without a producing file');
  const unknown = Array.from(seen).filter(function (c) { return !V.CODES[c]; });
  assert.deepEqual(unknown, [], 'codes that are not in CODES');
  assert.ok(Object.keys(V.CODES).length >= 60);
});

test('the three codes of the previous test are really produced by the tests above', () => {
  assert.equal(find(msg([sig('Sel', '0|1@1+', 'M')]), 'DBC-MUX-UNUSED').length, 1);
  assert.equal(run('BU_: A A A\n', { maxProblems: 1 }).problems.some(function (p) { return p.code === 'DBC-LIST-CUT'; }), true);
});

test('IDs of more than 15 digits are different IDs, not duplicates of each other', () => {
  const text = msg([sig('S', '0|8@1+')], 8, [], '12345678901234567') + msg([sig('S', '0|8@1+')], 8, [], '12345678901234568').replace('BU_: A B\n', '');
  const list = codes(text);
  assert.equal(list.filter(function (c) { return c === 'DBC-MESSAGE-ID-RANGE'; }).length, 2);
  assert.equal(list.indexOf('DBC-MESSAGE-ID-DUPLICATE'), -1);
  const same = msg([sig('S', '0|8@1+')], 8, [], '12345678901234567') + msg([sig('T', '0|8@1+')], 8, [], '12345678901234567').replace('BU_: A B\n', '').replace('M:', 'N:');
  assert.equal(codes(same).indexOf('DBC-MESSAGE-ID-DUPLICATE') !== -1, true, 'the same long ID twice is still a duplicate');
});

test('the extended-flag advice is given only when the extended ID would fit into 29 bits', () => {
  const small = find(msg([sig('S', '0|8@1+')], 8, [], '65280'), 'DBC-MESSAGE-EXTENDED-FLAG')[0];
  assert.match(small.message, /For an extended frame write 2147548928 \(2147483648 \+ 65280\)\.$/);
  const large = find(msg([sig('S', '0|8@1+')], 8, [], '536870912'), 'DBC-MESSAGE-EXTENDED-FLAG')[0];
  assert.doesNotMatch(large.message, /For an extended frame write/);
  assert.match(large.message, /does not fit into the 29 bits of an extended identifier either\.$/);
});

test('a number the reader refuses names both reasons; the list-cut note uses correct grammar', () => {
  const text = msg([' SG_ S : 0|8@1+ (1e999,0) [0|0] "" B']);
  const p = find(text, 'DBC-NUMBER')[0];
  assert.match(p.message, /its exponent is too large or the text is too long\)\.$/);
  const one = run('BU_: A A A\n', { maxProblems: 1 }).problems.filter(function (x) { return x.code === 'DBC-LIST-CUT'; })[0];
  assert.match(one.message, /^Only the first 1 problem is listed; \d+ more (was|were) found/);
  const two = run('BU_: A A A A\n', { maxProblems: 2 }).problems.filter(function (x) { return x.code === 'DBC-LIST-CUT'; })[0];
  assert.match(two.message, /^Only the first 2 problems are listed; \d+ more (was|were) found/);
});
