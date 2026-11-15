'use strict';
// Line readers for the three trace layouts that Decode Trace understands, and the detection of the
// layout from the first lines of a file.
//
//   candump -L style   (1762944000.000100) can0 123#DEADBEEF        extended: 18FF50E5#...   FD: 123##1DEADBEEF
//   CSV                a header row with the columns time, id and data (more columns optional)
//   simple ASCII log   "   0.015000 1  123  Rx   d 8 DE AD BE EF 00 11 22 33"
//
// Every reader works on one line at a time, keeps no reference to the line, never throws, and
// reports one of three outcomes: FRAME (the record is filled in), SKIP (a line that is not a data
// frame and is not an error: blank lines, comments, headers, remote frames, events) or BAD (a
// line that should have been a frame and could not be read; the reason is in `parser.reason`).
// Times are whole microseconds: the decimal text is read exactly, a seventh decimal digit of 5 or
// more rounds up, and further digits are ignored.

const FRAME = 0;
const SKIP = 1;
const BAD = 2;

const MAX_DATA = 64;
const MAX_FRAME_LINE = 4096;
const MAX_SECONDS = 9007199253;

// The data lengths a CAN FD frame can carry.
const FD_LENGTHS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64]);
const FD_LENGTHS_TEXT = '0 to 8, 12, 16, 20, 24, 32, 48 or 64';

const HEXV = new Int8Array(256).fill(-1);
for (let i = 0; i < 10; i++) HEXV[48 + i] = i;
for (let i = 0; i < 6; i++) { HEXV[65 + i] = 10 + i; HEXV[97 + i] = 10 + i; }

function newRecord() {
  return { timeUs: 0, channel: '', id: 0, extended: false, fd: false, len: 0, data: new Uint8Array(MAX_DATA) };
}

/** Whole microseconds of a decimal number of seconds ("12", "0.015", ".5"), or -1 when it is not one. */
function parseTimeUs(text) {
  const n = text.length;
  let i = 0;
  let end = n;
  while (i < end && text.charCodeAt(i) <= 32) i++;
  while (end > i && text.charCodeAt(end - 1) <= 32) end--;
  if (i >= end) return -1;
  let whole = 0;
  let digits = 0;
  while (i < end) {
    const c = text.charCodeAt(i);
    if (c < 48 || c > 57) break;
    whole = whole * 10 + (c - 48);
    if (++digits > 10) return -1;
    i++;
  }
  let frac = 0;
  let fracDigits = 0;
  let round = 0;
  if (i < end && text.charCodeAt(i) === 46) {
    i++;
    let seen = 0;
    while (i < end) {
      const c = text.charCodeAt(i);
      if (c < 48 || c > 57) return -1;
      seen++;
      if (fracDigits < 6) { frac = frac * 10 + (c - 48); fracDigits++; } else if (fracDigits === 6 && seen === 7) { round = c >= 53 ? 1 : 0; }
      i++;
    }
    digits += seen;
  }
  if (i < end || digits === 0) return -1;
  while (fracDigits < 6) { frac *= 10; fracDigits++; }
  if (whole > MAX_SECONDS) return -1;
  return whole * 1000000 + frac + round;
}

/** Seconds with six decimals for whole microseconds, for example 12.000005. */
function formatTimeUs(us) {
  if (typeof us !== 'number' || !isFinite(us)) return '';
  const negative = us < 0;
  const a = Math.abs(Math.round(us));
  const s = Math.floor(a / 1000000);
  const f = a - s * 1000000;
  return (negative ? '-' : '') + s + '.' + String(f).padStart(6, '0');
}

/**
 * Reads hex digit pairs from text[start, end) into out (a Uint8Array). Dots, spaces, dashes and
 * colons between pairs are ignored. Returns the number of bytes, or -1 when a character is not a
 * hex digit, the count of digits is odd, or more than `max` bytes would be written.
 */
function hexToBytes(text, start, end, out, max) {
  let n = 0;
  let high = -1;
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === 46 || c === 32 || c === 9 || c === 45 || c === 58) {
      if (high !== -1) return -1;
      continue;
    }
    const v = c < 256 ? HEXV[c] : -1;
    if (v < 0) return -1;
    if (high === -1) high = v;
    else {
      if (n >= max) return -1;
      out[n++] = high * 16 + v;
      high = -1;
    }
  }
  return high === -1 ? n : -1;
}

