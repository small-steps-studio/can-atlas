'use strict';
// Hover texts, the lookup of the element under the pointer, go to definition, the outline, document
// symbols, the message list and the bit layout text, checked against the invented sample database.
// The expected texts were worked out by hand from the lines of the sample (bit positions, scaling,
// raw ranges), not copied from the output.

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/dbc/parse');
const D = require('../src/dbc/describe');
const O = require('../src/dbc/outline');
const L = require('../src/dbc/layout');
const C = require('../src/dbc/codec');
const { sampleFor } = require('../src/samples');
const H = require('./helpers/hostile');

const TEXT = sampleFor('valid').text;
const DB = P.parseDbc(TEXT);

function msg(name) { return DB.messageByName.get(name); }
function sig(m, name) { return msg(m).signalIndex.get(name); }
/** The offset of the second character of the nth match of `needle`. */
function at(needle, nth, delta) {
  let from = 0;
  let i = -1;
  for (let k = 0; k <= (nth || 0); k++) {
    i = TEXT.indexOf(needle, from);
    assert.notEqual(i, -1, 'no match ' + k + ' for ' + needle);
    from = i + 1;
  }
  return i + (delta === undefined ? 1 : delta);
}

// ---- hover texts -------------------------------------------------------------------------------------

test('hover on a little-endian signal: bits, formula, raw range, physical range, receivers, comment', () => {
  // EngineSpeed: SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|8000] "rpm". Bits 0 to 15, bytes 0 and 1.
  // The largest raw value is 65535, and 65535 * 0.25 = 16383.75.
  const md = D.hoverOf(DB, { kind: 'signal', message: msg('EngineStatus'), signal: sig('EngineStatus', 'EngineSpeed') });
  assert.equal(md, [
    '**Signal** `EngineSpeed`',
    '',
    '| | |',
    '| --- | --- |',
    '| Message | EngineStatus, ID 0x100 |',
    '| Bits | 16 bits, little\\-endian \\(Intel\\): start bit 0 is the least significant bit; bits 0 to 15, bytes 0 to 1 |',
    '| Value | unsigned integer |',
    '| Scaling | physical = raw × 0.25 \\+ 0 |',
    '| Raw range | raw 0 to 65535 gives 0 to 16383.75 rpm |',
    '| Range | 0 to 8000 rpm |',
    '| Unit | rpm |',
    '| Receivers | Dashboard, Gateway |',
    '| Comment | Crankshaft speed. |'
  ].join('\n'));
});

test('hover on a big-endian signal: the start bit is the most significant bit', () => {
  // VehicleSpeed: 15|16@0+ (0.01,0). Bit 15 is bit 7 of byte 1; the signal runs down through byte 1 and
  // then continues with bit 7 of byte 2 down to bit 0 of byte 2, which is bit 16. 65535 * 0.01 = 655.35.
  const md = D.hoverOf(DB, { kind: 'signal', message: msg('GearStatus'), signal: sig('GearStatus', 'VehicleSpeed') });
  assert.match(md, /\| Bits \| 16 bits, big\\-endian \\\(Motorola\\\): start bit 15 is the most significant bit; it runs down to bit 16, bytes 1 to 2 \|/);
  assert.match(md, /\| Raw range \| raw 0 to 65535 gives 0 to 655\.35 km\/h \|/);
  assert.match(md, /\| Scaling \| physical = raw × 0\.01 \\\+ 0 \|/);
  assert.match(md, /\| Receivers \| Dashboard, BrakeUnit, Gateway \|/);
});

test('hover on a signal that sits in the upper half of a byte, with value descriptions', () => {
  // GearSelected: 7|4@0+, bits 7 to 4 of byte 0.
  const md = D.hoverOf(DB, { kind: 'signal', message: msg('GearStatus'), signal: sig('GearStatus', 'GearSelected') });
  assert.match(md, /\| Bits \| 4 bits, big\\-endian \\\(Motorola\\\): start bit 7 is the most significant bit; it runs down to bit 4, byte 0 \|/);
  assert.match(md, /\| Raw range \| raw 0 to 15 gives 0 to 15 \|/);
  assert.match(md, /\| Unit \| \\\(none\\\) \|/);
  assert.match(md, /\| Value descriptions \| 7 Invalid; 3 Drive; 2 Neutral; 1 Reverse; 0 Park \|/);
});

