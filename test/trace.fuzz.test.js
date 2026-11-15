'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const F = require('../src/trace/formats');
const { decodeTrace } = require('../src/trace/run');
const H = require('./helpers/trace-util');

const SEED = Number(process.env.CAN_ATLAS_FUZZ_SEED) || 20261112;
const ROUNDS = Number(process.env.CAN_ATLAS_FUZZ_ROUNDS) || 500;
const db = H.loadSampleDb();

const SPECIAL_BYTES = ['\r', '\n', '\r\n', '"', ',', ';', '\t', '#', '(', ')', '\0', '�', 'é', '☃', ' ', '0x', '##', '#R', 'x', '9'.repeat(40), '-', '.', 'e', '+'];

function mutate(rnd, input) {
  let b = Buffer.from(input);
  const ops = 1 + Math.floor(rnd() * 3);
  for (let k = 0; k < ops; k++) {
    const kind = Math.floor(rnd() * 8);
    if (kind === 0 && b.length) {
      const n = 1 + Math.floor(rnd() * 20);
      for (let i = 0; i < n; i++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    } else if (kind === 1 && b.length) {
      b = b.subarray(0, Math.floor(rnd() * b.length));
    } else if (kind === 2) {
      const extra = Buffer.alloc(1 + Math.floor(rnd() * 50));
      for (let i = 0; i < extra.length; i++) extra[i] = Math.floor(rnd() * 256);
      const at = Math.floor(rnd() * (b.length + 1));
      b = Buffer.concat([b.subarray(0, at), extra, b.subarray(at)]);
    } else if (kind === 3 && b.length > 2) {
      const from = Math.floor(rnd() * b.length);
      const to = Math.min(b.length, from + 1 + Math.floor(rnd() * 40));
      b = Buffer.concat([b.subarray(0, from), b.subarray(to)]);
    } else if (kind === 4 && b.length > 2) {
      const from = Math.floor(rnd() * b.length);
      const to = Math.min(b.length, from + 1 + Math.floor(rnd() * 80));
      const at = Math.floor(rnd() * (b.length + 1));
      b = Buffer.concat([b.subarray(0, at), b.subarray(from, to), b.subarray(at)]);
    } else if (kind === 5) {
      const noise = Buffer.alloc(Math.floor(rnd() * 3000));
      for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(rnd() * 256);
      b = noise;
    } else {
      const piece = Buffer.from(SPECIAL_BYTES[Math.floor(rnd() * SPECIAL_BYTES.length)], 'utf8');
      const at = Math.floor(rnd() * (b.length + 1));
      b = Buffer.concat([b.subarray(0, at), piece, b.subarray(at)]);
    }
  }
  return b;
}

function checkLineResult(parser, line, code) {
  assert.ok(code === F.FRAME || code === F.SKIP || code === F.BAD, 'result code');
  if (code === F.FRAME) {
    const r = parser.rec;
    assert.ok(Number.isInteger(r.timeUs) && r.timeUs >= 0, 'time ' + r.timeUs);
    assert.ok(Number.isInteger(r.id) && r.id >= 0 && r.id <= 0x1FFFFFFF, 'id ' + r.id);
    assert.ok(r.extended === true || r.id <= 0x7FF, 'standard ids fit 11 bits');
    assert.ok(Number.isInteger(r.len) && r.len >= 0 && r.len <= 64, 'length ' + r.len);
    assert.equal(typeof r.channel, 'string');
  } else assert.ok(typeof parser.reason === 'string' && parser.reason.length > 0, 'a reason for ' + JSON.stringify(line.slice(0, 40)));
}

function snapshot(res) {
  return JSON.stringify({ f: res.format, r: res.rows, c: res.counters, b: res.badLines, w: res.warnings, s: res.stats, u: res.unknownIds, t: [res.firstTimeUs, res.lastTimeUs] });
}

test('seeded fuzz: damaged traces never make a parser or the decoder throw, and every line is accounted for', async () => {
  const names = fs.readdirSync(H.FIXTURE_DIR);
  const inputs = names.map((n) => H.readFixture(n));
  const rnd = H.mulberry32(SEED);
  let frames = 0;
  let bad = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const base = inputs[Math.floor(rnd() * inputs.length)];
    const data = mutate(rnd, base);
    const text = data.toString('utf8');
    const lines = text.split(/\r\n|\n|\r/);
    for (const name of ['candump', 'csv', 'asc']) {
      const parser = F.createParser(name);
      for (const line of lines.slice(0, 3000)) checkLineResult(parser, line, parser.parseLine(line));
    }
    F.detectFormat(lines);
    const formats = ['auto', 'auto', 'candump', 'csv', 'asc'];
    const format = formats[Math.floor(rnd() * formats.length)];
    const chunk = [1, 3, 17, 4096, 1048576][Math.floor(rnd() * 5)];
    const options = { format: format, maxRows: 50 };
    const a = await decodeTrace({ kind: 'bytes', bytes: new Uint8Array(data), chunkSize: chunk }, db, options);
    const c = a.counters;
    assert.equal(c.lines, c.frames + c.skippedLines.total + c.badLines, 'round ' + round + ': every line is counted once');
    assert.equal(c.framesInWindow + c.framesOutsideWindow, c.frames);
    assert.equal(c.decodedFrames + c.unknownFrames, c.framesInWindow);
    assert.ok(a.rows.length <= 50 && a.totalMatching >= a.rows.length);
    for (const row of a.rows) {
      assert.equal(typeof row.rawText, 'string');
      assert.equal(typeof row.physicalText, 'string');
      assert.ok(row.physicalText.length > 0);
    }
    const again = await decodeTrace({ kind: 'bytes', bytes: new Uint8Array(data), chunkSize: chunk === 1048576 ? 5 : 1048576 }, db, options);
    assert.equal(snapshot(again), snapshot(a), 'round ' + round + ': the chunk size does not change the result');
    frames += c.frames;
    bad += c.badLines;
    if (round % 50 === 0) {
      const asText = await decodeTrace({ kind: 'text', text: data.toString('latin1'), chunkSize: 64 }, db, options);
      assert.equal(asText.counters.lines >= 0, true);
    }
  }
  assert.ok(frames > 0 && bad > 0, 'the fuzz inputs held both readable and damaged lines (' + frames + ' frames, ' + bad + ' bad lines)');
});

test('fuzz of single characters: every printable character replaced in a good line is handled', () => {
  const lines = [
    '(1762944000.000100) can0 123#DEADBEEF', '   0.015000 1  123  Rx   d 8 DE AD BE EF 00 11 22 33', 'time,id,data', '1.5,123,DEADBEEF'
  ];
  for (const name of ['candump', 'csv', 'asc']) {
    const parser = F.createParser(name);
    parser.parseLine('time,id,data');
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        for (let c = 32; c < 127; c++) {
          const l = line.slice(0, i) + String.fromCharCode(c) + line.slice(i + 1);
          checkLineResult(parser, l, parser.parseLine(l));
        }
        const cut = line.slice(0, i);
        checkLineResult(parser, cut, parser.parseLine(cut));
      }
    }
  }
});
