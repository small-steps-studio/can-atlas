'use strict';
// Regression tests for the independent audit of 0.1.0:
//   defect 3   ASCII logs with "base dec": the data bytes are decimal too (they were read as hex, giving wrong values),
//   defect 9   candump -e error frames are skipped, not counted as unreadable lines with a wrong reason,
//   defect 12  CAN FD frames with a length CAN FD cannot carry are bad lines.

const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/trace/formats');
const { decodeTrace } = require('../src/trace/run');
const P = require('../src/dbc/parse');
const H = require('./helpers/trace-util');

// The audit's own example: V = raw x 0.01 with raw taken from the first two bytes, little endian.
const SPEED_DBC = 'VERSION ""\nBU_: A B\nBO_ 256 Speed: 8 A\n SG_ V : 0|16@1+ (0.01,0) [0|655.35] "" B\n';
const speed = P.parseDbc(SPEED_DBC);

function decodeText(text, options) { return decodeTrace({ kind: 'text', text: text }, speed, options || {}); }
function frame(p, line) {
  assert.equal(p.parseLine(line), F.FRAME, line + ' (' + p.reason + ')');
  return { timeUs: p.rec.timeUs, id: p.rec.id, extended: p.rec.extended, fd: p.rec.fd, data: Array.from(p.rec.data.subarray(0, p.rec.len)) };
}

// ---- defect 3 --------------------------------------------------------------------------------------

test('ASCII log with "base dec": the data bytes are read as decimal numbers (the audit\'s example)', async () => {
  const text = 'base dec  timestamps absolute\n' +
    '   0.015000 1  256             Rx   d 8 16 39 0 0 0 0 0 0\n' +
    '   0.025000 1  256             Rx   d 8 16 39 0 0 0 0 0 255\n';
  const res = await decodeText(text);
  assert.equal(res.format, 'asc');
  assert.equal(res.counters.frames, 2);
  assert.equal(res.counters.badLines, 0);
  assert.deepEqual(res.rows.map((r) => r.physicalText), ['100', '100'], '16 and 39 are the bytes 0x10 and 0x27: 10000 x 0.01 = 100');
  assert.deepEqual(res.rows.map((r) => r.rawText), ['10000', '10000']);
});

test('ASCII log with "base hex" still reads hex bytes; the same line in the other base means another value', async () => {
  const hex = await decodeText('base hex  timestamps absolute\n   0.015000 1  100  Rx   d 8 16 39 00 00 00 00 00 00\n');
  assert.equal(hex.counters.badLines, 0);
  assert.equal(hex.rows[0].physicalText, '146.14', 'the same bytes in the hex base are 0x16 and 0x39');
  const hexFrame = await decodeText('base hex  timestamps absolute\n   0.015000 1  100  Rx   d 8 10 27 00 00 00 00 00 00\n');
  assert.equal(hexFrame.rows[0].physicalText, '100');
  // A three-digit decimal byte is not a hex byte: bad in the hex base.
  const bad = await decodeText('base hex  timestamps absolute\n   0.015000 1  100  Rx   d 8 16 39 0 0 0 0 0 255\n');
  assert.equal(bad.counters.badLines, 1);
});

test('"base dec" data bytes: 0 to 255 in one to three digits, anything else is a bad line with a reason', () => {
  const p = F.createAscParser();
  assert.equal(p.parseLine('base dec  timestamps absolute'), F.SKIP);
  assert.deepEqual(frame(p, '0.0 1 256 Rx d 4 0 7 99 255').data, [0, 7, 99, 255]);
  assert.deepEqual(frame(p, '0.0 1 256 Rx d 2 007 010').data, [7, 10]);
  for (const line of ['0.0 1 256 Rx d 1 256', '0.0 1 256 Rx d 1 1000', '0.0 1 256 Rx d 1 FF', '0.0 1 256 Rx d 1 1F', '0.0 1 256 Rx d 1 -1', '0.0 1 256 Rx d 1 1.5', '0.0 1 256 Rx d 2 1']) {
    assert.equal(p.parseLine(line), F.BAD, line);
    assert.ok(/decimal|fewer data bytes/.test(p.reason), line + ': ' + p.reason);
  }
  assert.equal(p.parseLine('base hex  timestamps absolute'), F.SKIP);
  assert.deepEqual(frame(p, '0.0 1 100 Rx d 2 1F 0A').data, [0x1F, 0x0A]);
});

test('the fixture of a "base dec" log holds decimal bytes and decodes to the same frames as the hex log', async () => {
  const dec = await decodeTrace({ kind: 'file', path: H.fixturePath('ascii-base-dec.asc') }, H.loadSampleDb(), {});
  const hex = await decodeTrace({ kind: 'file', path: H.fixturePath('ascii-hex.asc') }, H.loadSampleDb(), {});
  assert.equal(dec.counters.frames, 3);
  assert.equal(dec.counters.badLines, 1, 'the identifier 2048 without the x mark');
  // Frame 1: the hex log's first frame (100 = 40 1F 72 FA 8E 01 10 3C) is 256 with the same bytes in decimal.
  const decFirst = dec.rows.filter((r) => r.messageName === 'EngineStatus').map(H.brief);
  const hexFirst = hex.rows.filter((r) => r.messageName === 'EngineStatus').map(H.brief);
  assert.ok(decFirst.length > 0);
  assert.deepEqual(decFirst, hexFirst.slice(0, decFirst.length));
  const text = H.readFixtureText('ascii-base-dec.asc');
  assert.match(text, / 64 31 114 250 142 1 16 60\n/);
});

