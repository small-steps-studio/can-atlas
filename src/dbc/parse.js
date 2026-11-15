'use strict';
// Reader for DBC files, the text format of CAN databases. It reads the statements that describe
// nodes, value tables, messages, signals, value descriptions, comments, attribute definitions and
// values, signal value types, extra transmitters and extended multiplexing, keeps the text offset
// of every name and value, and continues with the next statement after one it cannot read.
// Statements of other kinds (environment variables, signal types, groups, categories, relations)
// are passed over without an error. Nothing from the file is ever evaluated.

const crypto = require('node:crypto');
const D = require('./decimal');

const KEYWORDS = new Set(['VERSION', 'NS_', 'BS_', 'BU_', 'BO_', 'SG_', 'EV_', 'CM_', 'BA_DEF_', 'BA_DEF_DEF_', 'BA_', 'VAL_', 'VAL_TABLE_',
  'SIG_VALTYPE_', 'SG_MUL_VAL_', 'BO_TX_BU_', 'ENVVAR_DATA_', 'SGTYPE_', 'SGTYPE_VAL_', 'SIG_TYPE_REF_', 'SIG_GROUP_', 'CAT_DEF_', 'CAT_', 'FILTER',
  'BA_DEF_SGTYPE_', 'BA_SGTYPE_', 'SIGTYPE_VALTYPE_', 'NS_DESC_', 'BA_DEF_REL_', 'BA_REL_', 'BA_DEF_DEF_REL_', 'BU_SG_REL_', 'BU_EV_REL_', 'BU_BO_REL_', 'EV_DATA_']);
const PASSED_OVER = new Set(['ENVVAR_DATA_', 'SGTYPE_VAL_', 'SIG_TYPE_REF_', 'SIG_GROUP_', 'CAT_DEF_', 'CAT_', 'FILTER', 'BA_DEF_SGTYPE_', 'BA_SGTYPE_',
  'SIGTYPE_VALTYPE_', 'NS_DESC_', 'BA_DEF_REL_', 'BA_REL_', 'BA_DEF_DEF_REL_', 'BU_SG_REL_', 'BU_EV_REL_', 'BU_BO_REL_', 'EV_DATA_']);
// Statements whose content the database keeps (and the comparison of two databases compares).
// Every other statement is read over; it is recorded in `db.uncompared` so that two files that
// differ only there are not reported as identical.
const INTERPRETED = new Set(['VERSION', 'BU_', 'VAL_TABLE_', 'BO_', 'SG_', 'BO_TX_BU_', 'CM_', 'BA_DEF_', 'BA_DEF_DEF_', 'BA_', 'VAL_', 'SIG_VALTYPE_', 'SG_MUL_VAL_']);
// Statements that add one item to a list of the database; the item gets the key of its statement
// so that statements without effect (they refer to nothing, or are replaced by a later one) can be
// compared too.
const KEYED = { 'CM_': 'comments', 'BA_': 'attributes', 'VAL_': 'valueDescriptions', 'SIG_VALTYPE_': 'valueTypes', 'SG_MUL_VAL_': 'muxSpecs', 'BO_TX_BU_': 'transmitters',
  'VAL_TABLE_': 'valueTables', 'BA_DEF_': 'attributeDefs', 'BA_DEF_DEF_': 'attributeDefaults' };
const OBJECT_TYPES = new Set(['BU_', 'BO_', 'SG_', 'EV_']);
const INDEPENDENT = 'VECTOR__INDEPENDENT_SIG_MSG';
const NO_NODE = 'Vector__XXX';

// About 850 MB for the kept objects of a file; a realistic file of 50 MB (88,000 messages and
// 1,000,000 signals) is far below it. See spend() in parseDbc.
const READ_LIMIT = 6500000;
const STOP = Object.freeze({ readLimit: true });
// Most different statements that are read over without interpretation and kept for the comparison.
const UNCOMPARED_CAP = 50000;

const NUM_RE = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const UINT_RE = /\d+/y;

function isIdentStart(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; }
function isIdentPart(c) { return isIdentStart(c) || (c >= 48 && c <= 57); }
function clip(s) { const t = String(s); return t.length > 40 ? t.slice(0, 39) + '…' : t; }
/**
 * The key of the text between two offsets with the white space collapsed to single spaces and
 * trimmed: the text itself when it has at most 60 characters, otherwise a 53-bit hash and the
 * length. It runs over the characters once and allocates nothing for long text, so a statement
 * of 50 MB costs no memory.
 */
function digest(src, start, end, hashOnly) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  let length = 0;
  let head = '';
  let space = false;
  for (let i = start; i < end; i++) {
    let ch = src.charCodeAt(i);
    if (ch <= 32 || ch === 0xA0 || ch === 0xFEFF || ch === 0x2028 || ch === 0x2029) { if (length > 0) space = true; continue; }
    if (space) {
      h1 = Math.imul(h1 ^ 32, 2654435761);
      h2 = Math.imul(h2 ^ 32, 1597334677);
      length++;
      if (length <= 61) head += ' ';
      space = false;
    }
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
    length++;
    if (length <= 61) head += src[i];
  }
  if (length <= 60 && !hashOnly) return head;
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'h' + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ':' + length;
}
function idNumber(text) { return text.length > 15 ? Infinity : Number(text); }

/**
 * Reads DBC text. Returns the database: version, nodes, valueTables, messages (each with its
 * signals), comments, attributeDefs, attributeDefaults, attributes, valueDescriptions, valueTypes,
 * muxSpecs, transmitters, envVars, signalTypes, refs (names used in later statements, in text
 * order) and problems (what could not be read). Offsets count UTF-16 code units of the text.
 */
/**
 * A fingerprint of the exact content of a file, for the comparison of two files: the text itself
 * (every character, a leading byte order mark included, as read by parseDbc) or the bytes of the
 * file (Uint8Array). Two fingerprints are equal only when the content is identical; a text
 * fingerprint is never equal to a byte fingerprint.
 */
function sourceFingerprint(content) {
  const h = crypto.createHash('sha256');
  if (typeof content === 'string') return 't:' + h.update(content, 'utf16le').digest('hex');
  return 'b:' + h.update(content instanceof Uint8Array ? content : Buffer.from(content || [])).digest('hex');
}

