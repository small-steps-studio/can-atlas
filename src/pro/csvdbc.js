'use strict';
// Signal lists as CSV: signalsToCsv() writes one row per signal of a DBC database, csvToDbc()
// reads such a table (the same columns) and writes a clean DBC file from it.
//
// Columns: message_id, extended, message, dlc, sender, cycle_time_ms, signal, mux, start_bit,
// length, byte_order, sign, value_type, factor, offset, minimum, maximum, unit, receivers,
// values, comment, message_comment.
//
// Numbers are exact decimals (../dbc/decimal), never binary floats. A row that cannot be understood
// is refused with its line number and the other rows are still converted. Extended multiplexing
// (SG_MUL_VAL_) is not written: a signal keeps its simple multiplexer marker (M, m<value>,
// m<value>M) only. Environment variables, signal groups, relation attributes and value tables
// that no signal uses are not part of a signal list and are not written.

const D = require('../dbc/decimal');
const B = require('../dbc/bits');
const P = require('../dbc/parse');
const U = require('../util');

const COLUMNS = ['message_id', 'extended', 'message', 'dlc', 'sender', 'cycle_time_ms', 'signal', 'mux', 'start_bit', 'length', 'byte_order', 'sign', 'value_type',
  'factor', 'offset', 'minimum', 'maximum', 'unit', 'receivers', 'values', 'comment', 'message_comment'];

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_CYCLE_MS = 3600000;
const NS_BLOCK = ['NS_ :', '\tNS_DESC_', '\tCM_', '\tBA_DEF_', '\tBA_', '\tVAL_', '\tBA_DEF_DEF_', '\tVAL_TABLE_', '\tSIG_VALTYPE_', '\tBO_TX_BU_', '\tSG_MUL_VAL_', ''];

// ---- export -----------------------------------------------------------------------------------

function decimalText(text) {
  const d = D.cached(text);
  return d ? D.toString(d) : String(text);
}

/** The value descriptions of a signal as one cell: raw=text pairs separated by ";", with \ and ; escaped by a backslash. */
function valuesCell(values) {
  return values.map(function (e) { return e.value.toString() + '=' + e.text.replace(/\\/g, '\\\\').replace(/;/g, '\\;'); }).join(';');
}

/**
 * The signals of a database as CSV text (RFC 4180, CRLF line ends), one row per signal in file
 * order; a message without signals gets one row with empty signal columns. Options: neutralise
 * (default true): a cell that starts with = + - @ tab or CR gets a leading apostrophe, plain
 * numbers excepted.
 */
function signalsToCsv(db, options) {
  const neutralise = !(options && options.neutralise === false);
  const out = [U.csvRow(COLUMNS, false)];
  for (const m of db.messages) {
    if (m.pseudo) continue;
    const cycle = P.cycleTimeOf(db, m);
    const head = [isFinite(m.frameId) ? '0x' + m.frameId.toString(16).toUpperCase() : m.idText, m.extended ? 'TRUE' : 'FALSE', m.name, String(m.size), m.sender, cycle === null ? '' : String(cycle)];
    if (!m.signals.length) {
      out.push(U.csvRow(head.concat(new Array(COLUMNS.length - head.length - 1).fill(''), [m.comment || '']), neutralise));
      continue;
    }
    for (const s of m.signals) {
      out.push(U.csvRow(head.concat([
        s.name, s.muxText || '', String(s.startBit), String(s.length), s.little ? 'intel' : 'motorola', s.signed ? 'signed' : 'unsigned',
        s.valueType === 1 ? 'float32' : s.valueType === 2 ? 'float64' : 'integer',
        decimalText(s.factorText), decimalText(s.offsetText), decimalText(s.minText), decimalText(s.maxText), s.unit, s.receivers.join(';'),
        s.values ? valuesCell(s.values) : '', s.comment || '', m.comment || ''
      ]), neutralise));
    }
  }
  return out.join('');
}

// ---- reading CSV with line numbers -------------------------------------------------------------

