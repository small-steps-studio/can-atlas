'use strict';
// Text input and output of the Decode Frame and Encode Signals commands, without editor calls:
// reading a frame typed as "100#401F72FA" or "0x100 40 1F 72 FA", reading "Name=value" lists,
// finding the message of an identifier, and the Markdown shown as the result.

const B = require('./dbc/bits');
const codec = require('./dbc/codec');
const U = require('./util');

const MAX_BYTES = 64;

/**
 * Reads a frame. Forms: "100#401F72FA", "100 40 1F 72 FA", "0x100 401F72FA", "18FF50E5#0102".
 * An identifier followed by x ("100x") is an extended identifier. An identifier above 0x7FF is
 * extended too. A value from 0x80000000 on is read as a DBC message ID with the extended-frame
 * flag (bit 31). Returns { id, extended (true, false or null when it follows from the database),
 * bytes } or { error }.
 */
function parseFrameInput(text) {
  const t = String(text === undefined || text === null ? '' : text).trim();
  if (!t) return { error: 'Enter the frame as ID and data, for example 100#401F72FA8E01103C.' };
  if (t.length > 4096) return { error: 'The input is too long for a frame (at most 64 data bytes).' };
  let idText;
  let dataText;
  const hash = t.indexOf('#');
  if (hash !== -1) { idText = t.slice(0, hash); dataText = t.slice(hash + 1); } else {
    const m = /^(\S+)\s*([\s\S]*)$/.exec(t);
    idText = m[1];
    dataText = m[2];
  }
  idText = idText.trim();
  let extended = null;
  if (/[xX]$/.test(idText)) { extended = true; idText = idText.slice(0, -1); }
  const idm = /^(?:0[xX])?([0-9A-Fa-f]{1,8})$/.exec(idText);
  if (!idm) return { error: 'The identifier "' + U.shorten(idText, 20) + '" is not a hexadecimal number of up to 8 digits.' };
  let id = parseInt(idm[1], 16);
  if (id >= 0x80000000) { id -= 0x80000000; extended = true; }
  if (id > 0x1FFFFFFF) return { error: 'The identifier ' + idm[1].toUpperCase() + ' does not fit into the 29 bits of an extended identifier.' };
  if (id > 0x7FF) extended = true;
  const tokens = dataText.split(/[\s,:;]+/).filter(Boolean);
  let hex = '';
  for (const tok of tokens) {
    const digits = /^0[xX]/.test(tok) && tok.length > 2 ? tok.slice(2) : tok;
    if (!/^[0-9A-Fa-f]+$/.test(digits)) return { error: 'The data "' + U.shorten(tok, 20) + '" is not hexadecimal. Write the bytes as hex digits, for example 40 1F 72 FA or 401F72FA.' };
    hex += digits;
  }
  if (hex.length % 2) return { error: 'The data has an odd number of hex digits (' + hex.length + '); every byte needs two digits.' };
  if (hex.length / 2 > MAX_BYTES) return { error: 'The data has ' + hex.length / 2 + ' bytes; a frame carries at most ' + MAX_BYTES + '.' };
  const bytes = new Uint8Array(hex.length / 2);
  for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hex.slice(2 * k, 2 * k + 2), 16);
  return { id: id, extended: extended, bytes: bytes };
}

/**
 * The message of an identifier. `extended` true or false selects the kind; null chooses the
 * standard message when the identifier fits 11 bits and one exists, otherwise the extended one.
 * Returns { message, note } (message is null when nothing matches).
 */
function findMessage(db, id, extended) {
  const std = extended === true || id > 0x7FF ? null : db.messageByRawId.get(id) || null;
  const ext = extended === false || id > 0x1FFFFFFF ? null : db.messageByRawId.get(id + 0x80000000) || null;
  const pick = function (m) { return m && !m.pseudo ? m : null; };
  if (extended === true) return { message: pick(ext), note: '' };
  if (extended === false) return { message: pick(std), note: '' };
  if (pick(std) && pick(ext)) return { message: std, note: 'The database also has an extended message with this identifier (' + ext.name + '); add x after the identifier to use it.' };
  if (pick(std)) return { message: std, note: '' };
  if (pick(ext)) return { message: ext, note: '' };
  return { message: null, note: '' };
}

/** Reads "Name=value; Name=\"description\"" lists: separators are ; , and line breaks outside quotes. */
function parseAssignments(text) {
  const src = String(text === undefined || text === null ? '' : text);
  if (src.length > 100000) return { error: 'The input is too long.' };
  const parts = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') { quoted = !quoted; cur += c; continue; }
    if (!quoted && (c === ';' || c === ',' || c === '\n' || c === '\r')) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (quoted) return { error: 'A quote is not closed.' };
  parts.push(cur);
  const map = new Map();
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq < 1) return { error: '"' + U.shorten(p, 30) + '" is not written as Name=value.' };
    const name = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { error: '"' + U.shorten(name, 30) + '" is not a signal name (letters, digits and _).' };
    if (!value) return { error: 'The signal ' + name + ' has no value.' };
    if (map.has(name)) return { error: 'The signal ' + name + ' is given twice.' };
    map.set(name, value);
  }
  return { assignments: map };
}

