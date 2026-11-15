'use strict';
// Exports of a decoded trace: the rows as CSV or JSON written piece by piece (so that a trace of
// any size can be exported without holding it in memory), and the statistics as Markdown, HTML
// and CSV.
//
// Columns of the row exports: time (seconds, six decimals), channel, message, id, signal, raw,
// physical, unit, description. Raw and physical values are exact decimal strings in both formats.
// CSV cells that a spreadsheet could run as a formula are neutralised (see ../util); JSON is data
// and is written as it is.

const U = require('../util');
const F = require('./formats');

const COLUMNS = ['time', 'channel', 'message', 'id', 'signal', 'raw', 'physical', 'unit', 'description'];
const FLUSH_AT = 65536;
const SPECIAL = /[",\r\n]/;

/** The export record of a row: the nine columns as strings. */
function recordOf(row) {
  return {
    time: F.formatTimeUs(row.timeUs), channel: row.channel, message: row.messageName, id: row.idText, signal: row.signalName,
    raw: row.rawText, physical: row.physicalText, unit: row.unit, description: row.valueText
  };
}

// A string made only of digits, one optional minus sign and one decimal point: written as it is in
// both formats. (The decoder produces raw and physical values in exactly this shape; NaN and
// Infinity from float signals are letters and take the slow path.)
function isPlainNumber(s) {
  const n = s.length;
  if (n === 0 || n > 40) return false;
  let i = 0;
  if (s.charCodeAt(0) === 45) i = 1;
  if (i >= n) return false;
  let dots = 0;
  for (; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 46) { if (++dots > 1 || i === 0 || i === n - 1) return false; } else if (c < 48 || c > 57) return false;
  }
  return true;
}