test('hover on a signed signal and on a multiplexed signal', () => {
  const torque = D.hoverOf(DB, { kind: 'signal', message: msg('EngineStatus'), signal: sig('EngineStatus', 'EngineTorque') });
  // 12 signed bits hold -2048 to 2047; times 0.5 that is -1024 to 1023.5.
  assert.match(torque, /\| Value \| signed integer \\\(two's complement\\\) \|/);
  assert.match(torque, /\| Raw range \| raw \\-2048 to 2047 gives \\-1024 to 1023\.5 Nm \|/);
  const temp = D.hoverOf(DB, { kind: 'signal', message: msg('EngineStatus'), signal: sig('EngineStatus', 'CoolantTemp') });
  assert.match(temp, /\| Scaling \| physical = raw × 1 − 40 \|/);
  assert.match(temp, /\| Raw range \| raw 0 to 255 gives \\-40 to 215 degC \|/);
  const avg = D.hoverOf(DB, { kind: 'signal', message: msg('TripComputer'), signal: sig('TripComputer', 'AverageSpeed') });
  assert.match(avg, /\| Multiplexing \| present when PageIndex = 1 \|/);
  const page = D.hoverOf(DB, { kind: 'signal', message: msg('TripComputer'), signal: sig('TripComputer', 'PageIndex') });
  assert.match(page, /\| Multiplexing \| multiplexor \|/);
});

test('hover on a 32-bit float signal and on a 64-bit signal', () => {
  const pressure = D.hoverOf(DB, { kind: 'signal', message: msg('AmbientSensor'), signal: sig('AmbientSensor', 'AmbientPressure') });
  assert.match(pressure, /\| Value \| 32\\-bit IEEE float \|/);
  assert.match(pressure, /\| Scaling \| physical = value × 1 \\\+ 0 \|/);
  assert.equal(/Raw range/.test(pressure), false, 'a float has no raw range');
  const odometer = D.hoverOf(DB, { kind: 'signal', message: msg('Odometer'), signal: sig('Odometer', 'OdometerTotal') });
  assert.match(odometer, /\| Raw range \| raw 0 to 18446744073709551615 gives 0 to 18446744073709551\.615 km \|/);
});

test('hover on a message: ID in hex and decimal, standard or extended, sender, cycle time, comment', () => {
  const charger = D.hoverOf(DB, { kind: 'message', message: msg('ChargerStatus') });
  // 2566869221 = 2147483648 + 419385573 and 419385573 = 0x18FF50E5.
  assert.equal(charger, [
    '**Message** `ChargerStatus`',
    '',
    '| | |',
    '| --- | --- |',
    '| ID | 0x18FF50E5 \\(419385573\\), extended 29\\-bit; written as 2566869221 in the file |',
    '| Data length | 8 bytes |',
    '| Sender | ChargerUnit |',
    '| Cycle time | 100 ms |',
    '| Signals | 4 |'
  ].join('\n'));
  const trip = D.hoverOf(DB, { kind: 'message', message: msg('TripComputer') });
  assert.match(trip, /\| ID \| 0x200 \\\(512\\\), standard 11\\-bit \|/);
  assert.match(trip, /\| Also sent by \| Dashboard, Gateway \|/);
  assert.match(trip, /\| Signals \| 7 \\\(multiplexed: PageIndex\\\) \|/);
  assert.match(trip, /\| Comment \| Three pages of trip data; PageIndex says which one the frame carries\. \|/);
});

test('hover on a node and on a value table', () => {
  // Gateway sends 768, 2032 and (BO_TX_BU_) 512; it receives 19 signals (counted by hand).
  const node = D.hoverOf(DB, { kind: 'node', name: 'Gateway' });
  assert.equal(node, [
    '**Node** `Gateway`',
    '',
    '| | |',
    '| --- | --- |',
    '| Sends | 3 messages |',
    '| Receives | 19 signals |',
    '| Comment | Connects the powertrain bus with the body bus. |'
  ].join('\n'));
  assert.match(D.hoverOf(DB, { kind: 'node', name: 'Nobody' }), /\| Listed in BU\\_ \| no \|/);
  const table = D.hoverOf(DB, { kind: 'valueTable', table: DB.valueTables[0] });
  assert.equal(table, ['**Value table** `GearPosition`', '', '| Raw | Description |', '| ---: | --- |', '| 7 | Invalid |', '| 3 | Drive |', '| 2 | Neutral |', '| 1 | Reverse |', '| 0 | Park |'].join('\n'));
  assert.equal(D.hoverOf(DB, null), '');
  assert.equal(D.hoverOf(DB, { kind: 'other' }), '');
});

test('a long list of value descriptions is shortened in the signal hover and in the table hover', () => {
  const entries = [];
  for (let k = 0; k < 60; k++) entries.push(k + ' "v' + k + '"');
  const text = 'BU_: N\nVAL_TABLE_ T ' + entries.join(' ') + ' ;\nBO_ 1 A: 8 N\n SG_ s : 0|8@1+ (1,0) [0|255] "" N\nVAL_ 1 s ' + entries.join(' ') + ' ;\n';
  const db = P.parseDbc(text);
  const hover = D.hoverOf(db, { kind: 'signal', message: db.messages[0], signal: db.messages[0].signals[0] });
  assert.match(hover, /11 v11; and 48 more \|/);
  const table = D.hoverOf(db, { kind: 'valueTable', table: db.valueTables[0] });
  assert.match(table, /\| 39 \| v39 \|/);
  assert.equal(/\| 40 \|/.test(table), false);
  assert.match(table, /and 20 more/);
});

// ---- what lies under the pointer ---------------------------------------------------------------------

test('definitions: names in BO_, SG_, BU_ and VAL_TABLE_ lines are found as definitions', () => {
  let el = D.elementAt(DB, at('EngineSpeed : 0|16'));
  assert.equal(el.kind, 'signal');
  assert.equal(el.signal, sig('EngineStatus', 'EngineSpeed'));
  assert.equal(el.definition, true);
  assert.equal(TEXT.slice(el.start, el.end), 'EngineSpeed');
  el = D.elementAt(DB, at('EngineStatus: 8'));
  assert.equal(el.kind, 'message');
  assert.equal(el.definition, true);
  assert.equal(TEXT.slice(el.start, el.end), 'EngineStatus');
  el = D.elementAt(DB, at('GearPosition 7'));
  assert.equal(el.kind, 'valueTable');
  assert.equal(el.definition, true);
  assert.equal(TEXT.slice(el.start, el.end), 'GearPosition');
  el = D.elementAt(DB, at('BU_: EngineUnit', 0, 6));
  assert.equal(el.kind, 'node');
  assert.equal(el.name, 'EngineUnit');
  assert.equal(el.definition, true);
});

test('references: the sender, the receivers, comments, value descriptions, attributes and transmitters lead to the definitions', () => {
  // the sender of a message
  let el = D.elementAt(DB, at('8 EngineUnit', 0, 3));
  assert.equal(el.kind, 'node');
  assert.equal(el.name, 'EngineUnit');
  // a receiver of a signal
  el = D.elementAt(DB, at('"rpm" Dashboard,Gateway', 0, 7));
  assert.equal(el.kind, 'node');
  assert.equal(el.name, 'Dashboard');
  // CM_ SG_ <id> <signal>
  el = D.elementAt(DB, at('CM_ SG_ 256 EngineSpeed', 0, 16));
  assert.equal(el.kind, 'signal');
  assert.equal(el.signal, sig('EngineStatus', 'EngineSpeed'));
  assert.deepEqual(D.definitionOf(DB, el), { start: sig('EngineStatus', 'EngineSpeed').nameStart, end: sig('EngineStatus', 'EngineSpeed').nameEnd });
  // CM_ BO_ <id>
  el = D.elementAt(DB, at('CM_ BO_ 256', 0, 9));
  assert.equal(el.kind, 'message');
  assert.equal(el.message, msg('EngineStatus'));
  assert.deepEqual(D.definitionOf(DB, el), { start: msg('EngineStatus').nameStart, end: msg('EngineStatus').nameEnd });
  // CM_ BU_ <node>
  el = D.elementAt(DB, at('CM_ BU_ Gateway', 0, 8));
  assert.equal(el.kind, 'node');
  assert.equal(el.name, 'Gateway');
  const node = DB.nodeByName.get('Gateway');
  assert.deepEqual(D.definitionOf(DB, el), { start: node.start, end: node.end });
  // VAL_ <id> <signal>
  el = D.elementAt(DB, at('VAL_ 288 GearSelected', 0, 6));
  assert.equal(el.kind, 'message');
  assert.equal(el.message, msg('GearStatus'));
  el = D.elementAt(DB, at('VAL_ 288 GearSelected', 0, 12));
  assert.equal(el.kind, 'signal');
  assert.equal(el.signal, sig('GearStatus', 'GearSelected'));
  // BA_ ... BO_ <id>
  el = D.elementAt(DB, at('BA_ "GenMsgCycleTime" BO_ 512 100', 0, 29));
  assert.equal(el.kind, 'message');
  assert.equal(el.message, msg('TripComputer'));
  // BO_TX_BU_ <id> : <nodes>
  el = D.elementAt(DB, at('BO_TX_BU_ 512 : Dashboard,Gateway', 0, 28));
  assert.equal(el.kind, 'node');
  assert.equal(el.name, 'Gateway');
  el = D.elementAt(DB, at('BO_TX_BU_ 512', 0, 11));
  assert.equal(el.kind, 'message');
  // SIG_VALTYPE_ <id> <signal> : 1
  el = D.elementAt(DB, at('SIG_VALTYPE_ 768 AmbientPressure', 0, 20));
  assert.equal(el.kind, 'signal');
  assert.equal(el.signal, sig('AmbientSensor', 'AmbientPressure'));
});

test('white space, numbers and strings do not select anything', () => {
  assert.equal(D.elementAt(DB, 0), null);
  assert.equal(D.elementAt(DB, TEXT.length), null);
  assert.equal(D.elementAt(DB, at('"Crankshaft speed."', 0, 5)), null);
  // anywhere else on a signal line the signal is meant, but not as its definition
  const onNumber = D.elementAt(DB, at('(0.25,0)', 0, 3));
  assert.equal(onNumber.kind, 'signal');
  assert.equal(onNumber.definition, false);
  assert.equal(D.elementAt(DB, 1000000), null);
  assert.equal(D.elementAt(DB, -5), null);
  assert.equal(D.definitionOf(DB, null), null);
  assert.equal(D.definitionOf(DB, { kind: 'node', name: 'Nobody' }), null);
});

test('references to things that do not exist select nothing', () => {
  const text = 'BU_: N\nBO_ 1 A: 8 N\n SG_ s : 0|8@1+ (1,0) [0|1] "" N\nCM_ SG_ 99 nope "x";\nVAL_ 1 missing 0 "a";\nCM_ BO_ 77 "y";\n';
  const db = P.parseDbc(text);
  assert.equal(D.elementAt(db, text.indexOf('nope') + 1), null);
  assert.equal(D.elementAt(db, text.indexOf('missing') + 1), null);
  assert.equal(D.elementAt(db, text.indexOf('77') + 1), null);
  assert.equal(D.elementAt(db, text.indexOf('VAL_ 1') + 5).kind, 'message');
});

test('messageAt finds the message whose block holds the offset; the pseudo message is skipped', () => {
  assert.equal(D.messageAt(DB, at('SG_ CoolantTemp')), msg('EngineStatus'));
  assert.equal(D.messageAt(DB, at('BO_ 288')), msg('GearStatus'));
  assert.equal(D.messageAt(DB, 5), null);
  const t = 'BO_ 3221225472 VECTOR__INDEPENDENT_SIG_MSG: 0 Vector__XXX\n SG_ free : 0|8@1+ (1,0) [0|1] "" Vector__XXX\n';
  const db = P.parseDbc(t);
  assert.equal(D.messageAt(db, t.indexOf('free')), null);
  assert.equal(O.rootNodes(db).some(function (n) { return n.kind === 'independent' && n.detail === '1'; }), true);
});

test('labels and one-line summaries', () => {
  assert.equal(D.messageLabel(msg('EngineStatus')), '0x100 EngineStatus');
  assert.equal(D.messageLabel(msg('ChargerStatus')), '0x18FF50E5 ChargerStatus');
  assert.equal(D.plural(1, 'bit'), '1 bit');
  assert.equal(D.plural(2, 'bit'), '2 bits');
  const rows = C.decodeMessage(msg('GearStatus'), Uint8Array.from([0x30, 0x0A, 0x28, 0x7B]), 4).rows;
  // GearSelected = upper nibble of byte 0 = 3 "Drive"; VehicleSpeed = 0x0A28 = 2600, times 0.01 = 26.
  assert.equal(D.valueSummary(rows[0]), '3 "Drive" (raw 3)');
  assert.equal(D.valueSummary(rows[2]), '26 km/h (raw 2600)');
  assert.equal(D.valueSummary({ status: 'absent', reason: 'present when PageIndex = 1' }), 'not present (present when PageIndex = 1)');
  assert.equal(D.valueSummary({ status: 'short', reason: 'the frame is short' }), 'not decoded (the frame is short)');
});

// ---- outline ---------------------------------------------------------------------------------------------

test('outline: the top level and the messages in ID order, standard IDs first', () => {
  const roots = O.rootNodes(DB);
  assert.deepEqual(roots.map(function (n) { return n.kind + ' ' + n.label + ' ' + n.detail; }), ['messages Messages 8', 'nodes Nodes 6', 'valueTables Value tables 2']);
  const messages = O.childrenOf(DB, roots[0]);
  assert.deepEqual(messages.map(function (n) { return n.label; }), ['0x100 EngineStatus', '0x120 GearStatus', '0x130 BrakeStatus', '0x200 TripComputer', '0x300 AmbientSensor', '0x310 Odometer', '0x7F0 GatewayHeartbeat', '0x18FF50E5 ChargerStatus']);
  assert.equal(messages[0].detail, '8 bytes · EngineUnit · 6 signals · 10 ms');
  assert.equal(messages[5].detail, '8 bytes · Dashboard · 1 signal · 1000 ms');
  assert.equal(messages[6].detail, '1 byte · Gateway · 2 signals · 500 ms');
  assert.equal(messages[0].offset, msg('EngineStatus').nameStart);
  assert.equal(messages.every(function (n) { return n.expandable; }), true);
});

test('outline: signals of a message, with the multiplexor and the multiplexed signals marked', () => {
  const trip = O.childrenOf(DB, O.childrenOf(DB, O.rootNodes(DB)[0])[3]);
  assert.deepEqual(trip.map(function (n) { return n.kind + ' ' + n.label + ' | ' + n.detail; }), [
    'multiplexor PageIndex | M 0|8@1+',
    'multiplexed TripDistance | m0 8|24@1+ km',
    'multiplexed TripTime | m0 32|32@1+ s',
    'multiplexed AverageSpeed | m1 8|16@1+ km/h',
    'multiplexed AverageConsumption | m1 24|16@1+ l/100km',
    'multiplexed OutsideTemp | m2 8|8@1- degC',
    'multiplexed BatteryVoltage | m2 16|16@1+ V'
  ]);
  const engine = O.childrenOf(DB, O.childrenOf(DB, O.rootNodes(DB)[0])[0]);
  assert.equal(engine[0].kind, 'signal');
  assert.equal(engine[0].detail, '0|16@1+ rpm');
  assert.equal(engine[3].detail, '32|12@1- Nm');
  assert.equal(engine[5].offset, sig('EngineStatus', 'StatusCounter').nameStart);
  const pressure = O.childrenOf(DB, O.childrenOf(DB, O.rootNodes(DB)[0])[4]);
  assert.equal(pressure[0].detail, '0|32@1- float32 hPa');
  assert.equal(pressure[1].detail, '39|16@0- deg');
});

test('outline: nodes with the number of messages they send, and value tables', () => {
  const nodes = O.childrenOf(DB, O.rootNodes(DB)[1]);
  assert.deepEqual(nodes.map(function (n) { return n.label + ' ' + n.detail; }), ['EngineUnit sends 1 message', 'GearUnit sends 1 message', 'BrakeUnit sends 1 message', 'Dashboard sends 2 messages', 'Gateway sends 3 messages', 'ChargerUnit sends 1 message']);
  const tables = O.childrenOf(DB, O.rootNodes(DB)[2]);
  assert.deepEqual(tables.map(function (n) { return n.label + ' ' + n.detail; }), ['GearPosition 5 values', 'ChargeStates 5 values']);
  assert.equal(O.childrenOf(DB, { kind: 'valueTable' }).length, 0);
  assert.equal(O.childrenOf(DB, { kind: 'unknown' }).length, 0);
});

test('outline: more than 500 messages are shown in pages', () => {
  const text = H.bigDbc(1203, 1);
  const db = P.parseDbc(text);
  const root = O.rootNodes(db)[0];
  const pages = O.childrenOf(db, root);
  assert.deepEqual(pages.map(function (p) { return p.label; }), ['Messages 1 to 500', 'Messages 501 to 1000', 'Messages 1001 to 1203']);
  assert.equal(pages[2].detail, '0x3E9 to 0x4B3');
  assert.equal(O.childrenOf(db, pages[2]).length, 203);
  assert.equal(O.childrenOf(db, pages[1])[0].label, '0x1F5 Msg500');
  const exactly = P.parseDbc(H.bigDbc(500, 1));
  assert.equal(O.childrenOf(exactly, O.rootNodes(exactly)[0]).length, 500, 'exactly 500 messages need no pages');
});

test('outline: long lists of nodes and value tables are shown in pages and the send counts are right', () => {
  const nodes = [];
  for (let k = 0; k < 1203; k++) nodes.push('N' + k);
  const tables = [];
  for (let k = 0; k < 600; k++) tables.push('VAL_TABLE_ T' + k + ' 1 "on" 0 "off" ;');
  const text = 'BU_: ' + nodes.join(' ') + '\nBO_ 1 A: 8 N5\n SG_ s : 0|8@1+ (1,0) [0|1] "" N6\nBO_ 2 B: 8 N5\n SG_ s : 0|8@1+ (1,0) [0|1] "" N6\nBO_TX_BU_ 1 : N5,N7,N7;\n' + tables.join('\n') + '\n';
  const db = P.parseDbc(text);
  const roots = O.rootNodes(db);
  const nodePages = O.childrenOf(db, roots[1]);
  assert.deepEqual(nodePages.map(function (p) { return p.label; }), ['Nodes 1 to 500', 'Nodes 501 to 1000', 'Nodes 1001 to 1203']);
  const first = O.childrenOf(db, nodePages[0]);
  assert.equal(first.length, 500);
  assert.equal(first[0].detail, 'sends 0 messages');
  assert.equal(first[5].detail, 'sends 2 messages', 'N5 sends both messages; being named again as an extra transmitter of message 1 does not count twice');
  assert.equal(first[7].detail, 'sends 1 message', 'N7 is listed twice for message 1 and counts once');
  assert.equal(O.childrenOf(db, nodePages[2]).length, 203);
  const tablePages = O.childrenOf(db, roots[2]);
  assert.deepEqual(tablePages.map(function (p) { return p.label; }), ['Value tables 1 to 500', 'Value tables 501 to 600']);
  assert.equal(O.childrenOf(db, tablePages[1])[0].label, 'T500');
  assert.equal(O.childrenOf(db, tablePages[1])[0].detail, '2 values');
});

test('document symbols stop at a fixed number of entries per kind', () => {
  const lim = O.SYMBOL_LIMITS;
  assert.deepEqual(Object.keys(lim).sort(), ['messages', 'nodes', 'signals', 'valueTables']);
  const nodes = [];
  for (let k = 0; k < lim.nodes + 10; k++) nodes.push('N' + k);
  const signals = [];
  for (let k = 0; k < lim.signals + 10; k++) signals.push(' SG_ s' + k + ' : 0|1@1+ (1,0) [0|1] "" N0');
  const tables = [];
  for (let k = 0; k < lim.valueTables + 10; k++) tables.push('VAL_TABLE_ T' + k + ' 1 "on" ;');
  const db = P.parseDbc('BU_: ' + nodes.join(' ') + '\n' + tables.join('\n') + '\nBO_ 1 A: 8 N0\n' + signals.join('\n') + '\n');
  const symbols = O.symbols(db);
  assert.equal(symbols[0].children.length, lim.nodes);
  assert.equal(symbols[0].detail, String(lim.nodes + 10), 'the real number is still shown');
  assert.equal(symbols.filter(function (s) { return s.kind === 'valueTable'; }).length, lim.valueTables);
  assert.equal(symbols[symbols.length - 1].children.length, lim.signals);
});

test('document symbols follow the text; every range lies inside it and the name range inside the symbol', () => {
  const symbols = O.symbols(DB);
  assert.deepEqual(symbols.map(function (s) { return s.kind + ' ' + s.name; }), [
    'nodes Nodes', 'valueTable GearPosition', 'valueTable ChargeStates',
    'message 0x100 EngineStatus', 'message 0x120 GearStatus', 'message 0x130 BrakeStatus', 'message 0x200 TripComputer', 'message 0x18FF50E5 ChargerStatus',
    'message 0x300 AmbientSensor', 'message 0x310 Odometer', 'message 0x7F0 GatewayHeartbeat'
  ]);
  let previous = -1;
  for (const s of symbols) {
    assert.ok(s.start > previous, s.name + ' is after the one before');
    previous = s.start;
    assert.ok(s.start <= s.selStart && s.selEnd <= s.end && s.end <= TEXT.length, s.name);
    for (const c of s.children) assert.ok(s.start <= c.start && c.end <= s.end && c.selStart >= c.start && c.selEnd <= c.end, c.name);
  }
  const engine = symbols[3];
  assert.ok(TEXT.slice(engine.start, engine.end).startsWith('BO_ 256 EngineStatus: 8 EngineUnit'));
  assert.ok(TEXT.slice(engine.start, engine.end).endsWith('"" Gateway'));
  assert.equal(TEXT.slice(engine.selStart, engine.selEnd), 'EngineStatus');
  assert.equal(engine.children.length, 6);
  assert.equal(engine.children[0].name, 'EngineSpeed');
  assert.equal(engine.children[0].detail, '0|16@1+ rpm');
  assert.equal(TEXT.slice(engine.children[0].selStart, engine.children[0].selEnd), 'EngineSpeed');
  assert.equal(symbols[0].children.length, 6);
  assert.equal(symbols[0].detail, '6');
});

test('the message list for Go To Message has label, description and the start of the comment', () => {
  const items = O.messageItems(DB);
  assert.equal(items.length, 8);
  assert.equal(items[0].label, '0x100 EngineStatus');
  assert.equal(items[0].description, '8 bytes · EngineUnit · 6 signals · 10 ms');
  assert.equal(items[0].detail, 'Engine speed, coolant temperature, throttle position and torque.');
  assert.equal(items[0].message, msg('EngineStatus'));
  assert.equal(items[1].detail, undefined);
  assert.equal(items[7].label, '0x18FF50E5 ChargerStatus');
  const long = P.parseDbc('BO_ 1 A: 8 N\nCM_ BO_ 1 "' + 'word '.repeat(100) + '";\n');
  assert.equal(O.messageItems(long)[0].detail.length, 120);
});

// ---- bit layout text ---------------------------------------------------------------------------------

function layoutRows(md) {
  return md.split('\n').filter(function (l) { return /^\| \d+ \|/.test(l); }).map(function (l) { return H.tableCells(l).map(function (c) { return c.trim(); }); });
}

test('layout of a little-endian message, checked bit by bit by hand', () => {
  // EngineSpeed 0|16 (A), CoolantTemp 16|8 (B), ThrottlePosition 24|8 (C), EngineTorque 32|12 (D),
  // EngineRunning 44|1 (E), StatusCounter 60|4 (F). Columns run from bit 7 down to bit 0.
  const md = L.layoutMarkdown(DB, msg('EngineStatus'));
  assert.ok(md.startsWith('# Bit layout of EngineStatus (0x100)\n'));
  assert.deepEqual(layoutRows(md), [
    ['0', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A ▼'],
    ['1', 'A ▲', 'A', 'A', 'A', 'A', 'A', 'A', 'A'],
    ['2', 'B ▲', 'B', 'B', 'B', 'B', 'B', 'B', 'B ▼'],
    ['3', 'C ▲', 'C', 'C', 'C', 'C', 'C', 'C', 'C ▼'],
    ['4', 'D', 'D', 'D', 'D', 'D', 'D', 'D', 'D ▼'],
    ['5', '·', '·', '·', 'E', 'D ▲', 'D', 'D', 'D'],
    ['6', '·', '·', '·', '·', '·', '·', '·', '·'],
    ['7', 'F ▲', 'F', 'F', 'F ▼', '·', '·', '·', '·']
  ]);
  assert.match(md, /\| D \| EngineTorque \| 32\\\|12 \| little-endian \| signed integer \\\(two's complement\\\) \| raw × 0\.5 \\\+ 0 \| Nm \|/);
  assert.match(md, /\n## Layout\n/);
});

test('layout of a big-endian message, checked bit by bit by hand', () => {
  // GearSelected 7|4@0 (A): bits 7 to 4 of byte 0. ShiftActive 3|1@0 (B): bit 3 of byte 0.
  // VehicleSpeed 15|16@0 (C): byte 1 and byte 2. GearboxTemp 31|8@0 (D): byte 3.
  const md = L.layoutMarkdown(DB, msg('GearStatus'));
  assert.deepEqual(layoutRows(md), [
    ['0', 'A ▲', 'A', 'A', 'A ▼', 'B', '·', '·', '·'],
    ['1', 'C ▲', 'C', 'C', 'C', 'C', 'C', 'C', 'C'],
    ['2', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C ▼'],
    ['3', 'D ▲', 'D', 'D', 'D', 'D', 'D', 'D', 'D ▼']
  ]);
});

test('layout of a multiplexed message: a table for the signals present in every frame and one for each page', () => {
  const md = L.layoutMarkdown(DB, msg('TripComputer'));
  const titles = md.split('\n').filter(function (l) { return l.startsWith('## '); });
  assert.deepEqual(titles, ['## Signals present in every frame', '## PageIndex = 0', '## PageIndex = 1', '## PageIndex = 2']);
  const rows = layoutRows(md);
  assert.equal(rows.length, 32);
  // page 0: TripDistance 8|24 (B) is bytes 1 to 3, TripTime 32|32 (C) is bytes 4 to 7
  assert.deepEqual(rows[8 + 1], ['1', 'B', 'B', 'B', 'B', 'B', 'B', 'B', 'B ▼']);
  assert.deepEqual(rows[8 + 3], ['3', 'B ▲', 'B', 'B', 'B', 'B', 'B', 'B', 'B']);
  assert.deepEqual(rows[8 + 4], ['4', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C ▼']);
  assert.deepEqual(rows[8 + 7], ['7', 'C ▲', 'C', 'C', 'C', 'C', 'C', 'C', 'C']);
  // page 1 and page 2 share bytes 1 to 3 with page 0 without a conflict
  assert.equal(md.includes(' !'), false);
});

test('layout marks bits that two signals use and says how many', () => {
  const t = 'BU_: N\nBO_ 1 A: 4 N\n SG_ a : 0|8@1+ (1,0) [0|1] "" N\n SG_ b : 4|8@1+ (1,0) [0|1] "" N\n SG_ big : 24|16@1+ (1,0) [0|1] "" N\n';
  const db = P.parseDbc(t);
  const md = L.layoutMarkdown(db, db.messages[0]);
  assert.match(md, /4 bits used by more than one signal \\\(marked \\!\\\)\./);
  // a: bits 0 to 7, b: bits 4 to 11, big: bits 24 to 39 (byte 4 lies beyond the 4 data bytes).
  // The four bits that a and b share are marked with "!" and show both keys.
  const rows = layoutRows(md);
  assert.deepEqual(rows[0], ['0', 'A+B !', 'A+B !', 'A+B !', 'A+B !', 'A', 'A', 'A', 'A ▼']);
  // b ends (most significant bit) at bit 11 = byte 1 bit 3; its least significant bit, bit 4, lies in the shared cell above
  assert.deepEqual(rows[1], ['1', '·', '·', '·', '·', 'B ▲', 'B', 'B', 'B']);
  assert.deepEqual(rows[3], ['3', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C ▼']);
  assert.match(md, /\| 4 \(beyond the data length\) \| C ▲ \| C \|/);
});

test('layout lists signals that cannot be decoded and keeps going', () => {
  const t = 'BU_: N\nBO_ 1 A: 8 N\n SG_ s1 M : 0|8@1+ (1,0) [0|1] "" N\n SG_ s2 M : 8|8@1+ (1,0) [0|1] "" N\n SG_ x m0 : 16|8@1+ (1,0) [0|1] "" N\n';
  const db = P.parseDbc(t);
  const md = L.layoutMarkdown(db, db.messages[0]);
  assert.match(md, /\n## Not decoded\n/);
  assert.match(md, /\* x: several multiplexors could select it/);
});

test('layout of a message whose signal ends beyond the data length shows the extra bytes', () => {
  const t = 'BU_: N\nBO_ 1 A: 2 N\n SG_ wide : 8|24@1+ (1,0) [0|1] "" N\n';
  const db = P.parseDbc(t);
  const lay = L.layoutOf(db.messages[0]);
  assert.equal(lay.bytes, 4);
  assert.equal(lay.size, 2);
  assert.match(L.layoutMarkdown(db, db.messages[0]), /\| 2 \(beyond the data length\) \|/);
});

test('cell text and grid helpers', () => {
  const keys = new Map([[0, 'A'], [1, 'B']]);
  assert.equal(L.cellText([], keys), '·');
  assert.equal(L.cellText([{ index: 0, msb: true, lsb: true }], keys), 'A');
  assert.equal(L.cellText([{ index: 0, msb: true, lsb: false }], keys), 'A ▲');
  assert.equal(L.cellText([{ index: 0, msb: false, lsb: true }], keys), 'A ▼');
  assert.equal(L.cellText([{ index: 0, msb: false, lsb: false }, { index: 1, msb: false, lsb: false }], keys), 'A+B !');
  const g = L.gridOf(msg('GearStatus'), msg('GearStatus').signals, 4);
  assert.equal(g.bytes, 4);
  assert.equal(g.cells.length, 32);
  assert.deepEqual(g.cells[7], [{ index: 0, msb: true, lsb: false }]);
  assert.deepEqual(g.cells[3], [{ index: 1, msb: true, lsb: true }]);
  assert.equal(L.gridOf(msg('GearStatus'), [], 0).bytes, 1);
});