function parseDbc(input) {
  const src = typeof input === 'string' ? input : String(input === undefined || input === null ? '' : input);
  const n = src.length;
  let pos = n > 0 && src.charCodeAt(0) === 0xFEFF ? 1 : 0;
  const db = {
    length: n, fingerprint: sourceFingerprint(src), version: null, nodes: [], valueTables: [], messages: [], orphanSignals: [], comments: [], attributeDefs: [], attributeDefaults: [],
    attributes: [], valueDescriptions: [], valueTypes: [], muxSpecs: [], transmitters: [], envVars: [], signalTypes: [], refs: [], problems: [], uncompared: new Map(), uncomparedCapped: false
  };
  let current = null;
  // Memory guard: every object kept costs some units (a message or signal about 5, a comment or
  // value description about 1 to 2). When the file holds more than READ_LIMIT units, reading stops
  // with a warning, so that a hostile or damaged file cannot use up the memory of the editor.
  let spent = 0;
  let reading = true;
  function spend(units) { spent += units; if (reading && spent > READ_LIMIT) throw STOP; }

  function problem(code, severity, message, start, end) {
    spend(1);
    const s = Math.max(0, Math.min(start, n));
    let e = Math.max(s, Math.min(end === undefined ? s : end, n));
    if (e === s && s < n) e = s + 1;
    db.problems.push({ code: code, severity: severity, message: message, start: s, end: e });
  }

  // ---- scanning ---------------------------------------------------------------------------------
  function sp() { while (pos < n) { const c = src.charCodeAt(pos); if (c === 32 || c === 9 || c === 11 || c === 12) pos++; else break; } }
  function ws() { while (pos < n && src.charCodeAt(pos) <= 32) pos++; }
  function lineEnd(from) { let i = from; while (i < n) { const c = src.charCodeAt(i); if (c === 10 || c === 13) break; i++; } return i; }
  function nextLineStart(from) { let i = lineEnd(from); if (i < n && src.charCodeAt(i) === 13) i++; if (i < n && src.charCodeAt(i) === 10) i++; return i; }
  function atEol() { sp(); return pos >= n || src.charCodeAt(pos) === 10 || src.charCodeAt(pos) === 13; }
  function word() {
    const start = pos;
    while (pos < n) {
      const c = src.charCodeAt(pos);
      if (c <= 32 || c === 58 || c === 59 || c === 44 || c === 124 || c === 64 || c === 40 || c === 41 || c === 91 || c === 93 || c === 34) break;
      pos++;
    }
    return pos > start ? { text: src.slice(start, pos), start: start, end: pos } : null;
  }
  function number() {
    NUM_RE.lastIndex = pos;
    const m = NUM_RE.exec(src);
    if (!m) return null;
    const start = pos;
    pos += m[0].length;
    return { text: m[0], start: start, end: pos };
  }
  function uint() {
    UINT_RE.lastIndex = pos;
    const m = UINT_RE.exec(src);
    if (!m) return null;
    const start = pos;
    pos += m[0].length;
    return { text: m[0], start: start, end: pos };
  }
  function expect(code) { if (pos < n && src.charCodeAt(pos) === code) { pos++; return true; } return false; }
  /** True when a statement keyword starts at p and only spaces or tabs precede it on its line. */
  function startsStatement(p) {
    let b = p - 1;
    while (b >= 0) { const c = src.charCodeAt(b); if (c === 32 || c === 9) b--; else break; }
    if (b >= 0) { const c = src.charCodeAt(b); if (c !== 10 && c !== 13 && !(b === 0 && c === 0xFEFF)) return false; }
    let e = p;
    while (e < n && isIdentPart(src.charCodeAt(e))) e++;
    if (e === p || !KEYWORDS.has(src.slice(p, e))) return false;
    return e >= n || src.charCodeAt(e) <= 32 || src.charCodeAt(e) === 58;
  }
  /** The first statement keyword at or after `from` that begins a line, or n. */
  function nextStatement(from) {
    let i = from;
    while (i < n) {
      let j = i;
      while (j < n) { const c = src.charCodeAt(j); if (c === 32 || c === 9) j++; else break; }
      if (startsStatement(j)) return j;
      i = nextLineStart(i);
      if (i <= from && i < n) i = from + 1;
    }
    return n;
  }
  /**
   * A string in double quotes. `\"` and `\\` stand for a quote and a backslash. A string that may
   * span lines ends at the closing quote; it is treated as unterminated when a line that starts a
   * statement comes first. ok is false for an unterminated string.
   */
  function string(multiLine) {
    if (pos >= n || src.charCodeAt(pos) !== 34) return null;
    const start = pos;
    pos++;
    let out = '';
    let chunk = pos;
    while (pos < n) {
      const c = src.charCodeAt(pos);
      if (c === 34) { out += src.slice(chunk, pos); pos++; return { text: out, start: start, end: pos, ok: true }; }
      if (c === 92 && pos + 1 < n) {
        const d = src.charCodeAt(pos + 1);
        if (d === 34 || d === 92) { out += src.slice(chunk, pos) + src[pos + 1]; pos += 2; chunk = pos; continue; }
      }
      if (c === 10 || c === 13) {
        if (!multiLine) break;
        const next = nextLineStart(pos);
        let j = next;
        while (j < n) { const x = src.charCodeAt(j); if (x === 32 || x === 9) j++; else break; }
        if (startsStatement(j) && looksLikeStatementLine(j)) break;
      }
      pos++;
    }
    out += src.slice(chunk, pos);
    return { text: out, start: start, end: pos, ok: false };
  }
  // A line inside a multi-line string is taken as the start of a new statement only when it looks
  // like one: a keyword followed by a number, a quote, a name and a colon, or a statement keyword
  // that names an object type.
  function looksLikeStatementLine(j) {
    const line = src.slice(j, Math.min(lineEnd(j), j + 200));
    return /^(BO_|BO_TX_BU_|VAL_|SIG_VALTYPE_|SG_MUL_VAL_)[ \t]+\d/.test(line) || /^(CM_|BA_|BA_DEF_|BA_DEF_DEF_)[ \t]+("|BU_|BO_|SG_|EV_)/.test(line) ||
      /^(VAL_TABLE_|BU_|EV_)[ \t]*[:A-Za-z_]/.test(line) || /^SG_[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]*(M[ \t]+|m\d+M?[ \t]+)?:/.test(line);
  }
  /** Moves past the current statement: after its ";" or to the next line that starts a statement. */
  function recover() {
    let inString = false;
    while (pos < n) {
      const c = src.charCodeAt(pos);
      if (c === 10 || c === 13) {
        const next = nextLineStart(pos);
        let j = next;
        while (j < n) { const x = src.charCodeAt(j); if (x === 32 || x === 9) j++; else break; }
        if (startsStatement(j) && (!inString || looksLikeStatementLine(j))) { pos = j; return false; }
        pos = next;
        continue;
      }
      if (inString) {
        if (c === 92 && pos + 1 < n && (src.charCodeAt(pos + 1) === 34 || src.charCodeAt(pos + 1) === 92)) { pos += 2; continue; }
        if (c === 34) inString = false;
        pos++;
        continue;
      }
      if (c === 34) { inString = true; pos++; continue; }
      if (c === 59) { pos++; return true; }
      pos++;
    }
    return false;
  }
  /** Ends a statement that needs ";". */
  function finish(stmtStart) {
    const save = pos;
    ws();
    if (pos < n && src.charCodeAt(pos) === 59) { pos++; return true; }
    if (pos >= n || startsStatement(pos)) {
      problem('DBC-SEMICOLON', 'warning', 'The statement does not end with ";".', Math.max(stmtStart, save - 1), save);
      pos = save;
      return true;
    }
    problem('DBC-SYNTAX', 'error', 'Unexpected "' + clip(src.slice(pos, Math.min(lineEnd(pos), pos + 30))) + '" where the statement should end with ";".', pos, Math.min(lineEnd(pos), pos + 30));
    recover();
    return false;
  }
  // True while the current statement failed to be read (its text is then kept as a statement that is not compared).
  let failed = false;
  // True while the current statement holds entries that are ignored (not whole numbers, or a raw value given twice).
  let partial = false;
  function failStatement(message, start, end) {
    failed = true;
    problem('DBC-SYNTAX', 'error', message, start, end === undefined ? start + 1 : end);
    recover();
    return null;
  }
  function failLine(message, start, end) {
    failed = true;
    problem('DBC-SYNTAX', 'error', message, start, end === undefined ? start + 1 : end);
    pos = lineEnd(pos);
    return null;
  }
  function found() {
    if (pos >= n) return 'the end of the file';
    const c = src.charCodeAt(pos);
    if (c === 10 || c === 13) return 'the end of the line';
    return '"' + clip(src.slice(pos, Math.min(lineEnd(pos), pos + 12))) + '"';
  }
  function valueText() {
    if (pos < n && src.charCodeAt(pos) === 34) {
      const s = string(true);
      if (!s.ok) problem('DBC-STRING-UNTERMINATED', 'error', 'This text has no closing double quote.', s.start, Math.min(s.end, s.start + 40));
      return { text: s.text, start: s.start, end: s.end, isString: true };
    }
    const num = number();
    return num ? { text: num.text, start: num.start, end: num.end, isString: false } : null;
  }
  function ref(kind, item) { spend(1); db.refs.push(Object.assign({ kind: kind }, item)); }
  function messageRef(tok) { const raw = idNumber(tok.text); ref('message', { rawId: raw, start: tok.start, end: tok.end }); return raw; }

  // ---- statements -------------------------------------------------------------------------------
  function parseNs() {
    sp();
    expect(58);
    pos = lineEnd(pos);
    for (;;) {
      const ls = nextLineStart(pos);
      if (ls >= n) { pos = n; return; }
      const le = lineEnd(ls);
      let i = ls;
      let names = 0;
      let only = true;
      while (i < le) {
        const c = src.charCodeAt(i);
        if (c === 32 || c === 9) { i++; continue; }
        if (!isIdentStart(c)) { only = false; break; }
        let j = i + 1;
        while (j < le && isIdentPart(src.charCodeAt(j))) j++;
        names++;
        i = j;
      }
      if (only && names === 0) { pos = le; continue; }
      if (!only) return;
      pos = le;
    }
  }

  function parseNodes(kwStart) {
    sp();
    if (!expect(58)) problem('DBC-SYNTAX', 'error', 'Expected ":" after BU_.', kwStart, pos);
    const readLine = function () {
      for (;;) {
        sp();
        if (atEol()) return;
        if (src.charCodeAt(pos) === 44) { pos++; continue; }
        const w = word();
        if (!w) { problem('DBC-SYNTAX', 'error', 'Unexpected ' + found() + ' in the node list.', pos, pos + 1); pos = lineEnd(pos); return; }
        spend(1);
        db.nodes.push({ name: w.text, start: w.start, end: w.end });
      }
    };
    readLine();
    // A long node list may continue on indented lines that hold only names.
    for (;;) {
      const ls = nextLineStart(pos);
      if (ls >= n) return;
      const c = src.charCodeAt(ls);
      if (c !== 32 && c !== 9) return;
      const le = lineEnd(ls);
      const parts = src.slice(ls, le).trim().split(/[\s,]+/).filter(Boolean);
      if (!parts.length || KEYWORDS.has(parts[0]) || !parts.every(function (p) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(p); })) return;
      pos = ls;
      readLine();
    }
  }

  function valueEntries(stmtStart) {
    const entries = [];
    const seenValues = new Set();
    for (;;) {
      ws();
      if (pos >= n) { problem('DBC-SEMICOLON', 'warning', 'The value list ends without ";".', stmtStart, Math.min(n, stmtStart + 4)); return entries; }
      const c = src.charCodeAt(pos);
      if (c === 59) { pos++; return entries; }
      if (startsStatement(pos)) { problem('DBC-SEMICOLON', 'warning', 'The value list does not end with ";".', stmtStart, Math.min(n, stmtStart + 4)); return entries; }
      const num = number();
      if (!num) { failStatement('Expected a raw value (a whole number), a description in double quotes or ";", found ' + found() + '.', pos); return entries; }
      ws();
      const s = string(false);
      if (!s) { failStatement('Expected the description of the value ' + num.text + ' in double quotes.', pos); return entries; }
      if (!s.ok) problem('DBC-STRING-UNTERMINATED', 'error', 'This description has no closing double quote.', s.start, s.end);
      const d = D.parse(num.text);
      let value = null;
      if (d && D.isInteger(d)) value = d.n;
      else { partial = true; problem('DBC-VALUE-NOT-WHOLE', 'warning', 'Value descriptions belong to whole raw values; ' + clip(num.text) + ' is not a whole number, so this entry is ignored.', num.start, num.end); }
      spend(1);
      if (value !== null && seenValues.has(String(value))) partial = true;
      if (value !== null) seenValues.add(String(value));
      if (value !== null) entries.push({ value: value, text: s.text, start: num.start, end: s.end });
    }
  }

  function parseValueTable(kwStart) {
    ws();
    const name = word();
    if (!name) return failStatement('Expected the name of the value table after VAL_TABLE_.', kwStart, pos);
    const entries = valueEntries(kwStart);
    db.valueTables.push({ name: name.text, start: kwStart, end: pos, nameStart: name.start, nameEnd: name.end, entries: entries });
    return null;
  }

  function parseMessage(kwStart) {
    sp();
    const id = uint();
    if (!id) return failLine('Expected the message ID (a whole number) after BO_, found ' + found() + '.', pos);
    sp();
    const name = word();
    if (!name) return failLine('Expected the message name after the ID, found ' + found() + '.', pos);
    sp();
    if (!expect(58)) return failLine('Expected ":" after the message name, found ' + found() + '.', pos);
    sp();
    const size = uint();
    if (!size) return failLine('Expected the data length in bytes after ":", found ' + found() + '.', pos);
    sp();
    const sender = atEol() ? null : word();
    if (!sender) { problem('DBC-SYNTAX', 'error', 'Expected the name of the sending node after the data length (' + NO_NODE + ' when there is none).', pos, pos + 1); pos = lineEnd(pos); }
    else if (!atEol()) { problem('DBC-SYNTAX', 'error', 'Unexpected ' + found() + ' after the sending node.', pos, lineEnd(pos)); pos = lineEnd(pos); }
    const raw = idNumber(id.text);
    const extended = raw >= 0x80000000 && raw <= 0xFFFFFFFF;
    const message = {
      name: name.text, nameStart: name.start, nameEnd: name.end, idText: id.text, rawId: raw, idStart: id.start, idEnd: id.end,
      extended: extended, frameId: extended ? raw - 0x80000000 : raw, size: idNumber(size.text), sizeStart: size.start, sizeEnd: size.end,
      sender: sender ? sender.text : NO_NODE, senderStart: sender ? sender.start : size.end, senderEnd: sender ? sender.end : size.end,
      start: kwStart, headerEnd: pos, end: pos, signals: [], transmitters: [], comment: null, attributes: null, pseudo: name.text === INDEPENDENT, index: db.messages.length
    };
    db.messages.push(message);
    return message;
  }

  function parseSignal(kwStart) {
    sp();
    const name = word();
    if (!name) return failLine('Expected the signal name after SG_, found ' + found() + '.', pos);
    sp();
    let isMultiplexor = false;
    let muxValue = null;
    let muxTok = null;
    if (pos < n && src.charCodeAt(pos) !== 58) {
      const t = word();
      const m = t ? /^m(\d{1,18})(M?)$/.exec(t.text) : null;
      if (t && t.text === 'M') isMultiplexor = true;
      else if (m) { muxValue = BigInt(m[1]); isMultiplexor = m[2] === 'M'; }
      else return failLine('Expected ":" or a multiplexer indicator (M, m<value> or m<value>M) after the signal name, found ' + found() + '.', t ? t.start : pos, t ? t.end : pos + 1);
      muxTok = t;
      sp();
    }
    if (!expect(58)) return failLine('Expected ":" after the signal name, found ' + found() + '.', pos);
    sp();
    const specStart = pos;
    const sb = uint();
    if (!sb) return failLine('Expected the start bit (a whole number) after ":", found ' + found() + '.', pos);
    sp();
    if (!expect(124)) return failLine('Expected "|" between the start bit and the length, found ' + found() + '.', pos);
    sp();
    const len = uint();
    if (!len) return failLine('Expected the length in bits after "|", found ' + found() + '.', pos);
    sp();
    if (!expect(64)) return failLine('Expected "@" before the byte order, found ' + found() + '.', pos);
    const order = src[pos];
    if (order !== '0' && order !== '1') return failLine('The byte order after "@" must be 1 (little-endian) or 0 (big-endian), found ' + found() + '.', pos);
    pos++;
    const sign = src[pos];
    if (sign !== '+' && sign !== '-') return failLine('The byte order must be followed by + (unsigned) or - (signed), found ' + found() + '.', pos);
    pos++;
    const specEnd = pos;
    sp();
    const scaleStart = pos;
    if (!expect(40)) return failLine('Expected "(" before the factor, found ' + found() + '.', pos);
    sp();
    const factor = number();
    if (!factor) return failLine('Expected the factor (a number) after "(", found ' + found() + '.', pos);
    sp();
    if (!expect(44)) return failLine('Expected "," between the factor and the offset, found ' + found() + '.', pos);
    sp();
    const offset = number();
    if (!offset) return failLine('Expected the offset (a number) after ",", found ' + found() + '.', pos);
    sp();
    if (!expect(41)) return failLine('Expected ")" after the offset, found ' + found() + '.', pos);
    const scaleEnd = pos;
    sp();
    const rangeStart = pos;
    if (!expect(91)) return failLine('Expected "[" before the minimum, found ' + found() + '.', pos);
    sp();
    const min = number();
    if (!min) return failLine('Expected the minimum (a number) after "[", found ' + found() + '.', pos);
    sp();
    if (!expect(124)) return failLine('Expected "|" between the minimum and the maximum, found ' + found() + '.', pos);
    sp();
    const max = number();
    if (!max) return failLine('Expected the maximum (a number) after "|", found ' + found() + '.', pos);
    sp();
    if (!expect(93)) return failLine('Expected "]" after the maximum, found ' + found() + '.', pos);
    const rangeEnd = pos;
    sp();
    const unit = string(false);
    if (!unit) return failLine('Expected the unit in double quotes after the range (write "" for none), found ' + found() + '.', pos);
    if (!unit.ok) { problem('DBC-STRING-UNTERMINATED', 'error', 'The unit has no closing double quote.', unit.start, unit.end); }
    const receivers = [];
    const receiverPos = [];
    for (;;) {
      if (atEol()) break;
      if (src.charCodeAt(pos) === 44) { pos++; continue; }
      const w = word();
      if (!w) { problem('DBC-SYNTAX', 'error', 'Unexpected ' + found() + ' in the receiver list.', pos, pos + 1); pos = lineEnd(pos); break; }
      if ((receivers.length & 3) === 0) spend(1);
      receivers.push(w.text);
      receiverPos.push(w.start, w.end);
    }
    return {
      name: name.text, nameStart: name.start, nameEnd: name.end, start: kwStart, end: pos,
      muxText: muxTok ? muxTok.text : '', muxStart: muxTok ? muxTok.start : -1, muxEnd: muxTok ? muxTok.end : -1, isMultiplexor: isMultiplexor, muxValue: muxValue,
      startBit: idNumber(sb.text), length: idNumber(len.text), little: order === '1', signed: sign === '-', specStart: specStart, specEnd: specEnd,
      factorText: factor.text, offsetText: offset.text, scaleStart: scaleStart, scaleEnd: scaleEnd,
      minText: min.text, maxText: max.text, rangeStart: rangeStart, rangeEnd: rangeEnd,
      // slice() gives arrays of exactly the needed size (a pushed-to array keeps room for 16 more)
      unit: unit.text, unitStart: unit.start, unitEnd: unit.end, receivers: receivers.slice(), receiverPos: receiverPos.slice(),
      valueType: 0, values: null, comment: null, attributes: null, muxSpec: null, index: 0
    };
  }

  function parseTransmitters(kwStart) {
    ws();
    const id = uint();
    if (!id) return failStatement('Expected the message ID after BO_TX_BU_, found ' + found() + '.', pos);
    const rawId = messageRef(id);
    ws();
    if (!expect(58)) return failStatement('Expected ":" after the message ID, found ' + found() + '.', pos);
    const names = [];
    for (;;) {
      ws();
      if (pos >= n || startsStatement(pos)) { problem('DBC-SEMICOLON', 'warning', 'The statement does not end with ";".', kwStart, kwStart + 9); break; }
      const c = src.charCodeAt(pos);
      if (c === 59) { pos++; break; }
      if (c === 44) { pos++; continue; }
      const w = word();
      if (!w) return failStatement('Unexpected ' + found() + ' in the list of transmitters.', pos);
      spend(1);
      names.push({ name: w.text, start: w.start, end: w.end });
      ref('node', { name: w.text, start: w.start, end: w.end });
    }
    db.transmitters.push({ rawId: rawId, idStart: id.start, idEnd: id.end, nodes: names, start: kwStart, end: pos });
    return null;
  }

  function parseComment(kwStart) {
    ws();
    let target = { kind: 'file' };
    if (pos < n && src.charCodeAt(pos) !== 34) {
      const k = word();
      if (!k) return failStatement('Expected BU_, BO_, SG_, EV_ or a text in double quotes after CM_, found ' + found() + '.', pos);
      ws();
      if (k.text === 'BU_') {
        const w = word();
        if (!w) return failStatement('Expected a node name after CM_ BU_.', pos);
        target = { kind: 'node', name: w.text, start: w.start, end: w.end };
        ref('node', { name: w.text, start: w.start, end: w.end });
      } else if (k.text === 'BO_' || k.text === 'SG_') {
        const id = uint();
        if (!id) return failStatement('Expected a message ID after CM_ ' + k.text + ', found ' + found() + '.', pos);
        const rawId = messageRef(id);
        target = { kind: 'message', rawId: rawId, start: id.start, end: id.end };
        if (k.text === 'SG_') {
          ws();
          const w = word();
          if (!w) return failStatement('Expected a signal name after the message ID.', pos);
          target = { kind: 'signal', rawId: rawId, name: w.text, start: w.start, end: w.end, idStart: id.start, idEnd: id.end };
          ref('signal', { rawId: rawId, name: w.text, start: w.start, end: w.end });
        }
      } else if (k.text === 'EV_') {
        const w = word();
        if (!w) return failStatement('Expected an environment variable name after CM_ EV_.', pos);
        target = { kind: 'envvar', name: w.text, start: w.start, end: w.end };
      } else return failStatement('Unknown comment target "' + clip(k.text) + '"; expected BU_, BO_, SG_ or EV_.', k.start, k.end);
      ws();
    }
    const s = string(true);
    if (!s) return failStatement('Expected the comment text in double quotes, found ' + found() + '.', pos);
    if (!s.ok) problem('DBC-STRING-UNTERMINATED', 'error', 'This comment has no closing double quote.', s.start, Math.min(s.end, s.start + 40));
    finish(kwStart);
    db.comments.push({ target: target, text: s.text, start: kwStart, end: pos, textStart: s.start, textEnd: s.end });
    return null;
  }

  function parseAttributeDef(kwStart) {
    ws();
    let objectType = '';
    if (pos < n && src.charCodeAt(pos) !== 34) {
      const t = word();
      if (!t || !OBJECT_TYPES.has(t.text)) return failStatement('Expected BU_, BO_, SG_, EV_ or the attribute name in double quotes after BA_DEF_, found ' + found() + '.', t ? t.start : pos, t ? t.end : pos + 1);
      objectType = t.text;
      ws();
    }
    const name = string(false);
    if (!name || !name.ok) return failStatement('Expected the attribute name in double quotes.', pos);
    ws();
    const type = word();
    if (!type) return failStatement('Expected the attribute type (INT, HEX, FLOAT, STRING or ENUM), found ' + found() + '.', pos);
    const def = { name: name.text, nameStart: name.start, nameEnd: name.end, objectType: objectType, type: type.text, typeStart: type.start, typeEnd: type.end, min: null, max: null, enumValues: null, start: kwStart, end: kwStart };
    if (type.text === 'INT' || type.text === 'HEX' || type.text === 'FLOAT') {
      ws();
      const a = number();
      ws();
      const b = a ? number() : null;
      if (!a || !b) return failStatement('Expected the smallest and the largest value after ' + type.text + '.', pos);
      def.min = a.text;
      def.max = b.text;
    } else if (type.text === 'ENUM') {
      def.enumValues = [];
      for (;;) {
        ws();
        const s = string(false);
        if (!s) break;
        spend(1);
        def.enumValues.push(s.text);
        ws();
        if (!expect(44)) break;
      }
    } else if (type.text !== 'STRING') return failStatement('Unknown attribute type "' + clip(type.text) + '"; expected INT, HEX, FLOAT, STRING or ENUM.', type.start, type.end);
    finish(kwStart);
    def.end = pos;
    db.attributeDefs.push(def);
    return null;
  }

  function parseAttributeDefault(kwStart) {
    ws();
    const name = string(false);
    if (!name || !name.ok) return failStatement('Expected the attribute name in double quotes after BA_DEF_DEF_.', pos);
    ws();
    const v = valueText();
    if (!v) return failStatement('Expected the default value (a number or a text in double quotes), found ' + found() + '.', pos);
    finish(kwStart);
    db.attributeDefaults.push({ name: name.text, nameStart: name.start, nameEnd: name.end, value: v, start: kwStart, end: pos });
    return null;
  }

  function parseAttribute(kwStart) {
    ws();
    const name = string(false);
    if (!name || !name.ok) return failStatement('Expected the attribute name in double quotes after BA_.', pos);
    ws();
    let target = { kind: 'network' };
    const c = pos < n ? src.charCodeAt(pos) : 0;
    if (c !== 34 && c !== 45 && c !== 43 && c !== 46 && !(c >= 48 && c <= 57)) {
      const k = word();
      if (!k) return failStatement('Expected BU_, BO_, SG_, EV_ or a value after the attribute name, found ' + found() + '.', pos);
      ws();
      if (k.text === 'BU_') {
        const w = word();
        if (!w) return failStatement('Expected a node name after BU_.', pos);
        target = { kind: 'node', name: w.text, start: w.start, end: w.end };
        ref('node', { name: w.text, start: w.start, end: w.end });
      } else if (k.text === 'BO_' || k.text === 'SG_') {
        const id = uint();
        if (!id) return failStatement('Expected a message ID after ' + k.text + ', found ' + found() + '.', pos);
        const rawId = messageRef(id);
        target = { kind: 'message', rawId: rawId, start: id.start, end: id.end };
        if (k.text === 'SG_') {
          ws();
          const w = word();
          if (!w) return failStatement('Expected a signal name after the message ID.', pos);
          target = { kind: 'signal', rawId: rawId, name: w.text, start: w.start, end: w.end };
          ref('signal', { rawId: rawId, name: w.text, start: w.start, end: w.end });
        }
      } else if (k.text === 'EV_') {
        const w = word();
        if (!w) return failStatement('Expected an environment variable name after EV_.', pos);
        target = { kind: 'envvar', name: w.text, start: w.start, end: w.end };
      } else return failStatement('Unknown attribute target "' + clip(k.text) + '"; expected BU_, BO_, SG_ or EV_.', k.start, k.end);
      ws();
    }
    const v = valueText();
    if (!v) return failStatement('Expected the attribute value (a number or a text in double quotes), found ' + found() + '.', pos);
    finish(kwStart);
    db.attributes.push({ name: name.text, nameStart: name.start, nameEnd: name.end, target: target, value: v, start: kwStart, end: pos });
    return null;
  }

  function parseValueDescription(kwStart) {
    ws();
    if (pos < n && src.charCodeAt(pos) >= 48 && src.charCodeAt(pos) <= 57) {
      const id = uint();
      const rawId = messageRef(id);
      ws();
      const sig = word();
      if (!sig) return failStatement('Expected a signal name after the message ID.', pos);
      ref('signal', { rawId: rawId, name: sig.text, start: sig.start, end: sig.end });
      const entries = valueEntries(kwStart);
      db.valueDescriptions.push({ rawId: rawId, idStart: id.start, idEnd: id.end, signalName: sig.text, signalStart: sig.start, signalEnd: sig.end, entries: entries, start: kwStart, end: pos });
      return null;
    }
    const env = word();
    if (!env) return failStatement('Expected a message ID or an environment variable name after VAL_, found ' + found() + '.', pos);
    valueEntries(kwStart);
    noteUncompared('VAL_ of an environment variable', kwStart, pos);
    return null;
  }

  function parseValueType(kwStart) {
    ws();
    const id = uint();
    if (!id) return failStatement('Expected the message ID after SIG_VALTYPE_, found ' + found() + '.', pos);
    const rawId = messageRef(id);
    ws();
    const sig = word();
    if (!sig) return failStatement('Expected the signal name after the message ID.', pos);
    ref('signal', { rawId: rawId, name: sig.text, start: sig.start, end: sig.end });
    ws();
    expect(58);
    ws();
    const t = uint();
    if (!t) return failStatement('Expected the value type (0 integer, 1 32-bit float, 2 64-bit float), found ' + found() + '.', pos);
    finish(kwStart);
    db.valueTypes.push({ rawId: rawId, idStart: id.start, idEnd: id.end, signalName: sig.text, signalStart: sig.start, signalEnd: sig.end, type: idNumber(t.text), typeStart: t.start, typeEnd: t.end, start: kwStart, end: pos });
    return null;
  }

  function parseMuxSpec(kwStart) {
    ws();
    const id = uint();
    if (!id) return failStatement('Expected the message ID after SG_MUL_VAL_, found ' + found() + '.', pos);
    const rawId = messageRef(id);
    ws();
    const sig = word();
    ws();
    const sw = sig ? word() : null;
    if (!sig || !sw) return failStatement('Expected the multiplexed signal and its multiplexor signal after the message ID.', pos);
    ref('signal', { rawId: rawId, name: sig.text, start: sig.start, end: sig.end });
    ref('signal', { rawId: rawId, name: sw.text, start: sw.start, end: sw.end });
    const ranges = [];
    for (;;) {
      ws();
      const a = uint();
      if (!a) return failStatement('Expected a range of multiplexor values such as 3-5, found ' + found() + '.', pos);
      ws();
      if (!expect(45)) return failStatement('Expected "-" inside the range of multiplexor values, found ' + found() + '.', pos);
      ws();
      const b = uint();
      if (!b) return failStatement('Expected the end of the range of multiplexor values, found ' + found() + '.', pos);
      spend(2);
      ranges.push({ lo: BigInt(a.text), hi: BigInt(b.text), start: a.start, end: b.end });
      ws();
      if (!expect(44)) break;
    }
    finish(kwStart);
    db.muxSpecs.push({ rawId: rawId, idStart: id.start, idEnd: id.end, signalName: sig.text, signalStart: sig.start, signalEnd: sig.end, switchName: sw.text, switchStart: sw.start, switchEnd: sw.end, ranges: ranges, start: kwStart, end: pos });
    return null;
  }

  function parseEnvVar(kwStart) {
    ws();
    const name = word();
    if (name) db.envVars.push({ name: name.text, start: name.start, end: name.end });
    recover();
    return kwStart;
  }

  // SGTYPE_ <name> : <size> @ <order> <sign> (<factor>,<offset>) [<min>|<max>] "<unit>" <default> , <value table> ;
  function parseSignalType(kwStart) {
    ws();
    const name = word();
    let depth = 0;
    let lastComma = -1;
    let inString = false;
    while (pos < n) {
      const c = src.charCodeAt(pos);
      if (inString) { if (c === 34) inString = false; pos++; continue; }
      if (c === 34) { inString = true; pos++; continue; }
      if (c === 40 || c === 91) depth++;
      else if (c === 41 || c === 93) depth = Math.max(0, depth - 1);
      else if (c === 44 && depth === 0) lastComma = pos;
      else if (c === 59) break;
      else if ((c === 10 || c === 13) && startsStatement(nextLineStart(pos))) break;
      pos++;
    }
    const end = pos;
    let table = null;
    if (lastComma !== -1) {
      const save = pos;
      pos = lastComma + 1;
      ws();
      const w = word();
      if (w && w.end <= end) table = w;
      pos = save;
    }
    if (pos < n && src.charCodeAt(pos) === 59) pos++;
    db.signalTypes.push({ name: name ? name.text : '', start: kwStart, end: pos, table: table ? { name: table.text, start: table.start, end: table.end } : null });
    return null;
  }

  // The key of a statement: its text with the white space collapsed, as a hash and a length.
  function statementKey(start, end) {
    return digest(src, start, Math.max(start, Math.min(end, n)), true);
  }

  // A statement that is read over without interpretation: kept as its text with the white space
  // collapsed (a hash for long ones), so that two databases can be compared statement by statement.
  // The statements are counted by key (keyword, then the text or, for a long one, its hash and
  // length), so that a million repeats of one statement cost one entry; at most UNCOMPARED_CAP
  // different statements are kept and `db.uncomparedCapped` says when more were seen.
  function noteUncompared(keyword, start, end) {
    spend(1);
    const key = keyword + '\u0000' + digest(src, start, Math.max(start, Math.min(end, n)));
    const had = db.uncompared.get(key);
    if (had !== undefined) db.uncompared.set(key, had + 1);
    else if (db.uncompared.size < UNCOMPARED_CAP) db.uncompared.set(key, 1);
    else db.uncomparedCapped = true;
  }

  // ---- main loop ------------------------------------------------------------------------------
  try {
    while (pos < n) {
      ws();
      if (pos >= n) break;
      const c = src.charCodeAt(pos);
      if (c === 59) { pos++; continue; }
      const kwStart = pos;
      const kw = word();
      if (!kw) {
        problem('DBC-SYNTAX', 'error', 'Unexpected "' + src[pos] + '" where a statement should start.', pos, pos + 1);
        const skippedFrom = pos;
        pos = nextStatement(pos + 1);
        noteUncompared('?', skippedFrom, pos);
        continue;
      }
      if (kw.text !== 'SG_') current = null;
      const keyedList = KEYED[kw.text] ? db[KEYED[kw.text]] : null;
      const keyedBefore = keyedList ? keyedList.length : 0;
      failed = false;
      partial = false;
      spend(kw.text === 'BO_' ? 6 : kw.text === 'SG_' ? 4 : 2);
      switch (kw.text) {
        case 'VERSION': {
          sp();
          const s = string(false);
          if (!s) failLine('Expected the version text in double quotes after VERSION.', pos);
          else {
            if (!s.ok) problem('DBC-STRING-UNTERMINATED', 'error', 'The version text has no closing double quote.', s.start, s.end);
            db.version = { text: s.text, start: kwStart, end: s.end };
            pos = lineEnd(pos);
          }
          break;
        }
        case 'NS_': parseNs(); break;
        case 'BS_': pos = lineEnd(pos); break;
        case 'BU_': parseNodes(kwStart); break;
        case 'VAL_TABLE_': parseValueTable(kwStart); break;
        case 'BO_': current = parseMessage(kwStart); break;
        case 'SG_': {
          const s = parseSignal(kwStart);
          if (!s) break;
          if (current) {
            s.index = current.signals.length;
            current.signals.push(s);
            current.end = s.end;
          } else {
            problem('DBC-SIGNAL-WITHOUT-MESSAGE', 'error', 'The signal "' + clip(s.name) + '" is not inside a message: a SG_ line must follow its BO_ line or another SG_ line of the same message.', s.nameStart, s.nameEnd);
            s.key = statementKey(kwStart, pos);
            db.orphanSignals.push(s);
          }
          break;
        }
        case 'BO_TX_BU_': parseTransmitters(kwStart); break;
        case 'CM_': parseComment(kwStart); break;
        case 'BA_DEF_': parseAttributeDef(kwStart); break;
        case 'BA_DEF_DEF_': parseAttributeDefault(kwStart); break;
        case 'BA_': parseAttribute(kwStart); break;
        case 'VAL_': parseValueDescription(kwStart); break;
        case 'SIG_VALTYPE_': parseValueType(kwStart); break;
        case 'SG_MUL_VAL_': parseMuxSpec(kwStart); break;
        case 'EV_': parseEnvVar(kwStart); break;
        case 'SGTYPE_': parseSignalType(kwStart); break;
        default:
          if (PASSED_OVER.has(kw.text)) { recover(); break; }
          problem('DBC-UNKNOWN-STATEMENT', 'warning', '"' + clip(kw.text) + '" is not a DBC statement keyword; the statement was skipped.', kw.start, kw.end);
          pos = nextStatement(kw.end);
      }
      if (failed && INTERPRETED.has(kw.text)) noteUncompared(kw.text + ' with a syntax error', kwStart, pos);
      else if (partial && INTERPRETED.has(kw.text)) noteUncompared(kw.text + ' with ignored entries', kwStart, pos);
      else if (!INTERPRETED.has(kw.text)) noteUncompared(kw.text, kwStart, pos);
      if (keyedList && keyedList.length === keyedBefore + 1) keyedList[keyedBefore].key = statementKey(kwStart, pos);
    }
  } catch (e) {
    if (e !== STOP) throw e;
    reading = false;
    db.readStoppedAt = Math.min(pos, n);
    problem('DBC-FILE-LIMIT', 'warning', 'The file holds more messages, signals and other statements than can be kept in memory (about ' + db.messages.length + ' messages and ' + db.messages.reduce(function (t, m) { return t + m.signals.length; }, 0) + ' signals were read). Reading stopped here; everything after this point is not checked and not shown. Split the database into several files.', db.readStoppedAt, db.readStoppedAt + 1);
  }
  link(db);
  return db;
}

