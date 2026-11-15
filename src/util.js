'use strict';
// Small shared helpers without editor dependencies: escaping for HTML, Markdown and CSV, formula
// neutralisation for spreadsheets, text decoding of files, and shortening of labels.

function str(s) { return String(s === undefined || s === null ? '' : s); }

function escapeHtml(s) {
  return str(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c];
  });
}

/** Text for a Markdown paragraph or table cell: no HTML, no links, no emphasis, no table breaks. */
function escapeMarkdown(s) {
  return str(s)
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/([\\`*_{}\[\]()#+!|<>~-])/g, '\\$1')
    .replace(/&/g, '&amp;');
}

/** Text inside Markdown inline code: backticks cannot close it early. */
function codeSpan(s) {
  const t = str(s).replace(/\r\n|\r|\n/g, ' ');
  let fence = '`';
  while (t.indexOf(fence) !== -1) fence += '`';
  const pad = /^`|`$/.test(t) || t.startsWith(' ') ? ' ' : '';
  return fence + pad + t + pad + fence;
}

const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const FORMULA_START = /^[=+\-@\t\r]/;
// A cell that is only digits with an optional minus sign and decimal part is a plain number: it
// cannot hold a formula, so signal values such as -12.5 stay numbers in the exports.
const SAFE_NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * Makes a value safe to open in a spreadsheet: text that starts with =, +, -, @, a tab or a
 * carriage return gets a leading apostrophe. Plain numbers such as -12.5 stay as they are (a
 * number cannot run anything). A value that already starts with an apostrophe followed by one of
 * those characters gets a second one, so that removing one apostrophe gives the original back.
 */
function neutralise(value) {
  const s = str(value);
  if ((FORMULA_START.test(s) && !SAFE_NUMBER.test(s)) || /^'[=+\-@\t\r]/.test(s)) return '\'' + s;
  return s;
}

/** The reverse of neutralise(): removes the one apostrophe it adds. */
function unneutralise(value) {
  const s = str(value);
  return /^'(?:[=+\-@\t\r]|'[=+\-@\t\r])/.test(s) ? s.slice(1) : s;
}

/** One CSV cell (RFC 4180): quoted when it holds a comma, a quote or a line break. */
function csvCell(value, neutraliseFormulas) {
  let s = str(value);
  if (neutraliseFormulas !== false) s = neutralise(s);
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvRow(cells, neutraliseFormulas) {
  return cells.map(function (c) { return csvCell(c, neutraliseFormulas); }).join(',') + '\r\n';
}

/**
 * Splits CSV text into rows of cells (RFC 4180 quoting; a quote inside a quoted cell is doubled).
 * Accepts CRLF, LF and CR line ends. Returns { rows, error } where error names the first line
 * with an unterminated quoted cell.
 */
function parseCsv(text, delimiter) {
  const sep = delimiter || ',';
  const src = str(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let i = 0;
  let line = 1;
  let quoted = false;
  let quoteLine = 0;
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      if (c === '\n') line++;
      cell += c; i++; continue;
    }
    if (c === '"' && cell === '') { quoted = true; quoteLine = line; i++; continue; }
    if (c === sep) { row.push(cell); cell = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(cell); cell = '';
      rows.push(row); row = [];
      if (c === '\r' && src[i + 1] === '\n') i++;
      i++; line++;
      continue;
    }
    cell += c; i++;
  }
  if (quoted) return { rows: rows, error: 'a quoted cell that starts on line ' + quoteLine + ' is not closed' };
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return { rows: rows.filter(function (r) { return !(r.length === 1 && r[0] === ''); }), error: '' };
}

/** Shortens text to `max` characters with an ellipsis. */
function shorten(text, max) {
  const s = str(text);
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + '…';
}

/** A file name without characters that are unsafe on common file systems. */
function safeName(s) {
  return str(s || 'file').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'file';
}

const CP1252 = [0x20AC, 0xFFFD, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0xFFFD, 0x017D, 0xFFFD,
  0xFFFD, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0xFFFD, 0x017E, 0x0178];

/**
 * Text of a file's bytes: UTF-8 (with or without byte order mark), UTF-16 with a byte order mark,
 * or Windows-1252 when the bytes are not valid UTF-8 (DBC files are often saved that way).
 * Returns { text, encoding }.
 */
function decodeBytes(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Buffer.from(bytes || []);
  if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'utf-16le' };
  if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) {
    const swapped = Buffer.alloc(b.length - 2);
    for (let k = 2; k + 1 < b.length; k += 2) { swapped[k - 2] = b[k + 1]; swapped[k - 1] = b[k]; }
    return { text: new TextDecoder('utf-16le').decode(swapped), encoding: 'utf-16be' };
  }
  const start = b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF ? 3 : 0;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(start)), encoding: 'utf-8' };
  } catch (e) {
    let out = '';
    const parts = [];
    for (let k = start; k < b.length; k++) {
      const c = b[k];
      out += String.fromCharCode(c >= 0x80 && c <= 0x9F ? CP1252[c - 0x80] : c);
      if (out.length >= 65536) { parts.push(out); out = ''; }
    }
    parts.push(out);
    return { text: parts.join(''), encoding: 'windows-1252' };
  }
}

/** A glob pattern (with *, ** and ?) as a regular expression for paths with forward slashes. */
function globToRegExp(glob) {
  let re = '';
  const g = str(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

module.exports = {
  escapeHtml: escapeHtml, escapeMarkdown: escapeMarkdown, codeSpan: codeSpan, neutralise: neutralise, unneutralise: unneutralise, csvCell: csvCell, csvRow: csvRow,
  parseCsv: parseCsv, shorten: shorten, safeName: safeName, decodeBytes: decodeBytes, globToRegExp: globToRegExp, PLAIN_NUMBER: PLAIN_NUMBER
};
