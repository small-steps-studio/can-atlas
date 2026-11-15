'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decodeTrace } = require('../src/trace/run');
const H = require('./helpers/trace-util');

const T0 = 1762944000000000;
const db = H.loadSampleDb();

function run(name, options) { return decodeTrace({ kind: 'file', path: H.fixturePath(name) }, db, options || {}); }
function names(rows) { return rows.map((r) => r.messageName + '.' + r.signalName); }
function messages(rows) { return Array.from(new Set(rows.map((r) => r.messageName))); }
function skipped(res, reason) { return res.counters.skippedLines.byReason[reason] || 0; }

function invariants(res, label) {
  const c = res.counters;
  assert.equal(c.lines, c.frames + c.skippedLines.total + c.badLines, label + ': every line is a frame, a skipped line or a bad line');
  assert.equal(c.framesInWindow + c.framesOutsideWindow, c.frames, label + ': window');
  assert.equal(c.decodedFrames + c.unknownFrames, c.framesInWindow, label + ': known and unknown');
  assert.ok(res.badLines.length <= 100 && res.badLines.length <= c.badLines);
  assert.equal(res.totalMatching >= res.rows.length, true);
}

test('candump file with extended identifiers: extended and standard identifiers are different frames', async () => {
  const res = await run('extended-ids.candump.log');
  assert.equal(res.format, 'candump');
  assert.equal(res.counters.lines, 6);
  assert.equal(res.counters.frames, 5);
  assert.equal(res.counters.badLines, 1);
  assert.equal(res.badLines[0].line, 5);
  assert.match(res.badLines[0].reason, /1FFFFFFF/);
  assert.equal(res.counters.decodedFrames, 3);
  assert.deepEqual(res.unknownIds.items.map((u) => u.idText), ['0x00000100', '0x1FFFFFFF']);
  assert.equal(res.rows.length, 14);
  assert.deepEqual(messages(res.rows), ['ChargerStatus', 'EngineStatus']);
  assert.equal(res.rows[0].channel, 'can1');
  invariants(res, 'extended');
});

test('candump file with remote and FD frames', async () => {
  const res = await run('remote-and-fd.candump.log');
  assert.equal(skipped(res, 'remote frame'), 2);
  assert.equal(res.counters.frames, 4);
  assert.equal(res.counters.badLines, 1);
  assert.equal(res.badLines[0].line, 7);
  assert.equal(res.rows.length, 18);
  assert.deepEqual(messages(res.rows), ['EngineStatus', 'GatewayHeartbeat', 'GearStatus']);
  // The 12-byte FD frame is decoded with the first 8 bytes like the 8-byte one.
  const speeds = res.rows.filter((r) => r.signalName === 'EngineSpeed');
  assert.deepEqual(speeds.map((r) => r.rawText), ['8000', '8000']);
  invariants(res, 'remote and fd');
});

test('line endings: CRLF, lone CR, BOM, UTF-16 and a missing final newline give the same rows', async () => {
  const hand = await run('sample-valid.candump.log');
  const firstFour = hand.rows.filter((r) => r.timeUs <= T0 + 10000 && r.messageName !== 'TripComputer');
  for (const name of ['crlf.candump.log', 'lone-cr.candump.log', 'bom.candump.log']) {
    const res = await run(name);
    assert.equal(res.format, 'candump', name);
    assert.equal(res.counters.lines, 4, name);
    assert.equal(res.counters.skippedLines.total, 0, name);
    assert.deepEqual(res.rows, firstFour, name);
    invariants(res, name);
  }
  for (const name of ['no-final-newline.candump.log', 'utf16le.candump.log']) {
    const res = await run(name);
    assert.equal(res.counters.lines, 3, name);
    assert.deepEqual(res.rows, firstFour.filter((r) => r.timeUs < T0 + 10000), name);
  }
});