// ---- linking: the later statements refer to nodes, messages and signals by name and ID ---------

function attributeTargetKey(kind, rawId, name) {
  if (kind === 'node') return 'BU_ ' + name;
  if (kind === 'message') return 'BO_ ' + rawId;
  if (kind === 'signal') return 'SG_ ' + rawId + ' ' + name;
  if (kind === 'envvar') return 'EV_ ' + name;
  return '';
}

function link(db) {
  db.nodeByName = new Map();
  for (const node of db.nodes) if (!db.nodeByName.has(node.name)) db.nodeByName.set(node.name, node);
  db.messageByRawId = new Map();
  db.messageByName = new Map();
  for (const m of db.messages) {
    if (!db.messageByRawId.has(m.rawId)) db.messageByRawId.set(m.rawId, m);
    if (!db.messageByName.has(m.name)) db.messageByName.set(m.name, m);
    m.signalIndex = new Map();
    for (const s of m.signals) if (!m.signalIndex.has(s.name)) m.signalIndex.set(s.name, s);
  }
  // Statements without effect: they refer to something that does not exist, repeat a definition
  // that an earlier one already made, or are replaced by a later statement. Their keys are kept so
  // that two databases that differ only there are not reported as identical.
  // Counted by key like db.uncompared (a million repeats of one statement cost one entry; at most UNCOMPARED_CAP different ones are kept).
  const ineffective = new Map();
  db.ineffective = ineffective;
  function lost(keyword, item) {
    if (!item || !item.key) return;
    const key = keyword + ' without effect\u0000' + item.key;
    const had = ineffective.get(key);
    if (had !== undefined) ineffective.set(key, had + 1);
    else if (ineffective.size < UNCOMPARED_CAP) ineffective.set(key, 1);
    else db.uncomparedCapped = true;
  }
  for (const s of db.orphanSignals) lost('SG_', s);

  db.valueTableByName = new Map();
  for (const t of db.valueTables) { if (!db.valueTableByName.has(t.name)) db.valueTableByName.set(t.name, t); else lost('VAL_TABLE_', t); }
  db.attributeDefByName = new Map();
  for (const d of db.attributeDefs) { if (!db.attributeDefByName.has(d.name)) db.attributeDefByName.set(d.name, d); else lost('BA_DEF_', d); }
  db.attributeDefaultByName = new Map();
  for (const d of db.attributeDefaults) { lost('BA_DEF_DEF_', db.attributeDefaultByName.get(d.name)); db.attributeDefaultByName.set(d.name, d); }
  db.envVarNames = new Set(db.envVars.map(function (e) { return e.name; }));

  function signalOf(rawId, name) {
    const m = db.messageByRawId.get(rawId);
    if (!m) return { message: null, signal: null };
    return { message: m, signal: m.signalIndex.get(name) || null };
  }

  for (const d of db.valueDescriptions) {
    const t = signalOf(d.rawId, d.signalName);
    d.unknown = !t.message ? 'message' : !t.signal ? 'signal' : '';
    if (t.signal) {
      if (t.signal.values) d.duplicate = true;
      else { t.signal.values = d.entries; t.signal.valuesStatement = d; }
    }
    if (d.unknown || d.duplicate) lost('VAL_', d);
  }
  const commentOf = new Map();
  function setComment(owner, c, apply) {
    lost('CM_', commentOf.get(owner));
    commentOf.set(owner, c);
    apply();
  }
  for (const c of db.comments) {
    const t = c.target;
    c.unknown = false;
    if (t.kind === 'file') setComment(db, c, function () { db.fileComment = c.text; });
    else if (t.kind === 'node') { const node = db.nodeByName.get(t.name); if (node) setComment(node, c, function () { node.comment = c.text; }); else { c.unknown = true; lost('CM_', c); } }
    else if (t.kind === 'message') { const m = db.messageByRawId.get(t.rawId); if (m) setComment(m, c, function () { m.comment = c.text; }); else { c.unknown = true; lost('CM_', c); } }
    else if (t.kind === 'signal') { const x = signalOf(t.rawId, t.name); if (x.signal) setComment(x.signal, c, function () { x.signal.comment = c.text; }); else { c.unknown = true; lost('CM_', c); } }
    else if (t.kind === 'envvar') { c.unknown = !db.envVarNames.has(t.name); lost('CM_', c); }
    else lost('CM_', c);
  }
  db.network = { attributes: null };
  for (const a of db.attributes) {
    const t = a.target;
    a.unknown = false;
    let obj = null;
    if (t.kind === 'network') obj = db.network;
    else if (t.kind === 'node') obj = db.nodeByName.get(t.name) || null;
    else if (t.kind === 'message') obj = db.messageByRawId.get(t.rawId) || null;
    else if (t.kind === 'signal') obj = signalOf(t.rawId, t.name).signal;
    else if (t.kind === 'envvar') obj = db.envVarNames.has(t.name) ? { attributes: null } : null;
    if (!obj) { a.unknown = true; lost('BA_', a); continue; }
    if (t.kind === 'envvar') lost('BA_', a);
    if (!obj.attributes) obj.attributes = new Map();
    lost('BA_', obj.attributes.get(a.name));
    obj.attributes.set(a.name, a);
  }
  const valueTypeOf = new Map();
  for (const v of db.valueTypes) {
    const x = signalOf(v.rawId, v.signalName);
    v.unknown = !x.signal;
    if (x.signal && (v.type === 1 || v.type === 2)) { lost('SIG_VALTYPE_', valueTypeOf.get(x.signal)); valueTypeOf.set(x.signal, v); x.signal.valueType = v.type; } else lost('SIG_VALTYPE_', v);
  }
  for (const s of db.muxSpecs) {
    const x = signalOf(s.rawId, s.signalName);
    s.unknown = !x.message ? 'message' : !x.signal ? 'signal' : '';
    if (x.signal) { if (x.signal.muxSpec) s.duplicate = true; else x.signal.muxSpec = s; }
    if (s.unknown || s.duplicate) lost('SG_MUL_VAL_', s);
  }
  for (const t of db.transmitters) {
    const m = db.messageByRawId.get(t.rawId);
    t.unknown = !m;
    if (m) for (const node of t.nodes) if (m.transmitters.indexOf(node.name) === -1) m.transmitters.push(node.name);
    if (!m) lost('BO_TX_BU_', t);
  }
}