// ---- defect 9 --------------------------------------------------------------------------------------

test('candump error frames (bit 29 of the 8-digit identifier) are skipped and counted, not unreadable lines', async () => {
  const p = F.createCandumpParser();
  for (const line of ['(1.1) can0 20000004#0004000000000000', '(1.1) can0 20000001#0000000000000000', '(1.1) can0 2000008C#00', '(1.1) can0 3FFFFFFF#00']) {
    assert.equal(p.parseLine(line), F.SKIP, line);
    assert.equal(p.reason, 'error frame', line);
  }
  // A real extended frame next to them, and the lines that are still bad.
  assert.equal(p.parseLine('(1.2) can0 1FFFFFFF#00'), F.FRAME);
  for (const line of ['(1.2) can0 40000000#00', '(1.2) can0 80000000#00', '(1.2) can0 FFFFFFFF#00']) assert.equal(p.parseLine(line), F.BAD, line);
  const res = await decodeText('(1.0) can0 100#1027000000000000\n(1.1) can0 20000004#0004000000000000\n(1.2) can0 100#1027000000000000\n');
  assert.equal(res.counters.badLines, 0);
  assert.equal(res.counters.frames, 2);
  assert.equal(res.counters.skippedLines.byReason['error frame'], 1);
  const lines = res.counters.lines;
  assert.equal(lines, 3);
});

// ---- defect 12 -------------------------------------------------------------------------------------

test('CAN FD frames carry 0 to 8, 12, 16, 20, 24, 32, 48 or 64 bytes; another length is a bad line', () => {
  const p = F.createCandumpParser();
  const hexBytes = (n) => '00'.repeat(n);
  for (const n of [0, 1, 7, 8, 12, 16, 20, 24, 32, 48, 64]) assert.equal(p.parseLine('(1.0) can0 100##1' + hexBytes(n)), F.FRAME, n + ' bytes');
  for (const n of [9, 10, 11, 13, 15, 17, 19, 21, 23, 25, 31, 33, 47, 49, 63]) {
    assert.equal(p.parseLine('(1.0) can0 100##1' + hexBytes(n)), F.BAD, n + ' bytes');
    assert.match(p.reason, /CAN FD frame carries 0 to 8, 12, 16, 20, 24, 32, 48 or 64 data bytes, not \d+/, n + ' bytes');
  }
  // A classic frame still ends at 8 bytes.
  assert.equal(p.parseLine('(1.0) can0 100#' + hexBytes(9)), F.BAD);
});

test('CSV rows follow the same lengths', () => {
  const p = F.createCsvParser();
  assert.equal(p.parseLine('time,id,data'), F.SKIP);
  assert.equal(p.parseLine('1.0,100,' + '00'.repeat(12)), F.FRAME);
  assert.equal(p.parseLine('1.0,100,' + '00'.repeat(10)), F.BAD);
  assert.match(p.reason, /carries 0 to 8, 12, 16, 20, 24, 32, 48 or 64 data bytes, not 10/);
});

// ---- defect 6: the Messages table of the trace view -------------------------------------------------

test('the trace view keeps the first column of a wide table in view and its Messages table carries the cycle time columns', async () => {
  const V = require('../src/trace/view');
  const sampleText = require('../src/samples').sampleFor('trace').text;
  const db = H.loadSampleDb();
  const res = await decodeTrace({ kind: 'text', text: sampleText }, db, {});
  const html = V.renderTraceView({ title: 'Decoded trace: sample', summary: res, stats: res.stats, rows: res.rows, filter: {}, totalMatching: res.totalMatching, nonce: 'dGVzdC1ub25jZS0xMjM0NTY3OA' });
  assert.match(html, /th:first-child,td:first-child\{position:sticky;left:0;background:var\(--vscode-editor-background,#fff\)\}/);
  assert.match(html, /.scroll{overflow-x:auto;max-width:100%}/);
  assert.match(html, /<div class="scroll" tabindex="0" role="region" aria-label="Messages of the DBC found in the trace"><table>/, 'a wide table scrolls in its own named region');
  assert.equal((html.match(/<div class="scroll"/g) || []).length, (html.match(/<table/g) || []).length, 'every table has its region');
  const messages = html.slice(html.indexOf('<table><caption>Messages of the DBC found in the trace'), html.indexOf('</table>', html.indexOf('Messages of the DBC found in the trace')));
  const headers = Array.from(messages.matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)).map((m) => m[1]);
  assert.ok(headers.length >= 14, headers.join('|'));
  assert.ok(headers.some((h) => /cycle time/i.test(h)), 'a cycle time column: ' + headers.join('|'));
  assert.ok(headers.filter((h) => /cycle|deviat/i.test(h)).length >= 3, 'the cycle time columns: ' + headers.join('|'));
});