function detectDelimiter(src) {
  let i = src.charCodeAt(0) === 0xFEFF ? 1 : 0;
  const n = src.length;
  while (i < n && (src[i] === '\r' || src[i] === '\n')) i++;
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (; i < n; i++) {
    const c = src[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && counts[c] !== undefined) counts[c]++;
  }
  let best = ',';
  for (const d of [';', '\t']) if (counts[d] > counts[best]) best = d;
  return best;
}

/** Rows of cells with the line on which each row starts. A quoted cell that is never closed is reported in `problems`. */
function readCsv(src, delimiter, problems) {
  const rows = [];
  const n = src.length;
  let i = src.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let line = 1;
  let rowLine = 1;
  let quoteLine = 0;
  let quoted = false;
  let row = [];
  let cell = '';
  while (i < n) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      if (c === '\n' || (c === '\r' && src[i + 1] !== '\n')) line++;
      cell += c; i++; continue;
    }
    if (row.length === 0 && cell === '') rowLine = line;
    if (c === '"' && cell === '') { quoted = true; quoteLine = line; i++; continue; }
    if (c === delimiter) { row.push(cell); cell = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(cell); cell = '';
      if (!(row.length === 1 && row[0] === '')) rows.push({ line: rowLine, cells: row });
      row = [];
      if (c === '\r' && src[i + 1] === '\n') i++;
      i++; line++;
      continue;
    }
    cell += c; i++;
  }
  if (quoted) problems.push({ line: quoteLine, refused: true, message: 'A quoted cell that starts here is never closed, so this row and everything after it was not read.' });
  else if (cell !== '' || row.length) { row.push(cell); if (!(row.length === 1 && row[0] === '')) rows.push({ line: rowLine, cells: row }); }
  return rows;
}

// ---- cell parsers -----------------------------------------------------------------------------