test('CSV with a semicolon delimiter, a hex id with 0x and a spaced data column', async () => {
  const res = await run('semicolon-hex.csv');
  assert.equal(res.format, 'csv');
  assert.equal(skipped(res, 'header row'), 1);
  assert.equal(res.counters.frames, 4);
  assert.equal(res.rows.length, 16);
  assert.deepEqual(res.rows.map((r) => r.timeUs).filter((t, i, a) => a.indexOf(t) === i), [0, 10000, 20000, 30000]);
  assert.deepEqual(res.rows.filter((r) => r.signalName === 'ChargeVoltage').map((r) => r.physicalText), ['365.6']);
  assert.equal(res.rows.find((r) => r.messageName === 'GearStatus').channel, '2');
  invariants(res, 'semicolon');
});

test('CSV with extra columns, decimal ids, the extended column, a comment line and quoted cells', async () => {
  const res = await run('extra-columns.csv');
  assert.equal(res.format, 'csv');
  assert.equal(skipped(res, 'comment line'), 1);
  assert.equal(res.counters.frames, 5);
  assert.equal(res.counters.badLines, 0);
  assert.deepEqual(res.rows.filter((r, i, a) => i === 0 || a[i - 1].timeUs !== r.timeUs).map((r) => r.messageName + '@' + r.channel), ['EngineStatus@bus-a', 'ChargerStatus@bus-a', 'GearStatus@bus-b', 'GatewayHeartbeat@bus-b', 'EngineStatus@bus-a']);
  assert.equal(res.rows.length, 22);
  assert.equal(res.rows[0].timeUs, 10000000);
  invariants(res, 'extra columns');
});

test('tab-delimited CSV', async () => {
  const res = await run('tab-delimited.csv');
  assert.equal(res.format, 'csv');
  assert.equal(res.rows.length, 10);
  assert.deepEqual(messages(res.rows), ['EngineStatus', 'GearStatus']);
  assert.equal(res.rows[0].timeUs, 5000000);
});

test('ASCII log: headers, events, CANFD and remote lines are skipped and counted', async () => {
  const res = await run('ascii-hex.asc');
  assert.equal(res.format, 'asc');
  assert.equal(res.counters.lines, 15);
  assert.equal(res.counters.frames, 4);
  assert.equal(res.counters.badLines, 0);
  assert.equal(res.counters.skippedLines.total, 11);
  assert.equal(skipped(res, 'header or comment line'), 5);
  assert.equal(skipped(res, 'header line'), 1);
  assert.equal(skipped(res, 'event line (not a classic CAN message)'), 3);
  assert.equal(skipped(res, 'CANFD line (not read)'), 1);
  assert.equal(skipped(res, 'remote frame'), 1);
  assert.equal(res.rows.length, 16);
  assert.deepEqual(res.rows.filter((r, i, a) => i === 0 || a[i - 1].timeUs !== r.timeUs).map((r) => r.messageName + '@' + r.channel), ['EngineStatus@1', 'GearStatus@1', 'ChargerStatus@1', 'GatewayHeartbeat@2']);
  invariants(res, 'asc');
});

test('ASCII log with base dec reads decimal identifiers; an identifier above 7FF without the x mark is a bad line', async () => {
  const res = await run('ascii-base-dec.asc');
  assert.equal(res.format, 'asc');
  assert.equal(res.counters.frames, 3);
  assert.equal(res.counters.badLines, 1);
  assert.equal(res.badLines[0].line, 7);
  assert.deepEqual(messages(res.rows), ['EngineStatus', 'ChargerStatus', 'GatewayHeartbeat']);
  assert.equal(res.rows.length, 12);
});

test('a file with garbage lines: the good lines are decoded, every bad line is listed with its number and reason', async () => {
  const res = await run('mixed-garbage.candump.log');
  assert.equal(res.counters.lines, 19);
  assert.equal(res.counters.frames, 4);
  assert.equal(res.counters.skippedLines.total, 3);
  assert.equal(skipped(res, 'comment line'), 2);
  assert.equal(skipped(res, 'blank line'), 1);
  assert.equal(res.counters.badLines, 12);
  assert.deepEqual(res.badLines.map((b) => b.line), [3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 18]);
  assert.equal(res.badLines[0].text, 'this line is not a frame');
  assert.ok(res.badLines.every((b) => b.reason.length > 10));
  assert.equal(res.rows.length, 14);
  invariants(res, 'garbage');
});

