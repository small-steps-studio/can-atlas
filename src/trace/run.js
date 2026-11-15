'use strict';
// Reads a trace (a local file in chunks, or text or bytes that are already in memory), splits it
// into lines, reads the lines with the right reader, decodes the frames with a DBC and returns
// the table rows, the statistics and the counters.
//
// Memory does not grow with the size of the trace: lines are processed as they arrive, and only
// the counters, the accumulators of the statistics and at most `maxRows` rows are kept. A line
// longer than 1 MB is counted as bad and dropped without being kept.

const fs = require('node:fs');
const F = require('./formats');
const { createDecoder } = require('./decode');
const { buildStats } = require('./stats');

const CHUNK = 1048576;
const MAX_LINE = 1048576;
const MAX_BAD_KEPT = 100;
const DETECT_LINES = 100;
const NEWLINE = /\r\n|\n|\r/;
const TOO_LONG = '\u0000line longer than 1 MB\u0000';
const TICK_MS = 15;

function tick() { return new Promise(function (resolve) { setImmediate(resolve); }); }

function readError(e) {
  const code = e && e.code ? e.code : 'ERROR';
  const reason = code === 'ENOENT' ? 'the file does not exist' : code === 'EISDIR' ? 'it is a folder, not a file' : code === 'EACCES' || code === 'EPERM' ? 'access was refused' : 'the file could not be read (' + code + ')';
  const err = new Error('The trace file could not be read: ' + reason + '.');
  err.code = code;
  return err;
}

function normaliseOptions(options) {
  const o = options || {};
  const formats = ['auto', 'candump', 'csv', 'asc'];
  return {
    format: formats.indexOf(o.format) !== -1 ? o.format : 'auto',
    channel: typeof o.channel === 'string' && o.channel.trim() ? o.channel.trim() : null,
    filter: o.filter || {},
    maxRows: Number.isFinite(o.maxRows) ? Math.max(0, Math.floor(o.maxRows)) : 100000,
    sink: typeof o.sink === 'function' ? o.sink : null,
    signal: o.signal || null,
    onProgress: typeof o.onProgress === 'function' ? o.onProgress : null,
    chunkSize: Number.isFinite(o.chunkSize) ? Math.max(1, Math.floor(o.chunkSize)) : CHUNK
  };
}

/** Turns bytes into text (UTF-8, or UTF-16 with a byte order mark) without ever failing on bad bytes. */
function createByteFeeder(onText) {
  let dec = null;
  let head = [];
  let headLength = 0;
  function start(bytes) {
    let enc = 'utf-8';
    if (bytes.length >= 2) {
      if (bytes[0] === 0xFF && bytes[1] === 0xFE) enc = 'utf-16le';
      else if (bytes[0] === 0xFE && bytes[1] === 0xFF) enc = 'utf-16be';
    }
    try { dec = new TextDecoder(enc); } catch (e) { dec = new TextDecoder('utf-8'); }
  }
  return {
    push: function (chunk) {
      if (!dec) {
        head.push(Buffer.from(chunk));
        headLength += chunk.length;
        if (headLength < 4) return;
        const all = Buffer.concat(head);
        head = [];
        start(all);
        onText(dec.decode(all, { stream: true }), false);
        return;
      }
      onText(dec.decode(chunk, { stream: true }), false);
    },
    end: function () {
      if (!dec) {
        const all = Buffer.concat(head);
        head = [];
        start(all);
        onText(dec.decode(all), true);
        return;
      }
      onText(dec.decode(), true);
    }
  };
}

