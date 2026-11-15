'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const v8 = require('node:v8');
const vm = require('node:vm');
const { parseDbc } = require('../src/dbc/parse');
const { decodeTrace } = require('../src/trace/run');
const X = require('../src/trace/export');
const H = require('./helpers/trace-util');

// A message with eight signals (Intel and Motorola, signed, scaled) for the speed and memory checks.
const BENCH_DBC = [
  'VERSION ""', '', 'NS_ :', '', 'BS_:', '', 'BU_: N', '',
  'BO_ 16 Bench: 8 N',
  ' SG_ a : 0|16@1+ (0.25,0) [0|0] "rpm" N',
  ' SG_ b : 16|8@1+ (1,-40) [0|0] "degC" N',
  ' SG_ c : 24|12@1- (0.5,0) [0|0] "Nm" N',
  ' SG_ d : 36|4@1+ (1,0) [0|0] "" N',
  ' SG_ e : 47|8@0+ (0.4,0) [0|0] "%" N',
  ' SG_ f : 55|1@0+ (1,0) [0|0] "" N',
  ' SG_ g : 54|6@0+ (1,0) [0|0] "" N',
  ' SG_ h : 56|8@1+ (1,0) [0|0] "" N',
  'BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;',
  'BA_DEF_DEF_ "GenMsgCycleTime" 0;',
  'BA_ "GenMsgCycleTime" BO_ 16 1;',
  ''
].join('\n');

function getGc() {
  try {
    v8.setFlagsFromString('--expose-gc');
    return vm.runInNewContext('gc');
  } catch (e) {
    return function () {};
  }
}

/** Writes a candump file of about `bytes` bytes (one frame per millisecond) and returns the number of frames. */
function writeTrace(file, bytes) {
  const rnd = H.mulberry32(99);
  const pool = [];
  for (let i = 0; i < 4096; i++) {
    let hex = '';
    for (let k = 0; k < 8; k++) hex += (0x100 + Math.floor(rnd() * 256)).toString(16).slice(1).toUpperCase();
    pool.push(hex);
  }
  const fd = fs.openSync(file, 'w');
  let frames = 0;
  let written = 0;
  const base = 1762944000;
  try {
    while (written < bytes) {
      const parts = [];
      for (let i = 0; i < 20000 && written < bytes; i++) {
        const us = frames * 1000;
        const sec = base + Math.floor(us / 1000000);
        const frac = String(us % 1000000).padStart(6, '0');
        const line = '(' + sec + '.' + frac + ') can0 010#' + pool[frames & 4095] + '\n';
        parts.push(line);
        written += line.length;
        frames++;
      }
      fs.writeSync(fd, parts.join(''));
    }
  } finally {
    fs.closeSync(fd);
  }
  return frames;
}

async function measure(t, label, file, frames) {
  const db = parseDbc(BENCH_DBC);
  const gc = getGc();
  gc();
  const baseline = process.memoryUsage().heapUsed;
  let peak = baseline;
  const started = process.hrtime.bigint();
  const res = await decodeTrace({ kind: 'file', path: file }, db, {
    maxRows: 1000,
    onProgress: () => { const h = process.memoryUsage().heapUsed; if (h > peak) peak = h; }
  });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const h = process.memoryUsage().heapUsed;
  if (h > peak) peak = h;
  gc();
  const growthMb = Math.round((peak - baseline) / 1048576);
  const rate = Math.round(frames / seconds);
  t.diagnostic(label + ': ' + frames + ' frames (' + Math.round(fs.statSync(file).size / 1048576) + ' MB) in ' + seconds.toFixed(1) + ' s = ' + rate + ' frames/s with 8 signals each; peak heap growth ' + growthMb + ' MB; rss ' + Math.round(process.memoryUsage().rss / 1048576) + ' MB');
  return { res: res, seconds: seconds, rate: rate, growthMb: growthMb };
}

