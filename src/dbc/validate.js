'use strict';
// Checks of a DBC database. Every problem has a stable code (documented in docs/problems.md), a
// severity, a message that says what was found and what to do, and the text range it refers to.

const D = require('./decimal');
const B = require('./bits');
const P = require('./parse');
const M = require('./mux');

const CODES = Object.freeze({
  'DBC-SYNTAX': 'error',
  'DBC-SEMICOLON': 'warning',
  'DBC-STRING-UNTERMINATED': 'error',
  'DBC-UNKNOWN-STATEMENT': 'warning',
  'DBC-NUMBER': 'error',
  'DBC-VALUE-NOT-WHOLE': 'warning',
  'DBC-ENCODING': 'warning',
  'DBC-NAME-INVALID': 'error',
  'DBC-NAME-LONG': 'info',
  'DBC-NAME-CASE': 'warning',
  'DBC-NODE-DUPLICATE': 'warning',
  'DBC-MESSAGE-ID-DUPLICATE': 'error',
  'DBC-MESSAGE-NAME-DUPLICATE': 'error',
  'DBC-MESSAGE-ID-RANGE': 'error',
  'DBC-MESSAGE-EXTENDED-FLAG': 'warning',
  'DBC-MESSAGE-FRAME-FORMAT': 'warning',
  'DBC-MESSAGE-DLC': 'error',
  'DBC-MESSAGE-DLC-FD': 'warning',
  'DBC-MESSAGE-NO-SIGNALS': 'info',
  'DBC-SENDER-UNKNOWN': 'warning',
  'DBC-RECEIVER-UNKNOWN': 'warning',
  'DBC-SIGNAL-NO-RECEIVER': 'info',
  'DBC-SIGNAL-NAME-DUPLICATE': 'error',
  'DBC-SIGNAL-WITHOUT-MESSAGE': 'error',
  'DBC-SIGNAL-LENGTH': 'error',
  'DBC-SIGNAL-OUTSIDE-FRAME': 'error',
  'DBC-SIGNAL-OVERLAP': 'error',
  'DBC-FACTOR-ZERO': 'error',
  'DBC-RANGE-INVERTED': 'error',
  'DBC-RANGE-OUTSIDE-RAW': 'warning',
  'DBC-VALUE-OUTSIDE-RAW': 'warning',
  'DBC-VAL-UNKNOWN-MESSAGE': 'warning',
  'DBC-VAL-UNKNOWN-SIGNAL': 'warning',
  'DBC-VAL-DUPLICATE': 'warning',
  'DBC-VALUE-TABLE-MISSING': 'warning',
  'DBC-VALUE-TABLE-UNUSED': 'info',
  'DBC-VALUE-TABLE-DUPLICATE': 'warning',
  'DBC-VALTYPE-INVALID': 'error',
  'DBC-VALTYPE-UNKNOWN': 'warning',
  'DBC-MUX-NO-MULTIPLEXOR': 'error',
  'DBC-MUX-AMBIGUOUS': 'error',
  'DBC-MUX-VALUE-RANGE': 'warning',
  'DBC-MUX-SWITCH-FLOAT': 'error',
  'DBC-MUX-UNUSED': 'info',
  'DBC-MUX-NOT-MULTIPLEXED': 'warning',
  'DBC-MUX-EXTENDED-UNKNOWN': 'warning',
  'DBC-MUX-EXTENDED-RANGE': 'error',
  'DBC-MUX-EXTENDED-MISMATCH': 'warning',
  'DBC-MUX-EXTENDED-DUPLICATE': 'warning',
  'DBC-MUX-CYCLE': 'error',
  'DBC-MUX-TOO-DEEP': 'error',
  'DBC-CHECK-LIMIT': 'info',
  'DBC-FILE-LIMIT': 'warning',
  'DBC-COMMENT-UNKNOWN': 'warning',
  'DBC-ATTRIBUTE-UNDEFINED': 'warning',
  'DBC-ATTRIBUTE-UNKNOWN-OBJECT': 'warning',
  'DBC-ATTRIBUTE-VALUE': 'warning',
  'DBC-ATTRIBUTE-OBJECT-TYPE': 'warning',
  'DBC-ATTRIBUTE-DUPLICATE-DEF': 'warning',
  'DBC-TRANSMITTER-UNKNOWN-MESSAGE': 'warning',
  'DBC-LIST-CUT': 'info'
});

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_NAME = 32;
// Upper limits for the overlap check: comparisons per message and for the whole database.
const OVERLAP_BUDGET = 2000000;
const TOTAL_OVERLAP_BUDGET = 20000000;
const OBJECT_KIND = { '': 'network', BU_: 'node', BO_: 'message', SG_: 'signal', EV_: 'envvar' };
const KIND_WORD = { network: 'the database', node: 'a node', message: 'a message', signal: 'a signal', envvar: 'an environment variable' };