function fastCell(s, neutralise) {
  if (s === '') return '';
  const c = s.charCodeAt(0);
  if (((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) && !SPECIAL.test(s)) return s;
  return U.csvCell(s, neutralise);
}

/** A cache for the cells of text that repeats (names, units, descriptions): cleared when it gets large. */
function memo(make) {
  const map = new Map();
  return function (s) {
    let v = map.get(s);
    if (v === undefined) {
      if (map.size >= 5000) map.clear();
      v = make(s);
      map.set(s, v);
    }
    return v;
  };
}

function createBuffer(write) {
  let buf = '';
  return {
    put: function (s) { buf += s; if (buf.length >= FLUSH_AT) { write(buf); buf = ''; } },
    flush: function () { if (buf) { write(buf); buf = ''; } }
  };
}

/**
 * The fields of a row as text cells, with the cells of the values that repeat from row to row
 * (time, channel, message, identifier, names, units, descriptions) kept, so that a trace with
 * millions of rows does not format the same text again and again.
 */
function createCellSource(cellOf) {
  const text = memo(cellOf);
  let lastTime = -1;
  let timeText = '';
  let lastChannel = null;
  let channelCell = '';
  let lastMessage = null;
  let messageCell = '';
  let lastId = null;
  let idCell = '';
  return function (r) {
    if (r.timeUs !== lastTime) { lastTime = r.timeUs; timeText = F.formatTimeUs(lastTime); }
    if (r.channel !== lastChannel) { lastChannel = r.channel; channelCell = text(lastChannel); }
    if (r.messageName !== lastMessage) { lastMessage = r.messageName; messageCell = text(lastMessage); }
    if (r.idText !== lastId) { lastId = r.idText; idCell = text(lastId); }
    return { time: timeText, channel: channelCell, message: messageCell, id: idCell, signal: text(r.signalName), unit: text(r.unit), description: text(r.valueText) };
  };
}

/** CSV writer: begin() writes the header row, row(r) one line per table row, end() flushes. */
function createCsvWriter(write, options) {
  const neutralise = !options || options.neutralise !== false;
  const b = createBuffer(write);
  const cells = createCellSource(function (s) { return fastCell(s, neutralise); });
  return {
    begin: function () { b.put(U.csvRow(COLUMNS, false)); },
    row: function (r) {
      const c = cells(r);
      const raw = isPlainNumber(r.rawText) ? r.rawText : fastCell(r.rawText, neutralise);
      const physical = isPlainNumber(r.physicalText) ? r.physicalText : fastCell(r.physicalText, neutralise);
      b.put(c.time + ',' + c.channel + ',' + c.message + ',' + c.id + ',' + c.signal + ',' + raw + ',' + physical + ',' + c.unit + ',' + c.description + '\r\n');
    },
    end: function () { b.flush(); }
  };
}

/** JSON writer: one array, one element per row, valid JSON also when there are no rows. */
function createJsonWriter(write) {
  const b = createBuffer(write);
  const cells = createCellSource(function (s) { return JSON.stringify(s); });
  let first = true;
  return {
    begin: function () { b.put('['); },
    row: function (r) {
      const c = cells(r);
      const raw = isPlainNumber(r.rawText) ? '"' + r.rawText + '"' : JSON.stringify(r.rawText);
      const physical = isPlainNumber(r.physicalText) ? '"' + r.physicalText + '"' : JSON.stringify(r.physicalText);
      b.put((first ? '\n' : ',\n') + '{"time":"' + c.time + '","channel":' + c.channel + ',"message":' + c.message + ',"id":' + c.id + ',"signal":' + c.signal + ',"raw":' + raw + ',"physical":' + physical + ',"unit":' + c.unit + ',"description":' + c.description + '}');
      first = false;
    },
    end: function () { b.put(first ? ']\n' : '\n]\n'); b.flush(); }
  };
}

/** The rows as one string (for small tables and tests). format is 'csv' or 'json'. */
function rowsToString(rows, format, options) {
  let out = '';
  const w = format === 'json' ? createJsonWriter(function (s) { out += s; }) : createCsvWriter(function (s) { out += s; }, options);
  w.begin();
  for (const r of rows) w.row(r);
  w.end();
  return out;
}

// ---- statistics reports -------------------------------------------------------------------------

function num(x) { return x === null || x === undefined ? '' : String(x); }
function time(us) { return us === null || us === undefined || us < 0 ? '' : F.formatTimeUs(us); }

const MESSAGE_COLUMNS = [
  ['Message', function (m) { return m.messageName; }], ['ID', function (m) { return m.idText; }], ['Frames', function (m) { return num(m.frames); }],
  ['First (s)', function (m) { return time(m.firstTimeUs); }], ['Last (s)', function (m) { return time(m.lastTimeUs); }], ['Intervals', function (m) { return num(m.intervals); }],
  ['Mean period (us)', function (m) { return num(m.meanPeriodUs); }], ['Min period (us)', function (m) { return num(m.minPeriodUs); }], ['Max period (us)', function (m) { return num(m.maxPeriodUs); }],
  ['Std deviation (us)', function (m) { return num(m.stdDevPeriodUs); }], ['Jitter (us)', function (m) { return num(m.jitterUs); }], ['Frequency (Hz)', function (m) { return num(m.frequencyHz); }],
  ['Cycle time (us)', function (m) { return num(m.cycleTimeUs); }], ['Largest deviation from the cycle time (us)', function (m) { return num(m.maxCycleDeviationUs); }], ['Against the cycle time', function (m) { return m.verdict; }]
];
const SIGNAL_COLUMNS = [
  ['Message', function (s) { return s.messageName; }], ['ID', function (s) { return s.idText; }], ['Signal', function (s) { return s.signalName; }], ['Unit', function (s) { return s.unit; }],
  ['Values', function (s) { return num(s.count); }], ['Minimum', function (s) { return s.min; }], ['Maximum', function (s) { return s.max; }], ['Mean', function (s) { return s.mean; }],
  ['Not a number or infinite', function (s) { return num(s.nonFinite); }], ['First (s)', function (s) { return time(s.firstTimeUs); }], ['Last (s)', function (s) { return time(s.lastTimeUs); }]
];

function summaryPairs(meta) {
  const m = meta || {};
  const out = [];
  if (m.fileName) out.push(['Trace file', String(m.fileName)]);
  if (m.dbcName) out.push(['DBC file', String(m.dbcName)]);
  if (m.format) out.push(['Layout', String(m.format)]);
  const c = m.counters;
  if (c) {
    out.push(['Lines read', String(c.lines)]);
    out.push(['Frames', String(c.frames)]);
    out.push(['Frames of messages in the DBC', String(c.decodedFrames)]);
    out.push(['Frames of other IDs', String(c.unknownFrames)]);
    out.push(['Lines that could not be read', String(c.badLines)]);
  }
  return out;
}

/** The statistics as a Markdown document. meta: { fileName, dbcName, format, counters }. */
function statsMarkdown(stats, meta) {
  const lines = ['# Trace statistics', ''];
  const pairs = summaryPairs(meta);
  for (const p of pairs) lines.push('* ' + U.escapeMarkdown(p[0]) + ': ' + U.escapeMarkdown(p[1]));
  if (pairs.length) lines.push('');
  lines.push('## Messages', '');
  lines.push('| ' + MESSAGE_COLUMNS.map(function (c) { return U.escapeMarkdown(c[0]); }).join(' | ') + ' |');
  lines.push('| ' + MESSAGE_COLUMNS.map(function () { return '---'; }).join(' | ') + ' |');
  for (const m of stats.messages) lines.push('| ' + MESSAGE_COLUMNS.map(function (c) { return U.escapeMarkdown(c[1](m)); }).join(' | ') + ' |');
  lines.push('', '## Signals', '');
  lines.push('| ' + SIGNAL_COLUMNS.map(function (c) { return U.escapeMarkdown(c[0]); }).join(' | ') + ' |');
  lines.push('| ' + SIGNAL_COLUMNS.map(function () { return '---'; }).join(' | ') + ' |');
  for (const s of stats.signals) lines.push('| ' + SIGNAL_COLUMNS.map(function (c) { return U.escapeMarkdown(c[1](s)); }).join(' | ') + ' |');
  return lines.join('\n') + '\n';
}

function htmlTable(columns, items, caption) {
  const head = columns.map(function (c) { return '<th scope="col">' + U.escapeHtml(c[0]) + '</th>'; }).join('');
  const body = items.map(function (it) { return '<tr>' + columns.map(function (c) { return '<td>' + U.escapeHtml(c[1](it)) + '</td>'; }).join('') + '</tr>'; }).join('\n');
  return '<table><caption>' + U.escapeHtml(caption) + '</caption><thead><tr>' + head + '</tr></thead><tbody>\n' + body + '\n</tbody></table>';
}

/** The statistics as a complete HTML page without scripts (strict content security policy). */
function statsHtml(stats, meta) {
  const pairs = summaryPairs(meta);
  const list = pairs.length ? '<ul>' + pairs.map(function (p) { return '<li>' + U.escapeHtml(p[0]) + ': ' + U.escapeHtml(p[1]) + '</li>'; }).join('') + '</ul>' : '';
  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
    '<title>Trace statistics</title>' +
    '<style>body{font-family:system-ui,sans-serif;margin:1.5rem;color:#1b1b1b;background:#fff}table{border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #888;padding:.25rem .5rem;text-align:left}caption{text-align:left;font-weight:600;padding:.25rem 0}</style>' +
    '</head><body><h1>Trace statistics</h1>' + list + htmlTable(MESSAGE_COLUMNS, stats.messages, 'Messages') + htmlTable(SIGNAL_COLUMNS, stats.signals, 'Signals') + '</body></html>\n';
}

/** One table of the statistics as CSV; kind is 'messages' or 'signals'. */
function statsCsv(stats, kind, options) {
  const neutralise = !options || options.neutralise !== false;
  const columns = kind === 'signals' ? SIGNAL_COLUMNS : MESSAGE_COLUMNS;
  const items = kind === 'signals' ? stats.signals : stats.messages;
  let out = U.csvRow(columns.map(function (c) { return c[0]; }), false);
  for (const it of items) out += U.csvRow(columns.map(function (c) { return c[1](it); }), neutralise);
  return out;
}

module.exports = {
  COLUMNS: COLUMNS, recordOf: recordOf, createCsvWriter: createCsvWriter, createJsonWriter: createJsonWriter, rowsToString: rowsToString,
  statsMarkdown: statsMarkdown, statsHtml: statsHtml, statsCsv: statsCsv, MESSAGE_COLUMNS: MESSAGE_COLUMNS, SIGNAL_COLUMNS: SIGNAL_COLUMNS
};