/** The value of hex digits in text[start, end), or -1 (also when it needs more than 32 bits). */
function hexValue(text, start, end) {
  if (start >= end || end - start > 8) return -1;
  let v = 0;
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    const d = c < 256 ? HEXV[c] : -1;
    if (d < 0) return -1;
    v = v * 16 + d;
  }
  return v;
}

function decValue(text, start, end) {
  if (start >= end || end - start > 10) return -1;
  let v = 0;
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c < 48 || c > 57) return -1;
    v = v * 10 + (c - 48);
  }
  return v;
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) if (line.charCodeAt(i) > 32) return false;
  return true;
}

// ---- candump -L ---------------------------------------------------------------------------------

function createCandumpParser() {
  const rec = newRecord();
  const parser = { format: 'candump', rec: rec, reason: '' };
  function skip(reason) { parser.reason = reason; return SKIP; }
  function bad(reason) { parser.reason = reason; return BAD; }
  parser.parseLine = function (line) {
    const n = line.length;
    if (n > MAX_FRAME_LINE) return bad('the line is longer than ' + MAX_FRAME_LINE + ' characters');
    let i = 0;
    while (i < n && line.charCodeAt(i) <= 32) i++;
    if (i === n) return skip('blank line');
    const c0 = line.charCodeAt(i);
    if (c0 !== 40) return (c0 === 35 || c0 === 59) ? skip('comment line') : bad('not a candump line; expected "(seconds) interface ID#DATA"');
    const close = line.indexOf(')', i + 1);
    if (close < 0) return bad('the time has no closing ")"');
    const t = parseTimeUs(line.slice(i + 1, close));
    if (t < 0) return bad('the time is not a number of seconds');
    i = close + 1;
    while (i < n && line.charCodeAt(i) <= 32) i++;
    let s = i;
    while (i < n && line.charCodeAt(i) > 32) i++;
    if (i === s) return bad('the interface name is missing');
    const channel = line.slice(s, i);
    while (i < n && line.charCodeAt(i) <= 32) i++;
    s = i;
    while (i < n && line.charCodeAt(i) > 32) i++;
    if (i === s) return bad('the frame (ID#DATA) is missing');
    const e = i;
    let hash = -1;
    for (let k = s; k < e; k++) if (line.charCodeAt(k) === 35) { hash = k; break; }
    if (hash < 0) return bad('the frame has no "#" between the ID and the data');
    const idLen = hash - s;
    let extended;
    if (idLen === 3) extended = false;
    else if (idLen === 8) extended = true;
    else return bad('the ID must have 3 hex digits (standard) or 8 (extended)');
    const id = hexValue(line, s, hash);
    if (id < 0) return bad('the ID is not a hex number');
    if (!extended && id > 0x7FF) return bad('a 3-digit ID cannot be larger than 7FF');
    // candump -e writes an error frame with the error flag (bit 29) set in the 8-digit ID; it is a report of the bus, not data.
    if (extended && id >= 0x20000000 && id <= 0x3FFFFFFF) return skip('error frame');
    if (extended && id > 0x1FFFFFFF) return bad('an extended ID cannot be larger than 1FFFFFFF');
    let d = hash + 1;
    let fd = false;
    if (d < e && line.charCodeAt(d) === 35) { fd = true; d++; }
    if (d < e && !fd) {
      const r = line.charCodeAt(d);
      if (r === 82 || r === 114) return skip('remote frame');
    }
    if (fd) {
      if (d >= e) return bad('an FD frame needs a flags digit after "##"');
      const f = line.charCodeAt(d);
      if ((f < 256 ? HEXV[f] : -1) < 0) return bad('the flags digit after "##" is not a hex digit');
      d++;
    }
    const len = hexToBytes(line, d, e, rec.data, fd ? MAX_DATA : 8);
    if (len < 0) return bad(fd ? 'the data is not 0 to 64 bytes of hex digit pairs' : 'the data is not 0 to 8 bytes of hex digit pairs');
    if (fd && !FD_LENGTHS.has(len)) return bad('a CAN FD frame carries ' + FD_LENGTHS_TEXT + ' data bytes, not ' + len);
    rec.timeUs = t;
    rec.channel = channel;
    rec.id = id;
    rec.extended = extended;
    rec.fd = fd;
    rec.len = len;
    return FRAME;
  };
  return parser;
}

