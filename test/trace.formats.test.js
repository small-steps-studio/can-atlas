'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/trace/formats');
const H = require('./helpers/trace-util');

function frame(parser, line) {
  const code = parser.parseLine(line);
  assert.equal(code, F.FRAME, 'expected a frame for ' + JSON.stringify(line) + ' but got ' + parser.reason);
  const r = parser.rec;
  return { timeUs: r.timeUs, channel: r.channel, id: r.id, extended: r.extended, fd: r.fd, data: Array.from(r.data.subarray(0, r.len)) };
}

test('times are read exactly as whole microseconds', () => {
  assert.equal(F.parseTimeUs('0'), 0);
  assert.equal(F.parseTimeUs('0.015000'), 15000);
  assert.equal(F.parseTimeUs('.5'), 500000);
  assert.equal(F.parseTimeUs('5.'), 5000000);
  assert.equal(F.parseTimeUs(' 12.000005 '), 12000005);
  assert.equal(F.parseTimeUs('1762944000.000100'), 1762944000000100);
  assert.equal(F.parseTimeUs('9007199253.999999'), 9007199253999999);
});

test('a seventh decimal digit of 5 or more rounds up and further digits are ignored', () => {
  assert.equal(F.parseTimeUs('1.0000004'), 1000000);
  assert.equal(F.parseTimeUs('1.0000005'), 1000001);
  assert.equal(F.parseTimeUs('1.0000004999999'), 1000000);
  assert.equal(F.parseTimeUs('1.9999995'), 2000000);
  assert.equal(F.parseTimeUs('0.1234567891'), 123457);
});

test('text that is not a plain number of seconds is refused', () => {
  for (const bad of ['', ' ', '.', '-1', '+1', '1e3', '1,5', '1.2.3', 'abc', '1 2', '0x10', '12345678901', '9007199254', '9007199255', '1.5s']) {
    assert.equal(F.parseTimeUs(bad), -1, JSON.stringify(bad));
  }
});

test('times are printed as seconds with six decimals', () => {
  assert.equal(F.formatTimeUs(0), '0.000000');
  assert.equal(F.formatTimeUs(15000), '0.015000');
  assert.equal(F.formatTimeUs(1762944000000100), '1762944000.000100');
  assert.equal(F.formatTimeUs(12000005), '12.000005');
  assert.equal(F.formatTimeUs(NaN), '');
  for (const t of [0, 1, 999999, 1000000, 1762944000123456]) assert.equal(F.parseTimeUs(F.formatTimeUs(t)), t);
});

test('hexToBytes reads pairs, ignores separators between pairs and refuses everything else', () => {
  const out = new Uint8Array(8);
  assert.equal(F.hexToBytes('DEADBEEF', 0, 8, out, 8), 4);
  assert.deepEqual(Array.from(out.subarray(0, 4)), [0xDE, 0xAD, 0xBE, 0xEF]);
  assert.equal(F.hexToBytes('DE.AD be-ef:00', 0, 14, out, 8), 5);
  assert.equal(F.hexToBytes('', 0, 0, out, 8), 0);
  assert.equal(F.hexToBytes('D', 0, 1, out, 8), -1);
  assert.equal(F.hexToBytes('D E', 0, 3, out, 8), -1);
  assert.equal(F.hexToBytes('GG', 0, 2, out, 8), -1);
  assert.equal(F.hexToBytes('112233445566778899', 0, 18, out, 8), -1);
  assert.equal(F.hexToBytes('éé', 0, 2, out, 8), -1);
});

test('candump lines: standard, extended, lower case, extra trailing text', () => {
  const p = F.createCandumpParser();
  assert.deepEqual(frame(p, '(1762944000.000100) can0 123#DEADBEEF'), { timeUs: 1762944000000100, channel: 'can0', id: 0x123, extended: false, fd: false, data: [0xDE, 0xAD, 0xBE, 0xEF] });
  assert.deepEqual(frame(p, '(1.5) vcan1 18ff50e5#c2ff'), { timeUs: 1500000, channel: 'vcan1', id: 0x18FF50E5, extended: true, fd: false, data: [0xC2, 0xFF] });
  assert.deepEqual(frame(p, '  (0.000001)   can0   7F0#   RX').data, []);
  assert.deepEqual(frame(p, '(0.000001) can0 7F0#DE.AD.BE').data, [0xDE, 0xAD, 0xBE]);
  assert.deepEqual(frame(p, '(2.0) can0 1FFFFFFF#00'), { timeUs: 2000000, channel: 'can0', id: 0x1FFFFFFF, extended: true, fd: false, data: [0] });
});

