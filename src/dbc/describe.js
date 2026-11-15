'use strict';
// Descriptions of nodes, messages, signals and value tables for hovers, the outline and reports,
// and the lookup of the element at a text offset.

const D = require('./decimal');
const B = require('./bits');
const P = require('./parse');
const M = require('./mux');
const V = require('./validate');
const U = require('../util');

const MAX_VALUES_SHOWN = 12;

function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

/** The ID in hex and decimal, for example "0x100 (256), standard 11-bit". */
function idLine(m) {
  if (!isFinite(m.rawId)) return m.idText + ' (not a valid ID)';
  if (m.extended) return V.hex(m.frameId) + ' (' + m.frameId + '), extended 29-bit; written as ' + m.idText + ' in the file';
  return V.hex(m.frameId) + ' (' + m.frameId + '), standard 11-bit';
}

/** Where the bits of a signal lie, in words. */
function bitsLine(s) {
  const layout = s.length >= 1 && s.length <= 64 ? B.layoutOf(s.startBit, s.length, s.little) : null;
  if (!layout) return 'start bit ' + s.startBit + ', ' + plural(s.length, 'bit') + ' (not a valid layout)';
  const bytes = layout.firstByte === layout.lastByte ? 'byte ' + layout.firstByte : 'bytes ' + layout.firstByte + ' to ' + layout.lastByte;
  if (s.little) return plural(s.length, 'bit') + ', little-endian (Intel): start bit ' + s.startBit + ' is the least significant bit; bits ' + layout.lsb + ' to ' + layout.msb + ', ' + bytes;
  return plural(s.length, 'bit') + ', big-endian (Motorola): start bit ' + s.startBit + ' is the most significant bit; it runs down to bit ' + layout.lsb + ', ' + bytes;
}

function valueTypeLine(s) {
  if (s.valueType === 1) return '32-bit IEEE float';
  if (s.valueType === 2) return '64-bit IEEE float';
  return s.signed ? 'signed integer (two\'s complement)' : 'unsigned integer';
}

/** "physical = raw × 0.25 + 0" in plain text. */
function formulaLine(s) {
  const what = s.valueType ? 'value' : 'raw';
  const off = D.cached(s.offsetText);
  const offText = off && off.n < 0n ? ' − ' + D.toString(D.neg(off)) : ' + ' + (off ? D.toString(off) : s.offsetText);
  const f = D.cached(s.factorText);
  return 'physical = ' + what + ' × ' + (f ? D.toString(f) : s.factorText) + offText;
}

/** The raw range and the physical values it gives, or '' for float signals. */
function rangeLine(s) {
  if (s.valueType !== 0 || !(s.length >= 1 && s.length <= 64)) return '';
  const r = B.rawRange(s.length, s.signed);
  const rep = V.representable(s, D.cached(s.factorText), D.cached(s.offsetText));
  return 'raw ' + r.lo + ' to ' + r.hi + (rep ? ' gives ' + D.toString(rep.lo) + ' to ' + D.toString(rep.hi) + (s.unit ? ' ' + s.unit : '') : '');
}

/** Facts about a signal as [label, text] pairs (plain text). */
function signalFacts(db, m, s) {
  const facts = [];
  facts.push(['Message', m.name + ', ID ' + (isFinite(m.frameId) ? V.hex(m.frameId) : m.idText)]);
  facts.push(['Bits', bitsLine(s)]);
  facts.push(['Value', valueTypeLine(s)]);
  facts.push(['Scaling', formulaLine(s)]);
  const rl = rangeLine(s);
  if (rl) facts.push(['Raw range', rl]);
  const min = D.cached(s.minText);
  const max = D.cached(s.maxText);
  if (min && max && !(D.isZero(min) && D.isZero(max))) facts.push(['Range', s.minText + ' to ' + s.maxText + (s.unit ? ' ' + s.unit : '')]);
  facts.push(['Unit', s.unit || '(none)']);
  const rec = s.receivers.filter(function (r) { return r !== P.NO_NODE; });
  facts.push(['Receivers', rec.length ? rec.join(', ') : '(none)']);
  const mux = M.analyseMux(m);
  if (s.isMultiplexor) facts.push(['Multiplexing', 'multiplexor' + (mux.info.get(s).parent ? '; ' + M.conditionText(mux, s) : '')]);
  else if (s.muxValue !== null || s.muxSpec) facts.push(['Multiplexing', M.conditionText(mux, s) || 'present in every frame']);
  if (s.values && s.values.length) {
    const shown = s.values.slice(0, MAX_VALUES_SHOWN).map(function (e) { return e.value + ' ' + e.text; }).join('; ');
    facts.push(['Value descriptions', shown + (s.values.length > MAX_VALUES_SHOWN ? '; and ' + (s.values.length - MAX_VALUES_SHOWN) + ' more' : '')]);
  }
  if (s.comment) facts.push(['Comment', U.shorten(s.comment, 400)]);
  return facts;
}