// ---- CSV ----------------------------------------------------------------------------------------

const COLUMN_NAMES = Object.assign(Object.create(null), {
  time: 'time', timestamp: 'time',
  id: 'id', can_id: 'id', canid: 'id', identifier: 'id',
  data: 'data', payload: 'data',
  channel: 'channel', chn: 'channel', bus: 'channel', interface: 'channel',
  dlc: 'dlc', length: 'dlc',
  extended: 'extended', ide: 'extended', is_extended: 'extended',
  id_format: 'idFormat', idformat: 'idFormat'
});

/** Splits one CSV line; a quoted cell may hold the delimiter and doubled quotes. null when a quote is not closed. */
function splitCsvLine(line, delimiter) {
  if (line.indexOf('"') < 0) return line.split(delimiter);
  const cells = [];
  let cell = '';
  let i = 0;
  const n = line.length;
  while (i <= n) {
    if (i === n) { cells.push(cell); break; }
    const c = line[i];
    if (c === '"' && cell === '') {
      i++;
      for (;;) {
        if (i >= n) return null;
        if (line[i] === '"') {
          if (line[i + 1] === '"') { cell += '"'; i += 2; continue; }
          i++;
          break;
        }
        cell += line[i++];
      }
      continue;
    }
    if (c === delimiter) { cells.push(cell); cell = ''; i++; continue; }
    cell += c;
    i++;
  }
  return cells;
}

/** { delimiter, columns } when the line is a header row with time, id and data columns, otherwise null. */
function parseCsvHeader(line) {
  if (line.length > MAX_FRAME_LINE) return null;
  let best = null;
  for (const delimiter of [',', ';', '\t']) {
    if (line.indexOf(delimiter) < 0) continue;
    const cells = splitCsvLine(line, delimiter);
    if (!cells) continue;
    const columns = {};
    for (let k = 0; k < cells.length; k++) {
      const name = COLUMN_NAMES[cells[k].trim().toLowerCase().replace(/^﻿/, '').replace(/[\s-]+/g, '_')];
      if (name && columns[name] === undefined) columns[name] = k;
    }
    if (columns.time !== undefined && columns.id !== undefined && columns.data !== undefined && (!best || cells.length > best.cells)) best = { delimiter: delimiter, columns: columns, cells: cells.length };
  }
  return best ? { delimiter: best.delimiter, columns: best.columns } : null;
}