test('candump lines: FD frames carry a flags digit before the data', () => {
  const p = F.createCandumpParser();
  const f = frame(p, '(1.0) can0 123##1' + '00112233445566778899AABBCCDDEEFF'.repeat(1));
  assert.equal(f.fd, true);
  assert.equal(f.data.length, 16);
  assert.equal(frame(p, '(1.0) can0 123##0').data.length, 0);
  assert.equal(frame(p, '(1.0) can0 123##3' + '00'.repeat(64)).data.length, 64);
  assert.equal(p.parseLine('(1.0) can0 123##3' + '00'.repeat(65)), F.BAD);
  assert.equal(p.parseLine('(1.0) can0 123##'), F.BAD);
  assert.equal(p.parseLine('(1.0) can0 123##G00'), F.BAD);
});

test('candump lines: remote frames, comments and blank lines are skipped, not errors', () => {
  const p = F.createCandumpParser();
  for (const [line, reason] of [['(1.0) can0 123#R', 'remote frame'], ['(1.0) can0 123#R8', 'remote frame'], ['(1.0) can0 123#r', 'remote frame'], ['', 'blank line'], ['   \t', 'blank line'], ['# note', 'comment line'], [';x', 'comment line']]) {
    assert.equal(p.parseLine(line), F.SKIP, line);
    assert.equal(p.reason, reason);
  }
});

test('candump lines: each kind of damage is a bad line with a reason', () => {
  const p = F.createCandumpParser();
  const bad = [
    'hello', '(1.0 can0 123#00', '(x) can0 123#00', '(1.0)', '(1.0) can0', '(1.0) can0 123', '(1.0) can0 12#00', '(1.0) can0 1234#00', '(1.0) can0 800#00',
    '(1.0) can0 40000000#00', '(1.0) can0 FFFFFFFF#00', '(1.0) can0 GGG#00', '(1.0) can0 123#0', '(1.0) can0 123#001122334455667788', '(1.0) can0 123#ZZ', '(1.0) can0 123#0 0'
  ];
  for (const line of bad) {
    assert.equal(p.parseLine(line), F.BAD, JSON.stringify(line));
    assert.ok(p.reason.length > 10, 'a reason for ' + line);
  }
});

test('candump parser refuses very long lines at once and a huge run of spaces cannot make it slow', () => {
  const p = F.createCandumpParser();
  const t0 = Date.now();
  assert.equal(p.parseLine('(' + ' '.repeat(1000000)), F.BAD);
  assert.equal(p.parseLine(' '.repeat(1000000) + '(1.0) can0 123#00'), F.BAD);
  assert.ok(Date.now() - t0 < 500);
});

test('CSV: header detection, delimiters and column aliases', () => {
  assert.deepEqual(F.parseCsvHeader('time,id,data').columns, { time: 0, id: 1, data: 2 });
  assert.equal(F.parseCsvHeader('time,id,data').delimiter, ',');
  assert.equal(F.parseCsvHeader('Time;ID;Data;Channel').delimiter, ';');
  assert.equal(F.parseCsvHeader('Time;ID;Data;Channel').columns.channel, 3);
  assert.equal(F.parseCsvHeader('time\tid\tdata').delimiter, '\t');
  assert.deepEqual(F.parseCsvHeader('"Timestamp","CAN ID","Payload"').columns, { time: 0, id: 1, data: 2 });
  assert.deepEqual(F.parseCsvHeader('Timestamp,Can_ID,Payload,Bus,DLC,IDE,ID Format').columns, { time: 0, id: 1, data: 2, channel: 3, dlc: 4, extended: 5, idFormat: 6 });
  assert.equal(F.parseCsvHeader('time,id'), null);
  assert.equal(F.parseCsvHeader('a,b,c'), null);
  assert.equal(F.parseCsvHeader('constructor,__proto__,toString'), null);
});