function headerKey(text) { return String(text).replace(/^﻿/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }

function parseId(text) {
  const t = text.trim();
  const hex = /^0[xX]([0-9A-Fa-f]{1,8})$/.exec(t);
  if (hex) return parseInt(hex[1], 16);
  if (/^\d{1,10}$/.test(t)) return Number(t);
  return null;
}

/** true, false, or null when the text is not a yes/no word. */
function parseExtended(text) {
  const t = text.trim().toLowerCase();
  if (t === 'true' || t === '1' || t === 'yes' || t === 'y' || t === 'extended' || t === 'ext' || t === '29') return true;
  if (t === 'false' || t === '0' || t === 'no' || t === 'n' || t === 'standard' || t === 'std' || t === '11') return false;
  return null;
}

function parseByteOrder(text) {
  const t = text.trim().toLowerCase();
  if (['intel', 'little', 'little-endian', 'little_endian', 'le', '1', '@1'].indexOf(t) !== -1) return true;
  if (['motorola', 'big', 'big-endian', 'big_endian', 'be', '0', '@0'].indexOf(t) !== -1) return false;
  return null;
}

function parseSign(text) {
  const t = text.trim().toLowerCase();
  if (['unsigned', 'u', '+', 'uint'].indexOf(t) !== -1) return false;
  if (['signed', 's', '-', 'int'].indexOf(t) !== -1) return true;
  return null;
}

/** 0 integer, 1 32-bit float, 2 64-bit float, 3 "float" (decided by the length), or null. */
function parseValueType(text) {
  const t = text.trim().toLowerCase();
  if (['', 'integer', 'int', '0'].indexOf(t) !== -1) return 0;
  if (['float32', 'float-32', 'single', '1'].indexOf(t) !== -1) return 1;
  if (['float64', 'float-64', 'double', '2'].indexOf(t) !== -1) return 2;
  if (t === 'float') return 3;
  return null;
}

function parseMux(text) {
  const t = text.trim();
  if (t === '' || t === 'M') return t;
  return /^m\d{1,18}M?$/.test(t) ? t : null;
}

/** The list of value descriptions in a values cell: [{ raw: BigInt, text }] or { error }. */
function parseValues(cell) {
  const out = [];
  const seen = new Set();
  if (cell.trim() === '') return out;
  const entries = [];
  let cur = '';
  for (let i = 0; i < cell.length; i++) {
    const c = cell[i];
    if (c === '\\' && i + 1 < cell.length && (cell[i + 1] === '\\' || cell[i + 1] === ';')) { cur += c + cell[i + 1]; i++; }
    else if (c === ';') { entries.push(cur); cur = ''; }
    else cur += c;
  }
  entries.push(cur);
  for (const e of entries) {
    if (e.trim() === '') continue;
    const eq = e.indexOf('=');
    if (eq < 1) return { error: 'The values cell has the entry "' + U.shorten(e, 30) + '" without "raw=text".' };
    const rawText = e.slice(0, eq).trim();
    if (!/^-?\d{1,30}$/.test(rawText)) return { error: 'The raw value "' + U.shorten(rawText, 30) + '" in the values cell is not a whole number.' };
    const raw = BigInt(rawText);
    if (seen.has(raw.toString())) return { error: 'The raw value ' + raw + ' is described twice in the values cell.' };
    seen.add(raw.toString());
    out.push({ raw: raw, text: e.slice(eq + 1).replace(/\\([\\;])/g, '$1') });
  }
  return out;
}

// ---- writing the DBC ----------------------------------------------------------------------------

function dbcString(text) { return '"' + String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
function oneLine(text) { return String(text).replace(/\r\n|\r|\n/g, ' '); }

// A line of a multi-line comment that looks like the start of a statement would end the comment
// when the file is read again; such a line is joined to the one before it.
const STATEMENT_LINES = [/^(BO_|BO_TX_BU_|VAL_|SIG_VALTYPE_|SG_MUL_VAL_)[ \t]+\d/, /^(CM_|BA_|BA_DEF_|BA_DEF_DEF_)[ \t]+("|BU_|BO_|SG_|EV_)/, /^(VAL_TABLE_|BU_|EV_)[ \t]*[:A-Za-z_]/,
  /^SG_[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]*(M[ \t]+|m\d+M?[ \t]+)?:/];

function commentText(text) {
  const lines = String(text).replace(/\r\n|\r/g, '\n').split('\n');
  let out = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].replace(/^[ \t]+/, '');
    out += (STATEMENT_LINES.some(function (re) { return re.test(t); }) ? ' ' : '\n') + lines[i];
  }
  return out;
}

function rawIdOf(m) { return m.extended ? m.frameId + 0x80000000 : m.frameId; }

function writeDbc(messages, nodes, options) {
  const lines = ['VERSION ' + dbcString(oneLine((options && options.version) || '')), '', ''].concat(NS_BLOCK);
  lines.push('BS_:', '', 'BU_:' + (nodes.length ? ' ' + nodes.join(' ') : ''), '');
  const list = Array.from(messages.values());
  for (const m of list) {
    lines.push('BO_ ' + rawIdOf(m) + ' ' + m.name + ': ' + m.size + ' ' + m.sender);
    for (const s of m.signals) {
      lines.push(' SG_ ' + s.name + (s.mux ? ' ' + s.mux : '') + ' : ' + s.start + '|' + s.length + '@' + (s.little ? '1' : '0') + (s.signed ? '-' : '+') +
        ' (' + D.toString(s.factor) + ',' + D.toString(s.offset) + ') [' + D.toString(s.min) + '|' + D.toString(s.max) + '] ' + dbcString(oneLine(s.unit)) + ' ' + (s.receivers.length ? s.receivers.join(',') : P.NO_NODE));
    }
    lines.push('');
  }
  lines.push('');
  for (const m of list) {
    if (m.comment) lines.push('CM_ BO_ ' + rawIdOf(m) + ' ' + dbcString(commentText(m.comment)) + ';');
    for (const s of m.signals) if (s.comment) lines.push('CM_ SG_ ' + rawIdOf(m) + ' ' + s.name + ' ' + dbcString(commentText(s.comment)) + ';');
  }
  const timed = list.filter(function (m) { return m.cycle !== null && !D.isZero(m.cycle); });
  if (timed.length) {
    const whole = timed.every(function (m) { return D.isInteger(m.cycle) && D.cmp(m.cycle, D.fromBigInt(65535n)) <= 0; });
    lines.push(whole ? 'BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;' : 'BA_DEF_ BO_ "GenMsgCycleTime" FLOAT 0 ' + MAX_CYCLE_MS + ';', 'BA_DEF_DEF_ "GenMsgCycleTime" 0;');
    for (const m of timed) lines.push('BA_ "GenMsgCycleTime" BO_ ' + rawIdOf(m) + ' ' + D.toString(m.cycle) + ';');
  }
  for (const m of list) {
    for (const s of m.signals) {
      if (s.values.length) lines.push('VAL_ ' + rawIdOf(m) + ' ' + s.name + ' ' + s.values.map(function (v) { return v.raw + ' ' + dbcString(oneLine(v.text)); }).join(' ') + ' ;');
    }
  }
  for (const m of list) for (const s of m.signals) if (s.vt) lines.push('SIG_VALTYPE_ ' + rawIdOf(m) + ' ' + s.name + ' : ' + s.vt + ';');
  return lines.join('\n') + '\n';
}

// ---- import -----------------------------------------------------------------------------------

/**
 * Reads a signal table and writes a DBC file. Returns { dbc, problems, messages, signals } where
 * problems are { line, message, refused } (refused: the row was not used; false: a warning, the
 * row was used). Options: delimiter (default: detected from the header line), version (text for
 * the VERSION line), unneutralise (default true: the apostrophe that the export puts before a
 * cell that starts with = + - @ is removed).
 */
function csvToDbc(text, options) {
  const opts = options || {};
  const problems = [];
  const src = String(text === undefined || text === null ? '' : text);
  const rows = readCsv(src, opts.delimiter || detectDelimiter(src), problems);
  const result = function (dbc, messages, signals) { return { dbc: dbc, problems: problems, messages: messages, signals: signals }; };
  if (!rows.length) { problems.push({ line: 1, refused: true, message: 'The file has no rows. The first row must name the columns (message_id and message are required).' }); return result('', 0, 0); }
  const head = new Map();
  rows[0].cells.forEach(function (h, i) { const k = headerKey(h); if (k && !head.has(k)) head.set(k, i); });
  for (const need of ['message_id', 'message']) {
    if (!head.has(need)) { problems.push({ line: rows[0].line, refused: true, message: 'The header row has no column "' + need + '". Columns found: ' + U.shorten(rows[0].cells.join(', '), 120) + '.' }); return result('', 0, 0); }
  }
  const hasSignal = head.has('signal');
  const unneutralise = opts.unneutralise !== false;
  const registry = new Map();
  const names = new Map();
  const nodes = [];
  const nodeSet = new Set();
  let signalCount = 0;

  function addNode(n) { if (n !== P.NO_NODE && !nodeSet.has(n)) { nodeSet.add(n); nodes.push(n); } }
  function validName(n) { return NAME.test(n) && !P.KEYWORDS.has(n) && n !== P.INDEPENDENT; }

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const refuse = function (message) { problems.push({ line: row.line, refused: true, message: message }); };
    if (row.cells.length > rows[0].cells.length) { refuse('The row has ' + row.cells.length + ' cells but the header has ' + rows[0].cells.length + '. A comma inside a text must be in double quotes.'); continue; }
    const get = function (key, keep) {
      const i = head.get(key);
      if (i === undefined || i >= row.cells.length) return '';
      const v = unneutralise ? U.unneutralise(row.cells[i]) : row.cells[i];
      return keep ? v : v.trim();
    };

    // The message.
    const idNumber = parseId(get('message_id'));
    if (idNumber === null) { refuse('The message_id "' + U.shorten(get('message_id'), 30) + '" is not an ID: write 0x123 or a decimal number.'); continue; }
    const extText = get('extended');
    let extended;
    if (extText === '') extended = idNumber > 0x7FF;
    else {
      extended = parseExtended(extText);
      if (extended === null) { refuse('The extended cell "' + U.shorten(extText, 20) + '" is not TRUE or FALSE.'); continue; }
    }
    if (!extended && idNumber > 0x7FF) { refuse('The ID 0x' + idNumber.toString(16).toUpperCase() + ' does not fit into the 11 bits of a standard frame; set extended to TRUE.'); continue; }
    if (idNumber > 0x1FFFFFFF) { refuse('The ID 0x' + idNumber.toString(16).toUpperCase() + ' does not fit into the 29 bits of an extended frame. Write the frame ID without the extended flag bit.'); continue; }
    const mname = get('message');
    if (!validName(mname)) { refuse('The message name "' + U.shorten(mname, 40) + '" is not a valid DBC name: use letters, digits and "_", not starting with a digit.'); continue; }
    const key = (extended ? 'x' : 's') + idNumber;
    const known = registry.get(key);
    const owner = names.get(mname);
    if (known && known.name !== mname) { refuse('The ID 0x' + idNumber.toString(16).toUpperCase() + ' is already used by the message ' + known.name + '.'); continue; }
    if (!known && owner !== undefined) { refuse('The message name ' + mname + ' is already used by another ID.'); continue; }
    const dlcText = get('dlc');
    let size = known ? known.size : 8;
    if (dlcText !== '') {
      if (!/^\d{1,3}$/.test(dlcText) || !B.isFrameLength(Number(dlcText))) { refuse('The dlc "' + U.shorten(dlcText, 20) + '" is not a data length: 0 to 8, or 12, 16, 20, 24, 32, 48 or 64.'); continue; }
      if (known && known.size !== Number(dlcText)) { refuse('The dlc ' + dlcText + ' differs from the data length ' + known.size + ' of the other rows of ' + mname + '.'); continue; }
      size = Number(dlcText);
    }
    const senderText = get('sender');
    let sender = known ? known.sender : P.NO_NODE;
    if (senderText !== '') {
      if (!validName(senderText)) { refuse('The sender "' + U.shorten(senderText, 40) + '" is not a valid node name.'); continue; }
      if (known && known.sender !== P.NO_NODE && known.sender !== senderText) { refuse('The sender ' + senderText + ' differs from the sender ' + known.sender + ' of the other rows of ' + mname + '.'); continue; }
      sender = senderText;
    }
    const cycleText = get('cycle_time_ms');
    let cycle = known ? known.cycle : null;
    if (cycleText !== '') {
      const c = D.parse(cycleText);
      if (!c || c.n < 0n || D.cmp(c, D.fromBigInt(BigInt(MAX_CYCLE_MS))) > 0) { refuse('The cycle_time_ms "' + U.shorten(cycleText, 20) + '" is not a number from 0 to ' + MAX_CYCLE_MS + '.'); continue; }
      if (known && known.cycle !== null && D.cmp(known.cycle, c) !== 0) { refuse('The cycle_time_ms ' + cycleText + ' differs from the cycle time of the other rows of ' + mname + '.'); continue; }
      cycle = c;
    }

    // The signal (a row without a signal name only defines the message).
    const sname = hasSignal ? get('signal') : '';
    let signal = null;
    if (sname !== '') {
      if (!validName(sname)) { refuse('The signal name "' + U.shorten(sname, 40) + '" is not a valid DBC name: use letters, digits and "_", not starting with a digit.'); continue; }
      if (known && known.signalNames.has(sname)) { refuse('The message ' + mname + ' already has a signal named ' + sname + '.'); continue; }
      const mux = parseMux(get('mux'));
      if (mux === null) { refuse('The mux cell "' + U.shorten(get('mux'), 20) + '" is not empty, M, m<number> or m<number>M.'); continue; }
      const startText = get('start_bit');
      const lengthText = get('length');
      if (!/^\d{1,4}$/.test(startText)) { refuse('The start_bit "' + U.shorten(startText, 20) + '" of ' + sname + ' is not a whole number.'); continue; }
      if (!/^\d{1,3}$/.test(lengthText) || Number(lengthText) < 1 || Number(lengthText) > 64) { refuse('The length "' + U.shorten(lengthText, 20) + '" of ' + sname + ' is not a number of bits from 1 to 64.'); continue; }
      const orderText = get('byte_order');
      const little = orderText === '' ? true : parseByteOrder(orderText);
      if (little === null) { refuse('The byte_order "' + U.shorten(orderText, 20) + '" of ' + sname + ' is not intel or motorola.'); continue; }
      const signText = get('sign');
      const signed = signText === '' ? false : parseSign(signText);
      if (signed === null) { refuse('The sign "' + U.shorten(signText, 20) + '" of ' + sname + ' is not signed or unsigned.'); continue; }
      let vt = parseValueType(get('value_type'));
      if (vt === null) { refuse('The value_type "' + U.shorten(get('value_type'), 20) + '" of ' + sname + ' is not integer, float32 or float64.'); continue; }
      const length = Number(lengthText);
      if (vt === 3) vt = length === 32 ? 1 : length === 64 ? 2 : null;
      if (vt === null) { refuse('The value_type float of ' + sname + ' needs a length of 32 or 64 bits.'); continue; }
      if ((vt === 1 && length !== 32) || (vt === 2 && length !== 64)) { refuse('The ' + (vt === 1 ? '32-bit' : '64-bit') + ' float ' + sname + ' needs a length of ' + (vt === 1 ? 32 : 64) + ' bits, not ' + length + '.'); continue; }
      const layout = B.layoutOf(Number(startText), length, little);
      if (!layout || layout.bytes > size) { refuse('The signal ' + sname + ' (start bit ' + startText + ', ' + length + ' bits, ' + (little ? 'intel' : 'motorola') + ') does not fit into the ' + size + ' data bytes of ' + mname + '.'); continue; }
      const numbers = {};
      let bad = false;
      for (const [col, def] of [['factor', '1'], ['offset', '0'], ['minimum', '0'], ['maximum', '0']]) {
        const t = get(col);
        const d = D.parse(t === '' ? def : t);
        if (!d) {
          refuse('The ' + col + ' "' + U.shorten(t, 30) + '" of ' + sname + ' is not a number' + (/^[+-]?\d*,\d+$/.test(t) ? ' (write a point, not a comma, as the decimal separator)' : '') + '.');
          bad = true;
          break;
        }
        numbers[col] = d;
      }
      if (bad) continue;
      const receivers = get('receivers').split(/[;,\s]+/).filter(Boolean);
      const badReceiver = receivers.find(function (n) { return !validName(n); });
      if (badReceiver !== undefined) { refuse('The receiver "' + U.shorten(badReceiver, 40) + '" of ' + sname + ' is not a valid node name.'); continue; }
      const values = parseValues(get('values', true));
      if (values.error) { refuse(values.error); continue; }
      if (D.isZero(numbers.factor)) problems.push({ line: row.line, refused: false, message: 'The factor of ' + sname + ' is 0, so every raw value gives the same physical value.' });
      if (D.cmp(numbers.minimum, numbers.maximum) > 0) problems.push({ line: row.line, refused: false, message: 'The minimum of ' + sname + ' is greater than its maximum.' });
      signal = {
        name: sname, mux: mux, start: Number(startText), length: length, little: little, signed: signed, vt: vt, factor: numbers.factor, offset: numbers.offset,
        min: numbers.minimum, max: numbers.maximum, unit: get('unit', true), receivers: receivers, values: values, comment: get('comment', true)
      };
    }

    // Commit the row.
    let msg = known;
    if (!msg) {
      msg = { name: mname, extended: extended, frameId: idNumber, size: size, sender: sender, cycle: cycle, comment: '', signals: [], signalNames: new Set() };
      registry.set(key, msg);
      names.set(mname, key);
    } else { msg.sender = sender; msg.cycle = cycle; }
    if (!msg.comment) msg.comment = get('message_comment', true);
    addNode(msg.sender);
    if (signal) {
      msg.signals.push(signal);
      msg.signalNames.add(signal.name);
      for (const n of signal.receivers) addNode(n);
      signalCount++;
    }
  }
  if (!registry.size) return result('', 0, 0);
  return result(writeDbc(registry, nodes, opts), registry.size, signalCount);
}

module.exports = { signalsToCsv: signalsToCsv, csvToDbc: csvToDbc, COLUMNS: COLUMNS, valuesCell: valuesCell };