function createSession(db, o) {
  const decoder = createDecoder(db, { channel: o.channel, filter: o.filter, maxRows: o.maxRows, sink: o.sink });
  const skipped = new Map();
  const counters = { lines: 0, frames: 0, badLines: 0 };
  const badKept = [];
  const warnings = [];
  const pending = [];
  let parser = null;
  let format = 'unknown';
  let decided = false;
  let tail = '';
  let discarding = false;
  let started = false;
  let firstAll = -1;
  let lastAll = -1;

  function skip(reason) { skipped.set(reason, (skipped.get(reason) || 0) + 1); }
  function bad(no, reason, line) {
    counters.badLines++;
    if (badKept.length < MAX_BAD_KEPT) badKept.push({ line: no, reason: reason, text: line.length > 120 ? line.slice(0, 120) + '…' : line });
  }

  function handle(line) {
    const no = ++counters.lines;
    if (line === TOO_LONG) { bad(no, 'the line is longer than 1 MB and was dropped', ''); return; }
    if (line.length > MAX_LINE) { bad(no, 'the line is longer than 1 MB', line); return; }
    if (parser === null) {
      for (let i = 0; i < line.length; i++) {
        if (line.charCodeAt(i) > 32) { bad(no, 'the layout of the trace was not recognised (expected candump -L lines, a CSV with the columns time, id and data, or ASCII log message lines)', line); return; }
      }
      skip('blank line');
      return;
    }
    const code = parser.parseLine(line);
    if (code === F.FRAME) {
      counters.frames++;
      const rec = parser.rec;
      if (firstAll < 0 || rec.timeUs < firstAll) firstAll = rec.timeUs;
      if (rec.timeUs > lastAll) lastAll = rec.timeUs;
      decoder.frame(rec);
    } else if (code === F.SKIP) skip(parser.reason);
    else bad(no, parser.reason, line);
  }

  function decide(final) {
    if (decided) return;
    if (!final && pending.length < DETECT_LINES) return;
    const fmt = o.format === 'auto' ? F.detectFormat(pending.slice(0, DETECT_LINES)) : o.format;
    parser = fmt ? F.createParser(fmt) : null;
    format = parser ? fmt : 'unknown';
    decided = true;
    for (let i = 0; i < pending.length; i++) handle(pending[i]);
    pending.length = 0;
  }

  function addLines(lines, final) {
    if (!decided) {
      for (let i = 0; i < lines.length; i++) pending.push(lines[i]);
      decide(final);
      return;
    }
    for (let i = 0; i < lines.length; i++) handle(lines[i]);
  }

  function feedText(text, final) {
    if (!started && text.length) {
      started = true;
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    }
    let t = tail + text;
    tail = '';
    if (discarding) {
      const m = /[\r\n]/.exec(t);
      if (!m) { if (final) addLines([], true); return; }
      let k = m.index;
      if (t.charCodeAt(k) === 13 && t.charCodeAt(k + 1) === 10) k++;
      t = t.slice(k + 1);
      discarding = false;
    }
    let held = false;
    if (!final && t.length && t.charCodeAt(t.length - 1) === 13) { held = true; t = t.slice(0, -1); }
    const lines = t.split(NEWLINE);
    let last = lines.pop();
    if (final) {
      if (last !== '') lines.push(last);
      last = '';
    } else if (last.length > MAX_LINE) {
      lines.push(TOO_LONG);
      last = '';
      discarding = true;
    } else if (held) last += '\r';
    tail = last;
    addLines(lines, final);
  }

  function finish(cancelled) {
    if (!cancelled) decide(true);
    else if (!decided) decide(true);
    if (decided && parser && parser.format === 'csv' && !parser.header) warnings.push('No header row with the columns time, id and data was found in the CSV trace.');
    if (counters.lines === 0) warnings.push('The trace is empty.');
    else if (format === 'unknown') warnings.push('The layout of the trace was not recognised, so no frame was read.');
    const fin = decoder.finish();
    const byReason = {};
    let total = 0;
    for (const [reason, count] of skipped) { byReason[reason] = count; total += count; }
    const stats = buildStats(fin);
    return {
      format: format,
      counters: Object.assign({ lines: counters.lines, frames: counters.frames, badLines: counters.badLines, skippedLines: { total: total, byReason: byReason } }, fin.counters),
      rows: fin.rows, truncated: fin.truncated, totalMatching: fin.totalMatching, stats: stats, unknownIds: fin.unknownIds, badLines: badKept, warnings: warnings,
      firstTimeUs: firstAll, lastTimeUs: lastAll
    };
  }

  return { feedText: feedText, finish: finish };
}