function hex(n) { return '0x' + n.toString(16).toUpperCase(); }
function clip(s) { const t = String(s); return t.length > 40 ? t.slice(0, 39) + '…' : t; }

/** The ID of a message in words, for example "0x123" or "0x18FEF100 (extended)". */
function idText(m) {
  if (!isFinite(m.rawId)) return m.idText;
  return hex(m.frameId) + (m.extended ? ' (extended)' : '');
}

/** The physical range a raw value of the signal can express: { lo, hi } decimals, or null. */
function representable(signal, factor, offset) {
  if (!(signal.length >= 1 && signal.length <= 64) || signal.valueType !== 0 || !factor || !offset || D.isZero(factor)) return null;
  const r = B.rawRange(signal.length, signal.signed);
  const a = D.add(D.mul(D.fromBigInt(r.lo), factor), offset);
  const b = D.add(D.mul(D.fromBigInt(r.hi), factor), offset);
  return D.cmp(a, b) <= 0 ? { lo: a, hi: b } : { lo: b, hi: a };
}

/** A text that is equal for two lists of value descriptions exactly when they describe the same values. */
function entriesSignature(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.value.toString(), e.text);
  return Array.from(m.keys()).sort().map(function (k) { return k + '=' + m.get(k); }).join('\u0001');
}

function sameEntries(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const m = new Map(a.map(function (e) { return [e.value.toString(), e.text]; }));
  return b.every(function (e) { return m.get(e.value.toString()) === e.text; });
}

/**
 * Runs every check. Options: maxProblems (default 1000), disabledCodes (codes to leave out),
 * text (the document text, for the encoding check). Returns { problems, counts, dropped }.
 */