function createCsvParser() {
  const rec = newRecord();
  const parser = { format: 'csv', rec: rec, reason: '', header: null };
  function skip(reason) { parser.reason = reason; return SKIP; }
  function bad(reason) { parser.reason = reason; return BAD; }
  function flag(text) {
    const t = text.trim().toLowerCase();
    if (t === '1' || t === 'true' || t === 'yes' || t === 'x' || t === 'ext' || t === 'extended') return 1;
    if (t === '0' || t === 'false' || t === 'no' || t === 'std' || t === 'standard') return 0;
    return -1;
  }
  parser.parseLine = function (line) {
    if (isBlank(line)) return skip('blank line');
    if (line.length > MAX_FRAME_LINE) return bad('the line is longer than ' + MAX_FRAME_LINE + ' characters');
    if (!parser.header) {
      const h = parseCsvHeader(line);
      if (h) { parser.header = h; return skip('header row'); }
      const first = line.trimStart().charCodeAt(0);
      return first === 35 ? skip('comment line') : skip('line before the header row');
    }
    const first = line.trimStart().charCodeAt(0);
    if (first === 35) return skip('comment line');
    const cols = parser.header.columns;
    const cells = splitCsvLine(line, parser.header.delimiter);
    if (!cells) return bad('a quoted cell is not closed');
    const timeText = cells[cols.time];
    const idText = cells[cols.id];
    const dataText = cells[cols.data];
    if (timeText === undefined || idText === undefined || dataText === undefined) return bad('the row has fewer cells than the header row');
    const t = parseTimeUs(timeText);
    if (t < 0) return bad('the time is not a number of seconds');
    let s = idText.trim();
    if (!s) return bad('the ID is empty');
    let hex = true;
    if (s.length > 2 && s.charCodeAt(0) === 48 && (s.charCodeAt(1) === 120 || s.charCodeAt(1) === 88)) s = s.slice(2);
    else if (cols.idFormat !== undefined) {
      const f = (cells[cols.idFormat] || '').trim().toLowerCase();
      if (f === 'dec' || f === 'decimal' || f === 'd') hex = false;
    }
    const id = hex ? hexValue(s, 0, s.length) : decValue(s, 0, s.length);
    if (id < 0) return bad(hex ? 'the ID is not a hex number' : 'the ID is not a decimal number');
    if (id > 0x1FFFFFFF) return bad('the ID is larger than 1FFFFFFF (29 bits)');
    let extended = id > 0x7FF;
    if (cols.extended !== undefined) {
      const f = flag(cells[cols.extended] || '');
      if (f === 1) extended = true;
      else if (f === 0) {
        if (id > 0x7FF) return bad('the ID does not fit into 11 bits, but the row says it is a standard frame');
        extended = false;
      }
    }
    let ds = dataText.trim();
    if (ds.length > 2 && ds.charCodeAt(0) === 48 && (ds.charCodeAt(1) === 120 || ds.charCodeAt(1) === 88)) ds = ds.slice(2);
    const len = hexToBytes(ds, 0, ds.length, rec.data, MAX_DATA);
    if (len < 0) return bad('the data is not 0 to 64 bytes of hex digit pairs');
    if (!FD_LENGTHS.has(len)) return bad('a CAN frame carries ' + FD_LENGTHS_TEXT + ' data bytes, not ' + len);
    rec.timeUs = t;
    rec.channel = cols.channel !== undefined ? (cells[cols.channel] || '').trim() : '';
    rec.id = id;
    rec.extended = extended;
    rec.fd = len > 8;
    rec.len = len;
    return FRAME;
  };
  return parser;
}

// ---- simple ASCII log ----------------------------------------------------------------------------

const ASC_HEADER = /^(date|base|internal events logged|no internal events logged|begin triggerblock|end triggerblock)\b/i;
const ASC_BASE = /^base\s+(hex|dec)\b/i;