test('an empty file, binary bytes and a layout nobody knows give counters and a warning, never an error', async () => {
  let res = await run('empty.log');
  assert.equal(res.format, 'unknown');
  assert.equal(res.counters.lines, 0);
  assert.deepEqual(res.warnings, ['The trace is empty.']);
  assert.equal(res.bytesRead, 0);
  res = await run('binary-junk.bin');
  assert.equal(res.format, 'unknown');
  assert.equal(res.counters.frames, 0);
  assert.equal(res.bytesRead, 4096);
  assert.ok(res.warnings[0].startsWith('The layout of the trace was not recognised'));
  invariants(res, 'binary');
  res = await decodeTrace({ kind: 'text', text: 'hello\nworld\n' }, db, {});
  assert.equal(res.counters.badLines, 2);
  assert.match(res.badLines[0].reason, /not recognised/);
});

test('a forced layout is used even when the file looks different, and a CSV without a header row warns', async () => {
  let res = await run('sample-valid.candump.log', { format: 'asc' });
  assert.equal(res.format, 'asc');
  assert.equal(res.counters.frames, 0);
  res = await run('sample-valid.candump.log', { format: 'csv' });
  assert.equal(res.format, 'csv');
  assert.equal(res.counters.frames, 0);
  assert.match(res.warnings[0], /No header row/);
  res = await run('mixed-garbage.candump.log', { format: 'candump' });
  assert.equal(res.counters.frames, 4);
  res = await run('mixed-garbage.candump.log', { format: 'nonsense' });
  assert.equal(res.format, 'candump');
});

test('hostile channel names in a CSV are carried as text; an unterminated quote is a bad line', async () => {
  const res = await run('hostile-channel.csv');
  assert.equal(res.counters.frames, 4);
  assert.equal(res.counters.badLines, 1);
  assert.deepEqual(Array.from(new Set(res.rows.map((r) => r.channel))), ['=HYPERLINK("http://example.invalid/x","y")', '+cmd', '-2+3', '@SUM(A1)']);
});

test('every fixture satisfies the counting invariants and gives the same result from a file, bytes and text', async () => {
  const dir = fs.readdirSync(H.FIXTURE_DIR);
  assert.ok(dir.length >= 15, 'fixtures: ' + dir.length);
  for (const name of dir) {
    const fromFile = await run(name);
    invariants(fromFile, name);
    const bytes = H.readFixture(name);
    const fromBytes = await decodeTrace({ kind: 'bytes', bytes: new Uint8Array(bytes) }, db, {});
    assert.deepEqual(fromBytes.rows, fromFile.rows, name);
    assert.deepEqual(fromBytes.counters, fromFile.counters, name);
    assert.equal(fromBytes.bytesRead, bytes.length, name);
  }
});

// ---- chunk boundaries ---------------------------------------------------------------------------
function snapshot(res) {
  return JSON.stringify({ f: res.format, r: res.rows, c: res.counters, b: res.badLines, w: res.warnings, s: res.stats, u: res.unknownIds, t: [res.firstTimeUs, res.lastTimeUs], n: res.bytesRead });
}