function messageFacts(db, m) {
  const facts = [['ID', idLine(m)], ['Data length', plural(m.size, 'byte')], ['Sender', m.sender === P.NO_NODE ? '(none)' : m.sender]];
  if (m.transmitters.length) facts.push(['Also sent by', m.transmitters.join(', ')]);
  const cycle = P.cycleTimeOf(db, m);
  if (cycle !== null) facts.push(['Cycle time', cycle + ' ms']);
  const mux = M.analyseMux(m);
  facts.push(['Signals', String(m.signals.length) + (mux.any ? ' (multiplexed: ' + mux.switches.map(function (s) { return s.name; }).join(', ') + ')' : '')]);
  if (m.comment) facts.push(['Comment', U.shorten(m.comment, 400)]);
  return facts;
}

function factsMarkdown(title, facts) {
  const lines = [title, '', '| | |', '| --- | --- |'];
  for (const f of facts) lines.push('| ' + U.escapeMarkdown(f[0]) + ' | ' + U.escapeMarkdown(f[1]) + ' |');
  return lines.join('\n');
}

function signalHover(db, m, s) {
  return factsMarkdown('**Signal** ' + U.codeSpan(s.name), signalFacts(db, m, s));
}

function messageHover(db, m) {
  return factsMarkdown('**Message** ' + U.codeSpan(m.name), messageFacts(db, m));
}

function nodeHover(db, name) {
  let sends = 0;
  let receives = 0;
  for (const m of db.messages) {
    if (m.pseudo) continue;
    if (m.sender === name || m.transmitters.indexOf(name) !== -1) sends++;
    for (const s of m.signals) if (s.receivers.indexOf(name) !== -1) receives++;
  }
  const node = db.nodeByName.get(name);
  const facts = [['Sends', plural(sends, 'message')], ['Receives', plural(receives, 'signal')]];
  if (!node) facts.unshift(['Listed in BU_', 'no']);
  if (node && node.comment) facts.push(['Comment', U.shorten(node.comment, 400)]);
  return factsMarkdown('**Node** ' + U.codeSpan(name), facts);
}

function valueTableHover(t) {
  const lines = ['**Value table** ' + U.codeSpan(t.name), '', '| Raw | Description |', '| ---: | --- |'];
  for (const e of t.entries.slice(0, 40)) lines.push('| ' + e.value + ' | ' + U.escapeMarkdown(e.text) + ' |');
  if (t.entries.length > 40) lines.push('', U.escapeMarkdown('and ' + (t.entries.length - 40) + ' more'));
  return lines.join('\n');
}

// ---- what lies at a text offset -------------------------------------------------------------------

function findMessage(db, offset) {
  const list = db.messages;
  let lo = 0;
  let hi = list.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= offset) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best === -1) return null;
  const m = list[best];
  return offset <= m.end ? m : null;
}

function findRef(db, offset) {
  const list = db.refs;
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = list[mid];
    if (r.end < offset) lo = mid + 1;
    else if (r.start > offset) hi = mid - 1;
    else return r;
  }
  return null;
}

/**
 * The element at a text offset: { kind: 'message'|'signal'|'node'|'valueTable', message, signal,
 * name, start, end, definition } where definition is true on the defining name. null for others.
 */