function cell(s) { return U.escapeMarkdown(s); }
// Plain numbers (such as -6.2) are written as they are; anything else is escaped.
function num(s) { return U.PLAIN_NUMBER.test(String(s)) ? String(s) : cell(s); }

/** The Markdown result of Decode Frame. */
function decodeMarkdown(db, message, bytes, extra) {
  const dec = codec.decodeMessage(message, bytes, bytes.length);
  const lines = [];
  lines.push('# ' + cell(message.name) + ' (' + cell(codec.frameIdText(message)) + (message.extended ? ', extended' : ', standard') + ')');
  lines.push('');
  lines.push('Frame: ' + U.codeSpan(codec.frameIdText(message) + '#' + B.hexBytes(bytes, '')) + ' (' + bytes.length + (bytes.length === 1 ? ' byte' : ' bytes') + '; the message is defined with ' + message.size + ').');
  const notes = [];
  if (extra) notes.push(extra);
  if (bytes.length < message.size) notes.push('The frame is shorter than the message: signals that need the missing bytes are marked short and are not decoded.');
  if (bytes.length > message.size) notes.push('The frame is longer than the message (' + message.size + ' bytes); the extra bytes belong to no signal.');
  for (const n of notes) lines.push('', cell(n));
  lines.push('', '| Signal | Raw | Physical | Unit | Description | Note |', '| --- | ---: | ---: | --- | --- | --- |');
  let shown = 0;
  for (const r of dec.rows) {
    if (shown >= 2000) break;
    shown++;
    if (r.status === 'ok') lines.push('| ' + cell(r.signal.name) + ' | ' + num(r.rawText) + ' | ' + num(r.physical) + ' | ' + cell(r.signal.unit) + ' | ' + cell(r.text) + ' | |');
    else lines.push('| ' + cell(r.signal.name) + ' | | | ' + cell(r.signal.unit) + ' | | ' + cell(r.status === 'absent' ? 'not present: ' + r.reason : r.status === 'short' ? 'short: ' + r.reason : 'not decoded: ' + r.reason) + ' |');
  }
  if (dec.rows.length > shown) lines.push('', cell((dec.rows.length - shown) + ' more signals are not listed.'));
  lines.push('', 'Physical value: raw times factor plus offset, computed with exact decimals. Float signals show the shortest decimal that reads back to the same float.');
  return lines.join('\n') + '\n';
}

/** The Markdown result of Encode Signals; `enc` is what codec.encodeMessage returned. */
function encodeMarkdown(message, enc) {
  const lines = [];
  lines.push('# Encoded ' + cell(message.name) + ' (' + cell(codec.frameIdText(message)) + (message.extended ? ', extended' : ', standard') + ')');
  lines.push('');
  if (enc.errors.length) {
    lines.push('The frame was not completely encoded:', '');
    for (const e of enc.errors) lines.push('* ' + cell(e));
    lines.push('');
  }
  lines.push('Frame: ' + U.codeSpan(enc.frameText) + ' (' + enc.bytes.length + (enc.bytes.length === 1 ? ' byte' : ' bytes') + ')');
  lines.push('', 'Bytes: ' + U.codeSpan(B.hexBytes(enc.bytes, ' ')));
  lines.push('', '| Signal | Source | Raw | Physical | Unit | Note |', '| --- | --- | ---: | ---: | --- | --- |');
  let shown = 0;
  for (const r of enc.rows) {
    if (!r) continue;
    if (shown >= 2000) break;
    shown++;
    const source = !r.encoded ? '' : r.source === 'given' ? 'given' : 'not given: raw 0';
    lines.push('| ' + cell(r.name) + ' | ' + source + ' | ' + num(r.encoded ? r.rawText : '') + ' | ' + num(r.encoded ? r.physical : '') + ' | ' + cell(r.unit) + ' | ' + cell(r.note) + ' |');
  }
  if (enc.warnings.length) {
    lines.push('', 'Warnings:', '');
    for (const w of enc.warnings.slice(0, 50)) lines.push('* ' + cell(w));
  }
  lines.push('', cell('Signals that were not given start at the raw value 0. A physical value that falls between two raw steps is rounded to the nearest step; the rounded value is shown.'));
  return lines.join('\n') + '\n';
}

module.exports = { parseFrameInput: parseFrameInput, findMessage: findMessage, parseAssignments: parseAssignments, decodeMarkdown: decodeMarkdown, encodeMarkdown: encodeMarkdown, MAX_BYTES: MAX_BYTES };