function createAscParser() {
  const rec = newRecord();
  const parser = { format: 'asc', rec: rec, reason: '', base: 'hex' };
  function skip(reason) { parser.reason = reason; return SKIP; }
  function bad(reason) { parser.reason = reason; return BAD; }
  parser.parseLine = function (line) {
    const n = line.length;
    if (n > MAX_FRAME_LINE) return bad('the line is longer than ' + MAX_FRAME_LINE + ' characters');
    let i = 0;
    while (i < n && line.charCodeAt(i) <= 32) i++;
    if (i === n) return skip('blank line');
    const c0 = line.charCodeAt(i);
    if (!((c0 >= 48 && c0 <= 57) || c0 === 46)) {
      const text = line.slice(i);
      const b = ASC_BASE.exec(text);
      if (b) { parser.base = b[1].toLowerCase(); return skip('header line'); }
      return skip(ASC_HEADER.test(text) || text.startsWith('//') ? 'header or comment line' : 'line that is not a message');
    }
    const tokens = line.slice(i).split(/[ \t]+/);
    const t = parseTimeUs(tokens[0]);
    if (t < 0) return skip('line that is not a message');
    if (tokens.length < 4) return skip('event line (not a classic CAN message)');
    const channel = tokens[1];
    if (channel === 'CANFD') return skip('CANFD line (not read)');
    for (let k = 0; k < channel.length; k++) { const c = channel.charCodeAt(k); if (c < 48 || c > 57) return skip('event line (not a classic CAN message)'); }
    let idToken = tokens[2];
    let extended = false;
    const last = idToken.charCodeAt(idToken.length - 1);
    if (last === 120 || last === 88) { extended = true; idToken = idToken.slice(0, -1); }
    const id = parser.base === 'dec' ? decValue(idToken, 0, idToken.length) : hexValue(idToken, 0, idToken.length);
    if (id < 0) return skip('event line (not a classic CAN message)');
    let dir = 3;
    if (!/^(rx|tx|txrq)$/i.test(tokens[3] || '')) dir = /^(rx|tx|txrq)$/i.test(tokens[4] || '') ? 4 : -1;
    if (dir < 0) return bad('no direction (Rx or Tx) after the ID');
    const kind = (tokens[dir + 1] || '').toLowerCase();
    if (kind === 'r') return skip('remote frame');
    if (kind !== 'd') return bad('expected "d" (data frame) after the direction');
    const dlc = decValue(tokens[dir + 2] || '', 0, (tokens[dir + 2] || '').length);
    if (dlc < 0 || dlc > 8) return bad('the data length must be 0 to 8 for a classic frame');
    if (tokens.length < dir + 3 + dlc) return bad('fewer data bytes than the data length says');
    // The header line "base dec" makes the data bytes decimal as well as the identifier (the same reading as the widely used open-source readers).
    const decimal = parser.base === 'dec';
    for (let k = 0; k < dlc; k++) {
      const tk = tokens[dir + 3 + k];
      let v;
      if (decimal) {
        v = tk.length >= 1 && tk.length <= 3 ? decValue(tk, 0, tk.length) : -1;
        if (v > 255) v = -1;
        if (v < 0) return bad('a data byte is not a decimal number from 0 to 255 (the log says "base dec")');
      } else {
        v = tk.length === 2 ? hexValue(tk, 0, 2) : tk.length === 1 ? hexValue(tk, 0, 1) : -1;
        if (v < 0) return bad('a data byte is not a hex number');
      }
      rec.data[k] = v;
    }
    if (!extended && id > 0x7FF) return bad('an ID above 7FF needs the "x" mark of an extended frame');
    if (extended && id > 0x1FFFFFFF) return bad('an extended ID cannot be larger than 1FFFFFFF');
    rec.timeUs = t;
    rec.channel = channel;
    rec.id = id;
    rec.extended = extended;
    rec.fd = false;
    rec.len = dlc;
    return FRAME;
  };
  return parser;
}

/** A fresh reader for 'candump', 'csv' or 'asc'; null for any other name. */
function createParser(format) {
  if (format === 'candump') return createCandumpParser();
  if (format === 'csv') return createCsvParser();
  if (format === 'asc') return createAscParser();
  return null;
}

/**
 * The layout of a trace from its first lines: 'csv' when one of the first lines is a header row
 * with time, id and data columns, otherwise whichever of 'candump' and 'asc' reads more of the
 * first 100 lines as frames (a tie goes to 'candump'), otherwise null.
 */
function detectFormat(lines) {
  const limit = Math.min(lines.length, 100);
  let seen = 0;
  for (let i = 0; i < limit && seen < 20; i++) {
    if (isBlank(lines[i])) continue;
    seen++;
    if (parseCsvHeader(lines[i])) return 'csv';
  }
  const cd = createCandumpParser();
  const asc = createAscParser();
  let cdFrames = 0;
  let ascFrames = 0;
  let ascHeaders = 0;
  for (let i = 0; i < limit; i++) {
    const line = lines[i];
    if (isBlank(line)) continue;
    if (cd.parseLine(line) === FRAME) cdFrames++;
    if (asc.parseLine(line) === FRAME) ascFrames++;
    else if (ASC_HEADER.test(line.trim())) ascHeaders++;
  }
  if (cdFrames === 0 && ascFrames === 0 && ascHeaders === 0) return null;
  if (cdFrames >= ascFrames && cdFrames > 0) return 'candump';
  return 'asc';
}

module.exports = {
  FRAME: FRAME, SKIP: SKIP, BAD: BAD, MAX_DATA: MAX_DATA, MAX_FRAME_LINE: MAX_FRAME_LINE, parseTimeUs: parseTimeUs, formatTimeUs: formatTimeUs,
  hexToBytes: hexToBytes, splitCsvLine: splitCsvLine, parseCsvHeader: parseCsvHeader, createCandumpParser: createCandumpParser,
  createCsvParser: createCsvParser, createAscParser: createAscParser, createParser: createParser, detectFormat: detectFormat, newRecord: newRecord
};