test('CSV: rows with hex and decimal ids, the extended column and quoted cells', () => {
  const p = F.createCsvParser();
  assert.equal(p.parseLine('index,timestamp,channel,id_format,id,dlc,extended,data'), F.SKIP);
  assert.equal(p.reason, 'header row');
  assert.deepEqual(frame(p, '1,10.5,bus-a,dec,256,8,0,401F72FA8E01103C'), { timeUs: 10500000, channel: 'bus-a', id: 256, extended: false, fd: false, data: [0x40, 0x1F, 0x72, 0xFA, 0x8E, 0x01, 0x10, 0x3C] });
  assert.equal(frame(p, '2,10.5,"bus,b",hex,100,1,0,00').id, 0x100);
  assert.equal(frame(p, '2,10.5,"bus,b",hex,100,1,0,00').channel, 'bus,b');
  assert.equal(frame(p, '3,1,x,dec,419385573,8,1,00').id, 0x18FF50E5);
  assert.equal(frame(p, '3,1,x,dec,419385573,8,1,00').extended, true);
  assert.equal(frame(p, '4,1,x,hex,0x7F0,1,,21').id, 0x7F0);
  assert.equal(frame(p, '5,1,x,hex,18FF50E5,8,,00').extended, true);
  assert.equal(frame(p, '6,1,x,hex,123,8,1,00').extended, true);
  assert.deepEqual(frame(p, '7,1,x,hex,123,0,0,').data, []);
  assert.deepEqual(frame(p, '8,1,x,hex,123,2,0,0x1122').data, [0x11, 0x22]);
});

test('CSV: damaged rows are bad lines, comments and blank lines are skipped', () => {
  const p = F.createCsvParser();
  assert.equal(p.parseLine('# before the header'), F.SKIP);
  assert.equal(p.parseLine('some text before the header'), F.SKIP);
  assert.equal(p.reason, 'line before the header row');
  p.parseLine('time,id,data');
  assert.equal(p.parseLine(''), F.SKIP);
  assert.equal(p.parseLine('# comment'), F.SKIP);
  for (const line of ['1.0,100', 'x,100,00', '1.0,,00', '1.0,GG,00', '1.0,800000000,00', '1.0,100,0', '1.0,100,ZZ', '1.0,"100,00', '1.0,100,' + '00'.repeat(65)]) {
    assert.equal(p.parseLine(line), F.BAD, line);
  }
  const q = F.createCsvParser();
  q.parseLine('time,id,data,extended');
  assert.equal(q.parseLine('1.0,800,00,0'), F.BAD);
  assert.match(q.reason, /11 bits/);
});

test('CSV: splitCsvLine handles quotes, doubled quotes and empty cells', () => {
  assert.deepEqual(F.splitCsvLine('a,b,c', ','), ['a', 'b', 'c']);
  assert.deepEqual(F.splitCsvLine('a,,c,', ','), ['a', '', 'c', '']);
  assert.deepEqual(F.splitCsvLine('"a,b",c', ','), ['a,b', 'c']);
  assert.deepEqual(F.splitCsvLine('"say ""hi""",x', ','), ['say "hi"', 'x']);
  assert.deepEqual(F.splitCsvLine('"",x', ','), ['', 'x']);
  assert.deepEqual(F.splitCsvLine('a;"b;c"', ';'), ['a', 'b;c']);
  assert.equal(F.splitCsvLine('"open', ','), null);
});

test('ASCII log: data frames, extended marker, text after the data, direction names', () => {
  const p = F.createAscParser();
  assert.deepEqual(frame(p, '   0.015000 1  123  Rx   d 8 DE AD BE EF 00 11 22 33'), { timeUs: 15000, channel: '1', id: 0x123, extended: false, fd: false, data: [0xDE, 0xAD, 0xBE, 0xEF, 0, 0x11, 0x22, 0x33] });
  assert.deepEqual(frame(p, '1.000000 2 18FF50E5x Tx d 2 C2 FF  Length = 1 BitCount = 2').data, [0xC2, 0xFF]);
  assert.equal(frame(p, '1.000000 2 18FF50E5x Tx d 2 C2 FF').extended, true);
  assert.deepEqual(frame(p, '1.000000 2 123 TxRq d 0').data, []);
  assert.deepEqual(frame(p, '1.000000 2 123 EngineStatus Rx d 1 7').data, [7]);
  assert.equal(frame(p, '1.000000 2 123 rx D 1 7').id, 0x123);
});