test('splitting the input at every position gives the same result (text and bytes, all layouts and line endings)', async () => {
  const multibyte = 'time,channel,id,data\r\n1.0,bü-ß ☃,100,401F72FA8E01103C\r\n2.0,é,120,380BB85F\r\n';
  const inputs = {
    mixed: H.readFixtureText('mixed-garbage.candump.log'), asc: H.readFixtureText('ascii-hex.asc'), csv: H.readFixtureText('extra-columns.csv'),
    crlf: H.readFixtureText('crlf.candump.log'), cr: H.readFixtureText('lone-cr.candump.log'), tab: H.readFixtureText('tab-delimited.csv'), multibyte: multibyte
  };
  for (const [label, text] of Object.entries(inputs)) {
    const baselineText = snapshot(await decodeTrace({ kind: 'text', text: text }, db, {}));
    const buf = Buffer.from(text, 'utf8');
    const baselineBytes = snapshot(await decodeTrace({ kind: 'bytes', bytes: new Uint8Array(buf) }, db, {}));
    assert.equal(baselineText, baselineBytes, label + ': text and bytes');
    for (let k = 1; k <= buf.length; k++) {
      assert.equal(snapshot(await decodeTrace({ kind: 'bytes', bytes: new Uint8Array(buf), chunkSize: k }, db, {})), baselineBytes, label + ': bytes in chunks of ' + k);
      if (k <= text.length) assert.equal(snapshot(await decodeTrace({ kind: 'text', text: text, chunkSize: k }, db, {})), baselineText, label + ': text in chunks of ' + k);
    }
  }
});

test('the multi-byte channel name survives being split between two chunks', async () => {
  const text = 'time,channel,id,data\n1.0,bü-ß ☃,100,401F72FA8E01103C\n';
  const res = await decodeTrace({ kind: 'bytes', bytes: new Uint8Array(Buffer.from(text, 'utf8')), chunkSize: 3 }, db, {});
  assert.equal(res.rows[0].channel, 'bü-ß ☃');
});

test('reading a file in small chunks gives the same result as one chunk', async () => {
  const whole = await run('ascii-hex.asc');
  for (const k of [1, 2, 7, 64, 1000]) assert.equal(snapshot(await run('ascii-hex.asc', { chunkSize: k })), snapshot(whole), 'chunk ' + k);
});

// ---- long lines ---------------------------------------------------------------------------------
test('a line longer than 1 MB is one bad line, wherever the chunks fall, and the lines after it are read', async () => {
  const frame = '(1.0) can0 100#401F72FA8E01103C';
  const long = 'x'.repeat(2500000);
  const text = frame + '\n' + long + '\n' + frame + '\n';
  for (const chunkSize of [1048576, 8 * 1048576, 3000000]) {
    const res = await decodeTrace({ kind: 'text', text: text, chunkSize: chunkSize }, db, {});
    assert.equal(res.counters.frames, 2, 'chunk ' + chunkSize);
    assert.equal(res.counters.badLines, 1, 'chunk ' + chunkSize);
    assert.equal(res.counters.lines, 3, 'chunk ' + chunkSize);
    assert.equal(res.badLines[0].line, 2);
    assert.match(res.badLines[0].reason, /1 MB/);
    assert.ok(res.badLines[0].text.length <= 121);
  }
  const noEnd = await decodeTrace({ kind: 'bytes', bytes: new Uint8Array(Buffer.from(frame + '\n' + long)) }, db, {});
  assert.equal(noEnd.counters.frames, 1);
  assert.equal(noEnd.counters.badLines, 1);
  const all = await decodeTrace({ kind: 'bytes', bytes: new Uint8Array(Buffer.alloc(3 * 1048576, 0x41)) }, db, {});
  assert.equal(all.counters.badLines, 1);
  assert.equal(all.counters.lines, 1);
});

// ---- cancel, progress, errors ----------------------------------------------------------------------
test('an aborted decode stops and reports what was read so far', async () => {
  const ac = new AbortController();
  ac.abort();
  let res = await decodeTrace({ kind: 'text', text: H.readFixtureText('sample-valid.candump.log') }, db, { signal: ac.signal });
  assert.equal(res.cancelled, true);
  assert.equal(res.rows.length, 0);

  const lines = [];
  for (let i = 0; i < 20000; i++) lines.push('(' + (i / 1000).toFixed(6) + ') can0 7F0#21');
  const text = lines.join('\n') + '\n';
  const ac2 = new AbortController();
  res = await decodeTrace({ kind: 'text', text: text }, db, { chunkSize: 4096, signal: ac2.signal, onProgress: () => ac2.abort() });
  assert.equal(res.cancelled, true);
  assert.ok(res.counters.frames > 0 && res.counters.frames < 20000, 'frames read: ' + res.counters.frames);
  assert.ok(res.bytesRead < text.length);

  const ac3 = new AbortController();
  res = await decodeTrace({ kind: 'file', path: H.fixturePath('ascii-hex.asc') }, db, { chunkSize: 16, signal: ac3.signal, onProgress: () => ac3.abort() });
  assert.equal(res.cancelled, true);
});