/**
 * The value of an attribute for an object (a node, message, signal, or db.network for the
 * database itself), falling back to the default of its definition: { text, isString, number,
 * enumText, explicit } or null.
 * `number` is a JavaScript number for numeric values, `enumText` the name of an ENUM value.
 */
function attributeValue(db, obj, name) {
  let v = obj && obj.attributes ? obj.attributes.get(name) : undefined;
  let value = v ? v.value : null;
  if (!value) { const d = db.attributeDefaultByName ? db.attributeDefaultByName.get(name) : null; value = d ? d.value : null; }
  if (!value) return null;
  const def = db.attributeDefByName ? db.attributeDefByName.get(name) : null;
  const out = { text: value.text, isString: value.isString, number: null, enumText: null, explicit: !!v };
  if (!value.isString) { const num = Number(value.text); out.number = isFinite(num) ? num : null; }
  if (def && def.type === 'ENUM' && def.enumValues) {
    if (value.isString) out.enumText = def.enumValues.indexOf(value.text) !== -1 ? value.text : null;
    else if (out.number !== null && Number.isInteger(out.number) && out.number >= 0 && out.number < def.enumValues.length) out.enumText = def.enumValues[out.number];
  }
  return out;
}

/** The cycle time of a message in milliseconds (attribute GenMsgCycleTime, or CycleTime), or null. */
function cycleTimeOf(db, message) {
  for (const name of ['GenMsgCycleTime', 'CycleTime']) {
    const v = attributeValue(db, message, name);
    if (v && v.number !== null && v.number > 0) return v.number;
  }
  return null;
}

module.exports = { parseDbc: parseDbc, sourceFingerprint: sourceFingerprint, attributeValue: attributeValue, cycleTimeOf: cycleTimeOf, attributeTargetKey: attributeTargetKey, KEYWORDS: KEYWORDS, INDEPENDENT: INDEPENDENT, NO_NODE: NO_NODE, isIdentStart: isIdentStart, isIdentPart: isIdentPart };