test('ASCII log: headers, events, remote and CANFD lines are skipped, damaged frames are bad', () => {
  const p = F.createAscParser();
  for (const [line, reason] of [
    ['date Thu Nov 12 09:00:00.000 am 2026', 'header or comment line'], ['base hex  timestamps absolute', 'header line'], ['// comment', 'header or comment line'],
    ['Begin Triggerblock Thu Nov 12', 'header or comment line'], ['   0.000000 Start of measurement', 'event line (not a classic CAN message)'], ['1.0 1 ErrorFrame', 'event line (not a classic CAN message)'],
    ['1.0 CANFD 1 Rx 100 x 1 0 8 8 00 00 00 00 00 00 00 00', 'CANFD line (not read)'], ['1.0 1 123 Rx r', 'remote frame'], ['', 'blank line']
  ]) {
    assert.equal(p.parseLine(line), F.SKIP, line);
    assert.equal(p.reason, reason, line);
  }
  for (const line of ['1.0 1 123 Zz d 8 00', '1.0 1 123 Rx q 8 00', '1.0 1 123 Rx d 9 00', '1.0 1 123 Rx d 2 00', '1.0 1 123 Rx d 1 GG', '1.0 1 800 Rx d 1 00', '1.0 1 20000000x Rx d 1 00', '1.0 1 123 Rx d x 00']) {
    assert.equal(p.parseLine(line), F.BAD, line);
  }
});

test('ASCII log: "base dec" makes the ids decimal', () => {
  const p = F.createAscParser();
  assert.equal(p.parseLine('base dec  timestamps absolute'), F.SKIP);
  assert.equal(p.base, 'dec');
  assert.equal(frame(p, '0.0 1 256 Rx d 1 00').id, 256);
  assert.equal(frame(p, '0.0 1 419385573x Rx d 1 00').id, 0x18FF50E5);
  assert.equal(p.parseLine('base hex  timestamps absolute'), F.SKIP);
  assert.equal(frame(p, '0.0 1 256 Rx d 1 00').id, 0x256);
});

test('detection picks the layout from the first lines', () => {
  assert.equal(F.detectFormat(['(1.0) can0 123#00', '(2.0) can0 123#00']), 'candump');
  assert.equal(F.detectFormat(['time,id,data', '1.0,123,00']), 'csv');
  assert.equal(F.detectFormat(['', '# note', 'Time;ID;Data', '1.0;123;00']), 'csv');
  assert.equal(F.detectFormat(['date Thu', 'base hex timestamps absolute', '0.1 1 123 Rx d 1 00']), 'asc');
  assert.equal(F.detectFormat(['base hex timestamps absolute']), 'asc');
  assert.equal(F.detectFormat(['hello', 'world']), null);
  assert.equal(F.detectFormat([]), null);
  assert.equal(F.detectFormat(['', '   ']), null);
  assert.equal(F.detectFormat(H.readFixtureText('ascii-hex.asc').split('\n')), 'asc');
  assert.equal(F.detectFormat(H.readFixtureText('mixed-garbage.candump.log').split('\n')), 'candump');
  assert.equal(F.detectFormat(H.readFixtureText('extra-columns.csv').split('\n')), 'csv');
  assert.equal(F.detectFormat(H.readFixtureText('tab-delimited.csv').split('\n')), 'csv');
});

test('createParser knows the three names and nothing else', () => {
  assert.equal(F.createParser('candump').format, 'candump');
  assert.equal(F.createParser('csv').format, 'csv');
  assert.equal(F.createParser('asc').format, 'asc');
  assert.equal(F.createParser('xml'), null);
  assert.equal(F.createParser(undefined), null);
});