test('progress is reported as a fraction that ends at 1, and a failing observer does not stop the decode', async () => {
  const seen = [];
  const res = await decodeTrace({ kind: 'file', path: H.fixturePath('sample-valid.candump.log') }, db, { chunkSize: 100, onProgress: (f, b) => { seen.push([f, b]); throw new Error('observer failure'); } });
  assert.equal(res.rows.length, 49);
  assert.ok(seen.length >= 2);
  assert.deepEqual(seen[seen.length - 1], [1, H.readFixture('sample-valid.candump.log').length]);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i][0] >= seen[i - 1][0]);
});

test('a file that cannot be read is an error with a plain message; a wrong source is a type error', async () => {
  await assert.rejects(decodeTrace({ kind: 'file', path: path.join(os.tmpdir(), 'no such trace file.log') }, db, {}), (e) => e.code === 'ENOENT' && /does not exist/.test(e.message) && !/at /.test(e.message));
  await assert.rejects(decodeTrace({ kind: 'file', path: os.tmpdir() }, db, {}), (e) => /folder|could not be read/.test(e.message));
  await assert.rejects(decodeTrace({ kind: 'socket' }, db, {}), TypeError);
  await assert.rejects(decodeTrace(null, db, {}), TypeError);
});

test('a path with spaces and non-ASCII characters works', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can atlas prüfung ☃ '));
  try {
    const target = path.join(dir, 'trace üé 1.log');
    fs.copyFileSync(H.fixturePath('sample-valid.candump.log'), target);
    const res = await decodeTrace({ kind: 'file', path: target }, db, {});
    assert.equal(res.rows.length, 49);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('UTF-16 text in both byte orders is read', async () => {
  const text = '(1.0) can0 7F0#21\r\n(2.0) can0 7F0#00\r\n';
  const le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
  const be = Buffer.from(le);
  be[0] = 0xFE;
  be[1] = 0xFF;
  for (let i = 2; i + 1 < be.length; i += 2) { const t = be[i]; be[i] = be[i + 1]; be[i + 1] = t; }
  for (const bytes of [le, be]) {
    for (const chunkSize of [1, 5, 1000]) {
      const res = await decodeTrace({ kind: 'bytes', bytes: new Uint8Array(bytes), chunkSize: chunkSize }, db, {});
      assert.equal(res.counters.frames, 2, 'chunk ' + chunkSize);
      assert.deepEqual(res.rows.map((r) => r.rawText), ['1', '2', '0', '0']);
    }
  }
});

test('two decodes at the same time with the same database do not disturb each other', async () => {
  const one = await run('sample-valid.candump.log');
  const [a, b, c] = await Promise.all([run('sample-valid.candump.log', { chunkSize: 7 }), run('sample-valid.candump.log', { filter: { text: 'speed' } }), run('sample-valid.candump.log', { chunkSize: 100 })]);
  assert.deepEqual(a.rows, one.rows);
  assert.deepEqual(c.rows, one.rows);
  assert.deepEqual(a.stats, one.stats);
  assert.equal(b.rows.length, 8);
  assert.deepEqual(b.stats, one.stats);
});

test('timestamps that go backwards are counted and do not produce negative periods', async () => {
  const text = '(10.000000) can0 7F0#00\n(10.500000) can0 7F0#00\n(10.200000) can0 7F0#00\n(10.700000) can0 7F0#00\n';
  const res = await decodeTrace({ kind: 'text', text: text }, db, {});
  assert.equal(res.counters.timeBackwards, 1);
  const m = res.stats.messages[0];
  assert.equal(m.intervals, 2);
  assert.equal(m.minPeriodUs, 500000);
  assert.equal(m.maxPeriodUs, 500000);
});