/**
 * Decodes a trace with a database.
 *   source  { kind: 'file', path } | { kind: 'text', text } | { kind: 'bytes', bytes }
 *   db      the result of parseDbc()
 *   options { format ('auto' | 'candump' | 'csv' | 'asc'), channel, filter { text, ids, messages, fromUs, toUs },
 *             maxRows, sink(row), signal (AbortSignal), onProgress(fraction, bytesRead) }
 * Resolves to { format, bytesRead, counters, rows, truncated, totalMatching, stats, unknownIds,
 * badLines, warnings, firstTimeUs, lastTimeUs, cancelled }. Rejects only when a file cannot be read.
 */
async function decodeTrace(source, db, options) {
  const o = normaliseOptions(options);
  if (!source || typeof source !== 'object') throw new TypeError('decodeTrace needs a source');
  const session = createSession(db, o);
  let bytesRead = 0;
  let total = 0;
  let cancelled = false;
  let lastReport = 0;
  let lastTick = Date.now();
  function aborted() { return !!(o.signal && o.signal.aborted); }
  function report(force) {
    if (!o.onProgress) return;
    const now = Date.now();
    if (!force && now - lastReport < 100) return;
    lastReport = now;
    try { o.onProgress(total > 0 ? Math.min(1, bytesRead / total) : 0, bytesRead); } catch (e) { /* a failing observer must not stop the decoding */ }
  }
  async function pause() {
    const now = Date.now();
    if (now - lastTick >= TICK_MS) { await tick(); lastTick = Date.now(); }
  }

  if (source.kind === 'file') {
    let fh;
    try {
      fh = await fs.promises.open(String(source.path), 'r');
      total = (await fh.stat()).size;
    } catch (e) {
      if (fh) { try { await fh.close(); } catch (e2) { /* nothing to close */ } }
      throw readError(e);
    }
    try {
      const feeder = createByteFeeder(session.feedText);
      const buf = Buffer.allocUnsafe(o.chunkSize);
      for (;;) {
        if (aborted()) { cancelled = true; break; }
        const r = await fh.read(buf, 0, buf.length, null);
        if (r.bytesRead === 0) break;
        bytesRead += r.bytesRead;
        feeder.push(buf.subarray(0, r.bytesRead));
        report(false);
        await pause();
      }
      if (!cancelled) feeder.end();
    } catch (e) {
      throw readError(e);
    } finally {
      try { await fh.close(); } catch (e) { /* already closed */ }
    }
  } else if (source.kind === 'bytes') {
    const bytes = source.bytes instanceof Uint8Array ? source.bytes : new Uint8Array(0);
    total = bytes.length;
    const feeder = createByteFeeder(session.feedText);
    for (let i = 0; i < bytes.length; i += o.chunkSize) {
      if (aborted()) { cancelled = true; break; }
      const part = bytes.subarray(i, Math.min(bytes.length, i + o.chunkSize));
      bytesRead += part.length;
      feeder.push(part);
      report(false);
      await pause();
    }
    if (!cancelled) feeder.end();
  } else if (source.kind === 'text') {
    const text = typeof source.text === 'string' ? source.text : '';
    total = Buffer.byteLength(text, 'utf8');
    for (let i = 0; i < text.length; i += o.chunkSize) {
      if (aborted()) { cancelled = true; break; }
      const part = text.slice(i, i + o.chunkSize);
      bytesRead += Buffer.byteLength(part, 'utf8');
      session.feedText(part, false);
      report(false);
      await pause();
    }
    if (!cancelled) session.feedText('', true);
  } else throw new TypeError('the source kind must be file, text or bytes');

  report(true);
  const result = session.finish(cancelled);
  result.bytesRead = bytesRead;
  result.cancelled = cancelled;
  return result;
}

module.exports = { decodeTrace: decodeTrace, createByteFeeder: createByteFeeder, MAX_LINE: MAX_LINE, CHUNK: CHUNK };