test('a trace of about 60 MB is decoded in a stream: all frames counted, memory stays bounded', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can atlas große Datei '));
  try {
    const file = path.join(dir, 'large ü.log');
    const frames = writeTrace(file, 60 * 1048576);
    const m = await measure(t, '60 MB', file, frames);
    assert.equal(m.res.counters.frames, frames);
    assert.equal(m.res.counters.decodedFrames, frames);
    assert.equal(m.res.counters.badLines, 0);
    assert.equal(m.res.totalMatching, frames * 8);
    assert.equal(m.res.rows.length, 1000);
    assert.equal(m.res.truncated, true);
    const s = m.res.stats.messages[0];
    assert.equal(s.frames, frames);
    assert.equal(s.intervals, frames - 1);
    assert.equal(s.meanPeriodUs, 1000);
    assert.equal(s.stdDevPeriodUs, 0);
    assert.equal(s.verdict, 'within 50 percent of the cycle time for every frame');
    assert.ok(m.res.stats.signals.every((x) => x.count === frames));
    assert.ok(m.growthMb < 300, 'heap growth ' + m.growthMb + ' MB');
    assert.ok(m.rate > 25000, 'frames per second: ' + m.rate);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a trace of 500 MB (only when CAN_ATLAS_BIG_TRACE=1)', { skip: process.env.CAN_ATLAS_BIG_TRACE === '1' ? false : 'set CAN_ATLAS_BIG_TRACE=1 to run' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can atlas big '));
  try {
    const file = path.join(dir, 'big.log');
    const frames = writeTrace(file, 500 * 1048576);
    const m = await measure(t, '500 MB', file, frames);
    assert.equal(m.res.counters.frames, frames);
    assert.equal(m.res.totalMatching, frames * 8);
    assert.ok(m.growthMb < 300, 'heap growth ' + m.growthMb + ' MB');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('streaming a large trace into a CSV file writes every row and keeps no rows in memory', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can atlas export groß '));
  try {
    const file = path.join(dir, 'in.log');
    const frames = writeTrace(file, 6 * 1048576);
    const out = path.join(dir, 'out.csv');
    const fd = fs.openSync(out, 'w');
    const w = X.createCsvWriter((s) => fs.writeSync(fd, s));
    w.begin();
    const started = Date.now();
    const res = await decodeTrace({ kind: 'file', path: file }, parseDbc(BENCH_DBC), { maxRows: 0, sink: (r) => w.row(r) });
    w.end();
    fs.closeSync(fd);
    const seconds = (Date.now() - started) / 1000;
    t.diagnostic('CSV export: ' + frames + ' frames, ' + frames * 8 + ' rows, ' + Math.round(fs.statSync(out).size / 1048576) + ' MB in ' + seconds.toFixed(1) + ' s = ' + Math.round(frames * 8 / seconds) + ' rows/s');
    assert.equal(res.rows.length, 0);
    assert.equal(res.totalMatching, frames * 8);
    const text = fs.readFileSync(out, 'latin1');
    let count = 0;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count++;
    assert.equal(count, frames * 8 + 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an ordinary trace of 100,000 frames is decoded in well under 5 seconds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can atlas mittel '));
  try {
    const file = path.join(dir, 'mid.log');
    const frames = writeTrace(file, 100000 * 46);
    const started = Date.now();
    const res = await decodeTrace({ kind: 'file', path: file }, parseDbc(BENCH_DBC), {});
    assert.ok(Date.now() - started < 5000, 'took ' + (Date.now() - started) + ' ms');
    assert.equal(res.counters.frames, frames);
    assert.equal(res.rows.length, Math.min(frames * 8, 100000));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('long lines and unlucky patterns cannot make the readers slow', async () => {
  const db = H.loadSampleDb();
  const started = Date.now();
  const nasty = [
    '(' + ' '.repeat(900000) + ')', ' '.repeat(900000) + 'x', '0.1 ' + '1 '.repeat(450000), 'time,id,data\n' + '1,1,'.repeat(200000), '"' + ',"'.repeat(300000),
    '(1.0) can0 ' + '1'.repeat(900000) + '#00', 'base hex\n' + '0.1 1 123 Rx d 8 ' + '00 '.repeat(250000)
  ];
  for (const text of nasty) {
    const res = await decodeTrace({ kind: 'text', text: text }, db, {});
    assert.ok(res.counters.lines >= 1);
  }
  assert.ok(Date.now() - started < 3000, 'took ' + (Date.now() - started) + ' ms');
});