function validate(db, options) {
  const opts = options || {};
  const maxProblems = Math.max(1, opts.maxProblems || 1000);
  const disabled = new Set(opts.disabledCodes || []);
  const problems = [];
  const counts = { error: 0, warning: 0, info: 0 };
  let dropped = 0;
  let overlapBudgetLeft = TOTAL_OVERLAP_BUDGET;
  function add(code, message, start, end) {
    if (disabled.has(code)) return;
    const severity = CODES[code];
    counts[severity]++;
    if (problems.length >= maxProblems) { dropped++; return; }
    const s = Math.max(0, start | 0);
    problems.push({ code: code, severity: severity, message: message, start: s, end: Math.max(s, end | 0) });
  }
  function checkName(name, what, start, end) {
    if (!NAME.test(name) || P.KEYWORDS.has(name)) add('DBC-NAME-INVALID', 'The ' + what + ' name "' + clip(name) + '" is not a valid DBC name: use letters, digits and "_", not starting with a digit, and not a DBC keyword.', start, end);
    else if (name.length > MAX_NAME) add('DBC-NAME-LONG', 'The ' + what + ' name "' + clip(name) + '" has ' + name.length + ' characters; several CAN tools accept at most ' + MAX_NAME + '.', start, end);
  }
  function caseCollisions(items, what) {
    const seen = new Map();
    for (const it of items) {
      const k = it.name.toLowerCase();
      const first = seen.get(k);
      if (first === undefined) seen.set(k, it);
      else if (first.name !== it.name) add('DBC-NAME-CASE', 'The ' + what + ' names "' + clip(first.name) + '" and "' + clip(it.name) + '" differ only in upper and lower case; tools that ignore case treat them as the same name.', it.start, it.end);
    }
  }

  for (const p of db.problems) add(p.code, p.message, p.start, p.end);
  {
    // opts.replacementAt: offset of the first U+FFFD (the editor looked it up already), or opts.text.
    const bad = typeof opts.replacementAt === 'number' ? opts.replacementAt : typeof opts.text === 'string' ? opts.text.indexOf('�') : -1;
    if (bad !== -1) add('DBC-ENCODING', 'The file contains characters that could not be read with the current encoding (shown as �). DBC files are often saved as Windows-1252: reopen the file with that encoding (Reopen with Encoding, Western) before saving it.', bad, bad + 1);
  }

  // ---- nodes ---------------------------------------------------------------------------------
  const nodeNames = new Set();
  for (const node of db.nodes) {
    if (nodeNames.has(node.name)) add('DBC-NODE-DUPLICATE', 'The node "' + clip(node.name) + '" is listed twice in BU_.', node.start, node.end);
    nodeNames.add(node.name);
    checkName(node.name, 'node', node.start, node.end);
  }
  caseCollisions(db.nodes, 'node');
  function knownNode(name) { return name === P.NO_NODE || nodeNames.has(name); }

  // ---- value tables ----------------------------------------------------------------------------
  const tableNames = new Set();
  for (const t of db.valueTables) {
    if (tableNames.has(t.name)) add('DBC-VALUE-TABLE-DUPLICATE', 'The value table "' + clip(t.name) + '" is defined twice; only the first definition is used.', t.nameStart, t.nameEnd);
    tableNames.add(t.name);
    checkName(t.name, 'value table', t.nameStart, t.nameEnd);
    duplicateValues(t.entries, 'value table "' + clip(t.name) + '"');
  }
  function duplicateValues(entries, where) {
    const seen = new Set();
    for (const e of entries) {
      const k = e.value.toString();
      if (seen.has(k)) add('DBC-VAL-DUPLICATE', 'The raw value ' + k + ' is described twice in the ' + where + '; only the first description is used.', e.start, e.end);
      seen.add(k);
    }
  }

  // ---- messages and signals --------------------------------------------------------------------
  const byRawId = new Map();
  const byName = new Map();
  const messageList = [];
  for (const m of db.messages) {
    if (m.pseudo) continue;
    messageList.push(m);
    checkName(m.name, 'message', m.nameStart, m.nameEnd);
    const idKey = isFinite(m.rawId) ? m.rawId : 'text:' + m.idText;
    const firstId = byRawId.get(idKey);
    if (firstId) add('DBC-MESSAGE-ID-DUPLICATE', 'The ID ' + idText(m) + ' is already used by the message "' + clip(firstId.name) + '"; every message needs its own ID.', m.idStart, m.idEnd);
    else byRawId.set(idKey, m);
    const firstName = byName.get(m.name);
    if (firstName) add('DBC-MESSAGE-NAME-DUPLICATE', 'The message name "' + clip(m.name) + '" is already used by the message with the ID ' + idText(firstName) + '.', m.nameStart, m.nameEnd);
    else byName.set(m.name, m);

    if (!isFinite(m.rawId) || m.rawId > 0xFFFFFFFF) add('DBC-MESSAGE-ID-RANGE', 'The ID ' + clip(m.idText) + ' is larger than the 32 bits a DBC message ID can have.', m.idStart, m.idEnd);
    else if (m.extended && m.frameId > 0x1FFFFFFF) add('DBC-MESSAGE-ID-RANGE', 'The ID ' + m.idText + ' has the extended-frame flag (bit 31) set, but the remaining value ' + hex(m.frameId) + ' does not fit into the 29 bits of an extended identifier.', m.idStart, m.idEnd);
    else if (!m.extended && m.rawId > 0x7FF) add('DBC-MESSAGE-EXTENDED-FLAG', 'The ID ' + m.idText + ' (' + hex(m.rawId) + ') does not fit into the 11 bits of a standard identifier, but bit 31 (the extended-frame flag of DBC files) is not set.' + (m.rawId <= 0x1FFFFFFF ? ' For an extended frame write ' + (m.rawId + 0x80000000) + ' (2147483648 + ' + m.rawId + ').' : ' The ID does not fit into the 29 bits of an extended identifier either.'), m.idStart, m.idEnd);
    const ff = P.attributeValue(db, m, 'VFrameFormat');
    if (ff && ff.explicit && ff.enumText && isFinite(m.rawId)) {
      const wantsExtended = /extended|j1939/i.test(ff.enumText);
      const wantsStandard = /standard/i.test(ff.enumText);
      if ((wantsExtended && !m.extended) || (wantsStandard && m.extended)) {
        const a = m.attributes.get('VFrameFormat');
        add('DBC-MESSAGE-FRAME-FORMAT', 'The attribute VFrameFormat says ' + ff.enumText + ', but the ID ' + m.idText + ' is written as ' + (m.extended ? 'an extended' : 'a standard') + ' frame (bit 31 ' + (m.extended ? 'set' : 'not set') + '). Make the two agree.', a.start, a.end);
      }
    }
    if (!(m.size >= 0 && m.size <= 64)) add('DBC-MESSAGE-DLC', 'The data length ' + clip(m.size) + ' is larger than 64 bytes, the most a CAN FD frame can carry.', m.sizeStart, m.sizeEnd);
    else if (!B.isFrameLength(m.size)) add('DBC-MESSAGE-DLC-FD', 'The data length ' + m.size + ' is not a length a frame can have: classic CAN carries 0 to 8 bytes, CAN FD also 12, 16, 20, 24, 32, 48 or 64.', m.sizeStart, m.sizeEnd);
    if (!m.signals.length) add('DBC-MESSAGE-NO-SIGNALS', 'The message "' + clip(m.name) + '" has no signals.', m.nameStart, m.nameEnd);
    if (!knownNode(m.sender)) add('DBC-SENDER-UNKNOWN', 'The sending node "' + clip(m.sender) + '" is not listed in BU_.', m.senderStart, m.senderEnd);
    checkSignals(m);
  }
  caseCollisions(messageList.map(function (m) { return { name: m.name, start: m.nameStart, end: m.nameEnd }; }), 'message');

  function checkSignals(m) {
    const names = new Map();
    const frameBytes = Math.min(m.size >= 0 ? m.size : 0, 64);
    const usable = [];
    for (const s of m.signals) {
      checkName(s.name, 'signal', s.nameStart, s.nameEnd);
      if (names.has(s.name)) add('DBC-SIGNAL-NAME-DUPLICATE', 'The message "' + clip(m.name) + '" already has a signal named "' + clip(s.name) + '"; names must be unique within a message.', s.nameStart, s.nameEnd);
      else names.set(s.name, s);
      let layout = null;
      if (!(s.length >= 1 && s.length <= 64)) add('DBC-SIGNAL-LENGTH', 'The length of "' + clip(s.name) + '" is ' + clip(s.length) + ' bits; a signal needs 1 to 64 bits.', s.specStart, s.specEnd);
      else {
        layout = B.layoutOf(s.startBit, s.length, s.little);
        if (!layout || layout.bytes > frameBytes) {
          const where = !layout ? 'start bit ' + clip(s.startBit)
            : s.little ? 'bits ' + layout.lsb + ' to ' + layout.msb + ', up to byte ' + layout.lastByte
              : 'most significant bit ' + layout.msb + ', least significant bit ' + layout.lsb + ' in byte ' + layout.lastByte;
          add('DBC-SIGNAL-OUTSIDE-FRAME', '"' + clip(s.name) + '" (' + (s.little ? 'little-endian' : 'big-endian') + ', ' + where + ') does not fit into the ' + frameBytes + ' data byte' + (frameBytes === 1 ? '' : 's') + ' of the message.' +
            (!s.little ? ' For big-endian signals the start bit is the most significant bit.' : ''), s.specStart, s.specEnd);
          layout = null;
        }
      }
      if (s.valueType !== 0 && !((s.valueType === 1 && s.length === 32) || (s.valueType === 2 && s.length === 64))) {
        add('DBC-VALTYPE-INVALID', '"' + clip(s.name) + '" is declared as a ' + (s.valueType === 1 ? '32-bit float (value type 1) and needs a length of 32' : '64-bit float (value type 2) and needs a length of 64') + ' bits, not ' + clip(s.length) + '; it is not decoded.', s.specStart, s.specEnd);
        layout = null;
      }
      const factor = D.cached(s.factorText);
      const offset = D.cached(s.offsetText);
      const min = D.cached(s.minText);
      const max = D.cached(s.maxText);
      for (const [d, label, text] of [[factor, 'factor', s.factorText], [offset, 'offset', s.offsetText], [min, 'minimum', s.minText], [max, 'maximum', s.maxText]]) {
        if (!d) add('DBC-NUMBER', 'The ' + label + ' "' + clip(text) + '" of "' + clip(s.name) + '" cannot be read as an exact number (its exponent is too large or the text is too long).', label === 'factor' || label === 'offset' ? s.scaleStart : s.rangeStart, label === 'factor' || label === 'offset' ? s.scaleEnd : s.rangeEnd);
      }
      if (factor && D.isZero(factor)) add('DBC-FACTOR-ZERO', 'The factor of "' + clip(s.name) + '" is 0, so every raw value gives the same physical value and nothing can be encoded. Use the step size of the signal (for example 1 or 0.1).', s.scaleStart, s.scaleEnd);
      if (min && max) {
        if (D.cmp(min, max) > 0) add('DBC-RANGE-INVERTED', 'The minimum ' + s.minText + ' of "' + clip(s.name) + '" is greater than its maximum ' + s.maxText + '.', s.rangeStart, s.rangeEnd);
        else if (!(D.isZero(min) && D.isZero(max))) {
          const r = representable(s, factor, offset);
          if (r && (D.cmp(min, r.lo) < 0 || D.cmp(max, r.hi) > 0)) {
            add('DBC-RANGE-OUTSIDE-RAW', 'The range [' + s.minText + '|' + s.maxText + '] of "' + clip(s.name) + '" goes beyond what its ' + s.length + ' ' + (s.signed ? 'signed' : 'unsigned') + ' raw bits can express with factor ' + s.factorText + ' and offset ' + s.offsetText + ': ' + D.toString(r.lo) + ' to ' + D.toString(r.hi) + '.', s.rangeStart, s.rangeEnd);
          }
        }
      }
      const real = s.receivers.filter(function (r) { return r !== P.NO_NODE; });
      if (!real.length) add('DBC-SIGNAL-NO-RECEIVER', '"' + clip(s.name) + '" has no receiving node (' + (s.receivers.length ? P.NO_NODE : 'none listed') + ').', s.nameStart, s.nameEnd);
      for (let k = 0; k < s.receivers.length; k++) {
        if (!knownNode(s.receivers[k])) add('DBC-RECEIVER-UNKNOWN', 'The receiving node "' + clip(s.receivers[k]) + '" of "' + clip(s.name) + '" is not listed in BU_.', s.receiverPos[2 * k], s.receiverPos[2 * k + 1]);
      }
      if (s.values) {
        duplicateValues(s.values, 'value descriptions of "' + clip(s.name) + '"');
        if (s.valueType === 0 && s.length >= 1 && s.length <= 64) {
          const range = B.rawRange(s.length, s.signed);
          for (const e of s.values) {
            if (e.value < range.lo || e.value > range.hi) add('DBC-VALUE-OUTSIDE-RAW', 'The described raw value ' + e.value + ' of "' + clip(s.name) + '" cannot occur: its ' + s.length + ' ' + (s.signed ? 'signed' : 'unsigned') + ' bits hold ' + range.lo + ' to ' + range.hi + '.' + (s.signed && e.value > range.hi && e.value <= (range.hi << 1n) + 1n ? ' If the bit pattern is meant, write ' + B.toSigned(e.value, s.length) + '.' : ''), e.start, e.end);
          }
        }
      }
      if (layout) usable.push({ signal: s, layout: layout, order: usable.length });
    }
    caseCollisions(m.signals.map(function (s) { return { name: s.name, start: s.nameStart, end: s.nameEnd }; }), 'signal');

    const mux = M.analyseMux(m);
    for (const x of mux.issues) add(x.code, x.message, x.start, x.end);

    // Overlaps between signals that can be present in the same frame. Every bit keeps the list of
    // the signals that use it, so the work depends on the bits that are shared, not on the square
    // of the number of signals. A message that needs more than the budget is checked only as far
    // as the budget reaches, and that is reported.
    const owners = new Map();
    let budget = Math.min(OVERLAP_BUDGET, overlapBudgetLeft);
    let used = 0;
    let stopped = false;
    for (const b of usable) {
      if (mux.info.get(b.signal).status !== 'ok') continue;
      const bits = B.bitsOf(b.layout);
      if (!stopped) {
        const hits = new Map();
        for (const bit of bits) {
          const list = owners.get(bit);
          if (!list) continue;
          for (const a of list) {
            if (++used > budget) { stopped = true; break; }
            if (mux.any && !M.compatible(mux, a.signal, b.signal)) continue;
            const h = hits.get(a);
            if (!h) hits.set(a, { other: a, lo: bit, hi: bit });
            else { if (bit < h.lo) h.lo = bit; if (bit > h.hi) h.hi = bit; }
          }
          if (stopped) break;
        }
        if (hits.size) {
          const list = Array.from(hits.values()).sort(function (x, y) { return x.other.order - y.other.order; });
          const first = list[0];
          add('DBC-SIGNAL-OVERLAP', '"' + clip(b.signal.name) + '" uses bit' + (first.lo === first.hi ? ' ' + first.lo : 's ' + first.lo + ' to ' + first.hi) + ', which "' + clip(first.other.signal.name) + '" uses as well' +
            (list.length > 1 ? ' (it also overlaps ' + list.slice(1, 4).map(function (h) { return '"' + clip(h.other.signal.name) + '"'; }).join(', ') + (list.length > 4 ? ' and more' : '') + ')' : '') +
            '; both can be present in the same frame, so their values corrupt each other.', b.signal.specStart, b.signal.specEnd);
        }
      }
      if (stopped) break;
      for (const bit of bits) {
        let list = owners.get(bit);
        if (!list) { list = []; owners.set(bit, list); }
        list.push(b);
      }
    }
    overlapBudgetLeft = Math.max(0, overlapBudgetLeft - used);
    if (stopped) add('DBC-CHECK-LIMIT', 'The overlap check of the message "' + clip(m.name) + '" stopped early: it has so many signals that share bits that checking all pairs would take too long. Overlaps among the signals checked so far are reported.', m.nameStart, m.nameEnd);
  }

  // ---- statements that refer to messages and signals ----------------------------------------
  for (const d of db.valueDescriptions) {
    if (d.unknown === 'message') add('DBC-VAL-UNKNOWN-MESSAGE', 'VAL_ refers to the message ID ' + clip(String(d.rawId)) + ', but no message has that ID; the value descriptions are not used.', d.idStart, d.idEnd);
    else if (d.unknown === 'signal') add('DBC-VAL-UNKNOWN-SIGNAL', 'VAL_ refers to the signal "' + clip(d.signalName) + '", but the message ' + clip(String(d.rawId)) + ' has no signal of that name; the value descriptions are not used.', d.signalStart, d.signalEnd);
    else if (d.duplicate) add('DBC-VAL-DUPLICATE', 'The signal "' + clip(d.signalName) + '" already has value descriptions (VAL_); this second list is not used.', d.signalStart, d.signalEnd);
  }
  for (const c of db.comments) {
    if (!c.unknown) continue;
    const t = c.target;
    add('DBC-COMMENT-UNKNOWN', 'This comment refers to ' + (t.kind === 'node' ? 'the node "' + clip(t.name) + '"' : t.kind === 'message' ? 'the message ID ' + clip(String(t.rawId)) : t.kind === 'signal' ? 'the signal "' + clip(t.name) + '" of the message ' + clip(String(t.rawId)) : 'the environment variable "' + clip(t.name) + '"') + ', which does not exist.', t.start, t.end);
  }
  for (const v of db.valueTypes) {
    if (v.unknown) add('DBC-VALTYPE-UNKNOWN', 'SIG_VALTYPE_ refers to the signal "' + clip(v.signalName) + '" of the message ' + clip(String(v.rawId)) + ', which does not exist.', v.signalStart, v.signalEnd);
    else if (v.type !== 0 && v.type !== 1 && v.type !== 2) add('DBC-VALTYPE-INVALID', 'The value type ' + clip(String(v.type)) + ' is not known: use 0 (integer), 1 (32-bit float) or 2 (64-bit float).', v.typeStart, v.typeEnd);
  }
  for (const s of db.muxSpecs) {
    if (s.unknown === 'message') add('DBC-MUX-EXTENDED-UNKNOWN', 'SG_MUL_VAL_ refers to the message ID ' + clip(String(s.rawId)) + ', which does not exist.', s.idStart, s.idEnd);
    else if (s.unknown === 'signal') add('DBC-MUX-EXTENDED-UNKNOWN', 'SG_MUL_VAL_ refers to the signal "' + clip(s.signalName) + '", which the message ' + clip(String(s.rawId)) + ' does not have.', s.signalStart, s.signalEnd);
    else if (s.duplicate) add('DBC-MUX-EXTENDED-DUPLICATE', 'The signal "' + clip(s.signalName) + '" already has an SG_MUL_VAL_ statement; this second one is not used.', s.signalStart, s.signalEnd);
  }
  for (const t of db.transmitters) {
    if (t.unknown) add('DBC-TRANSMITTER-UNKNOWN-MESSAGE', 'BO_TX_BU_ refers to the message ID ' + clip(String(t.rawId)) + ', which does not exist.', t.idStart, t.idEnd);
    for (const node of t.nodes) if (!knownNode(node.name)) add('DBC-SENDER-UNKNOWN', 'The transmitting node "' + clip(node.name) + '" is not listed in BU_.', node.start, node.end);
  }
  for (const st of db.signalTypes) {
    if (st.table && !tableNames.has(st.table.name)) add('DBC-VALUE-TABLE-MISSING', 'The signal type "' + clip(st.name) + '" refers to the value table "' + clip(st.table.name) + '", which is not defined (VAL_TABLE_).', st.table.start, st.table.end);
  }

  // ---- attributes ----------------------------------------------------------------------------
  const defNames = new Set();
  for (const d of db.attributeDefs) {
    if (defNames.has(d.name)) add('DBC-ATTRIBUTE-DUPLICATE-DEF', 'The attribute "' + clip(d.name) + '" is defined twice; only the first definition is used.', d.nameStart, d.nameEnd);
    defNames.add(d.name);
  }
  function checkValue(def, value, where) {
    const v = value.value;
    let problem = '';
    if (def.type === 'STRING') { if (!v.isString) problem = 'a text in double quotes'; }
    else if (def.type === 'ENUM') {
      const list = def.enumValues || [];
      if (v.isString) { if (list.indexOf(v.text) === -1) problem = 'one of ' + list.map(function (x) { return '"' + clip(x) + '"'; }).join(', '); }
      else { const k = Number(v.text); if (!(Number.isInteger(k) && k >= 0 && k < list.length)) problem = 'an index from 0 to ' + (list.length - 1) + ' (or one of the names)'; }
    } else {
      const d = v.isString ? null : D.parse(v.text);
      const lo = def.min !== null ? D.parse(def.min) : null;
      const hi = def.max !== null ? D.parse(def.max) : null;
      const bounded = lo && hi && !(D.isZero(lo) && D.isZero(hi));
      if (!d) problem = 'a number';
      else if ((def.type === 'INT' || def.type === 'HEX') && !D.isInteger(d)) problem = 'a whole number';
      else if (bounded && (D.cmp(d, lo) < 0 || D.cmp(d, hi) > 0)) problem = 'a number from ' + def.min + ' to ' + def.max;
    }
    if (problem) add('DBC-ATTRIBUTE-VALUE', 'The value ' + clip(v.isString ? '"' + v.text + '"' : v.text) + ' of the attribute "' + clip(def.name) + '" ' + where + 'is not allowed: its definition (' + def.type + ') expects ' + problem + '.', v.start, v.end);
  }
  for (const d of db.attributeDefaults) {
    const def = db.attributeDefByName.get(d.name);
    if (!def) add('DBC-ATTRIBUTE-UNDEFINED', 'BA_DEF_DEF_ gives a default for the attribute "' + clip(d.name) + '", which has no definition (BA_DEF_).', d.nameStart, d.nameEnd);
    else checkValue(def, d, '(default) ');
  }
  for (const a of db.attributes) {
    const def = db.attributeDefByName.get(a.name);
    if (!def) { add('DBC-ATTRIBUTE-UNDEFINED', 'The attribute "' + clip(a.name) + '" has no definition (BA_DEF_), so its value cannot be checked or used.', a.nameStart, a.nameEnd); continue; }
    if (a.unknown) { add('DBC-ATTRIBUTE-UNKNOWN-OBJECT', 'The attribute "' + clip(a.name) + '" is set for ' + (a.target.kind === 'signal' ? 'the signal "' + clip(a.target.name) + '" of the message ' + clip(String(a.target.rawId)) : a.target.kind === 'message' ? 'the message ID ' + clip(String(a.target.rawId)) : a.target.kind === 'node' ? 'the node "' + clip(a.target.name) + '"' : 'the environment variable "' + clip(a.target.name) + '"') + ', which does not exist.', a.target.start, a.target.end); continue; }
    const wanted = OBJECT_KIND[def.objectType] || 'network';
    if (wanted !== a.target.kind) { add('DBC-ATTRIBUTE-OBJECT-TYPE', 'The attribute "' + clip(a.name) + '" is defined for ' + KIND_WORD[wanted] + ' (BA_DEF_ ' + (def.objectType || 'without object type') + '), but is set here for ' + KIND_WORD[a.target.kind] + '.', a.nameStart, a.nameEnd); continue; }
    checkValue(def, a, '');
  }

  // ---- value tables that nothing uses --------------------------------------------------------
  const referenced = new Set(db.signalTypes.filter(function (st) { return st.table; }).map(function (st) { return st.table.name; }));
  const seenTables = new Set();
  let signatures = null;
  for (const t of db.valueTables) {
    if (seenTables.has(t.name)) continue;
    seenTables.add(t.name);
    if (referenced.has(t.name)) continue;
    if (signatures === null) {
      signatures = new Set();
      for (const m of db.messages) for (const s of m.signals) if (s.values) signatures.add(entriesSignature(s.values));
    }
    if (!signatures.has(entriesSignature(t.entries))) add('DBC-VALUE-TABLE-UNUSED', 'No signal uses the value table "' + clip(t.name) + '": no signal type refers to it and no signal has the same value descriptions.', t.nameStart, t.nameEnd);
  }

  if (dropped) problems.push({ code: 'DBC-LIST-CUT', severity: 'info', message: 'Only the first ' + maxProblems + (maxProblems === 1 ? ' problem is' : ' problems are') + ' listed; ' + dropped + ' more ' + (dropped === 1 ? 'was' : 'were') + ' found (setting canAtlas.maxProblems).', start: 0, end: 0 });
  return { problems: problems, counts: counts, dropped: dropped };
}

module.exports = { validate: validate, CODES: CODES, representable: representable, idText: idText, hex: hex, sameEntries: sameEntries };