function elementAt(db, offset) {
  const m = findMessage(db, offset);
  if (m) {
    if (offset <= m.headerEnd) {
      if (offset >= m.senderStart && offset <= m.senderEnd && m.sender !== P.NO_NODE) return { kind: 'node', name: m.sender, start: m.senderStart, end: m.senderEnd };
      return { kind: 'message', message: m, start: m.nameStart, end: m.nameEnd, definition: offset >= m.nameStart && offset <= m.nameEnd };
    }
    const sigs = m.signals;
    let lo = 0;
    let hi = sigs.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sigs[mid].start <= offset) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best !== -1 && offset <= sigs[best].end) {
      const s = sigs[best];
      for (let k = 0; k < s.receivers.length; k++) {
        if (offset >= s.receiverPos[2 * k] && offset <= s.receiverPos[2 * k + 1] && s.receivers[k] !== P.NO_NODE) return { kind: 'node', name: s.receivers[k], start: s.receiverPos[2 * k], end: s.receiverPos[2 * k + 1] };
      }
      return { kind: 'signal', message: m, signal: s, start: s.nameStart, end: s.nameEnd, definition: offset >= s.nameStart && offset <= s.nameEnd };
    }
    return null;
  }
  const r = findRef(db, offset);
  if (r) {
    if (r.kind === 'node') return { kind: 'node', name: r.name, start: r.start, end: r.end };
    const msg = db.messageByRawId.get(r.rawId);
    if (!msg) return null;
    if (r.kind === 'message') return { kind: 'message', message: msg, start: r.start, end: r.end };
    const sig = msg.signalIndex.get(r.name);
    return sig ? { kind: 'signal', message: msg, signal: sig, start: r.start, end: r.end } : null;
  }
  for (const node of db.nodes) if (offset >= node.start && offset <= node.end) return { kind: 'node', name: node.name, start: node.start, end: node.end, definition: true };
  for (const t of db.valueTables) if (offset >= t.nameStart && offset <= t.nameEnd) return { kind: 'valueTable', table: t, name: t.name, start: t.nameStart, end: t.nameEnd, definition: true };
  return null;
}

/** The hover Markdown of an element found by elementAt(). */
function hoverOf(db, el) {
  if (!el) return '';
  if (el.kind === 'signal') return signalHover(db, el.message, el.signal);
  if (el.kind === 'message') return messageHover(db, el.message);
  if (el.kind === 'node') return nodeHover(db, el.name);
  if (el.kind === 'valueTable') return valueTableHover(el.table);
  return '';
}

/** The definition range of an element: { start, end } of its defining name, or null. */
function definitionOf(db, el) {
  if (!el) return null;
  if (el.kind === 'signal') return { start: el.signal.nameStart, end: el.signal.nameEnd };
  if (el.kind === 'message') return { start: el.message.nameStart, end: el.message.nameEnd };
  if (el.kind === 'node') { const node = db.nodeByName.get(el.name); return node ? { start: node.start, end: node.end } : null; }
  if (el.kind === 'valueTable') return { start: el.table.nameStart, end: el.table.nameEnd };
  return null;
}

/** The message whose block contains the offset (its BO_ line or one of its SG_ lines), or null. */
function messageAt(db, offset) { const m = findMessage(db, offset); return m && !m.pseudo ? m : null; }

/** Short label of a message for lists: "0x100 EngineStatus". */
function messageLabel(m) { return (isFinite(m.frameId) ? V.hex(m.frameId) : m.idText) + ' ' + m.name; }

/** One-line summary of a decoded value for lists. */
function valueSummary(row) {
  if (row.status !== 'ok') return row.status === 'absent' ? 'not present (' + row.reason + ')' : 'not decoded (' + row.reason + ')';
  return row.physical + (row.signal.unit ? ' ' + row.signal.unit : '') + (row.text ? ' "' + row.text + '"' : '') + ' (raw ' + row.rawText + ')';
}

module.exports = {
  idLine: idLine, bitsLine: bitsLine, valueTypeLine: valueTypeLine, formulaLine: formulaLine, rangeLine: rangeLine, signalFacts: signalFacts, messageFacts: messageFacts,
  signalHover: signalHover, messageHover: messageHover, nodeHover: nodeHover, valueTableHover: valueTableHover, elementAt: elementAt, hoverOf: hoverOf,
  definitionOf: definitionOf, messageAt: messageAt, messageLabel: messageLabel, valueSummary: valueSummary, plural: plural
};
