'use strict';
// The outline of a DBC database: the tree of the DBC Outline view (nodes, messages with their
// signals, value tables; long lists in pages) and the document symbols of the editor's Outline.

const P = require('./parse');
const M = require('./mux');
const D = require('./describe');

const PAGE = 500;
// The editor's outline lists at most this many entries of each kind (a damaged file with millions of them would otherwise fill the memory with outline entries).
const SYMBOL_LIMITS = Object.freeze({ nodes: 5000, valueTables: 5000, messages: 100000, signals: 5000 });

function messagesById(db) {
  if (db._messagesById) return db._messagesById;
  db._messagesById = db.messages.filter(function (m) { return !m.pseudo; }).sort(function (a, b) {
    if (a.extended !== b.extended) return a.extended ? 1 : -1;
    return (isFinite(a.frameId) ? a.frameId : Infinity) - (isFinite(b.frameId) ? b.frameId : Infinity) || a.index - b.index;
  });
  return db._messagesById;
}

/** How many messages each node sends (as sender or as an additional transmitter), counted once. */
function sendCounts(db) {
  if (db._sendCounts) return db._sendCounts;
  const counts = new Map();
  for (const m of db.messages) {
    counts.set(m.sender, (counts.get(m.sender) || 0) + 1);
    for (let k = 0; k < m.transmitters.length; k++) {
      const t = m.transmitters[k];
      if (t === m.sender || m.transmitters.indexOf(t) < k) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  db._sendCounts = counts;
  return counts;
}

/** A long list as pages of PAGE entries: [{ kind, label, detail, expandable, from, to }] (or null when it fits on one level). */
function pagesOf(kind, noun, list) {
  if (list.length <= PAGE) return null;
  const pages = [];
  for (let k = 0; k < list.length; k += PAGE) {
    const last = Math.min(list.length, k + PAGE);
    pages.push({ kind: kind, label: noun + ' ' + (k + 1) + ' to ' + last, detail: '', expandable: true, from: k, to: last });
  }
  return pages;
}

/** Compact DBC notation of a signal for list details: "0|16@1+ rpm". */
function signalDetail(s) {
  const mux = s.muxText ? s.muxText + ' ' : '';
  const type = s.valueType === 1 ? ' float32' : s.valueType === 2 ? ' float64' : '';
  return mux + s.startBit + '|' + s.length + '@' + (s.little ? '1' : '0') + (s.signed ? '-' : '+') + type + (s.unit ? ' ' + s.unit : '');
}

function messageDetail(db, m) {
  const cycle = P.cycleTimeOf(db, m);
  return (m.extended ? 'extended ID · ' : '') + D.plural(m.size, 'byte') + ' · ' + (m.sender === P.NO_NODE ? 'no sender' : m.sender) + ' · ' + D.plural(m.signals.length, 'signal') + (cycle !== null ? ' · ' + cycle + ' ms' : '');
}

/** The top level of the tree. */
function rootNodes(db) {
  const out = [];
  const messages = db.messages.filter(function (m) { return !m.pseudo; });
  out.push({ kind: 'messages', label: 'Messages', detail: String(messages.length), expandable: messages.length > 0 });
  out.push({ kind: 'nodes', label: 'Nodes', detail: String(db.nodes.length), expandable: db.nodes.length > 0 });
  out.push({ kind: 'valueTables', label: 'Value tables', detail: String(db.valueTables.length), expandable: db.valueTables.length > 0 });
  const independent = db.messages.find(function (m) { return m.pseudo; });
  if (independent && independent.signals.length) out.push({ kind: 'independent', label: 'Signals without a message', detail: String(independent.signals.length), expandable: true, message: independent });
  return out;
}

function messageNode(db, m) {
  return { kind: 'message', label: D.messageLabel(m), detail: messageDetail(db, m), expandable: m.signals.length > 0, message: m, offset: m.nameStart };
}

function signalNode(m, s) {
  return { kind: s.isMultiplexor ? 'multiplexor' : 'signal', label: s.name, detail: signalDetail(s), expandable: false, message: m, signal: s, offset: s.nameStart };
}

/** The children of a tree node. */
function childrenOf(db, node) {
  if (node.kind === 'messages') {
    const list = messagesById(db);
    if (list.length <= PAGE) return list.map(function (m) { return messageNode(db, m); });
    const pages = [];
    for (let k = 0; k < list.length; k += PAGE) {
      const last = Math.min(list.length, k + PAGE);
      pages.push({ kind: 'page', label: 'Messages ' + (k + 1) + ' to ' + last, detail: D.messageLabel(list[k]).split(' ')[0] + ' to ' + D.messageLabel(list[last - 1]).split(' ')[0], expandable: true, from: k, to: last });
    }
    return pages;
  }
  if (node.kind === 'page') return messagesById(db).slice(node.from, node.to).map(function (m) { return messageNode(db, m); });
  if (node.kind === 'message' || node.kind === 'independent') {
    const m = node.message;
    const mux = M.analyseMux(m);
    return m.signals.map(function (s) {
      const n = signalNode(m, s);
      if (mux.any && !s.isMultiplexor && mux.info.get(s).parent) n.kind = 'multiplexed';
      return n;
    });
  }
  if (node.kind === 'nodes' || node.kind === 'nodePage') {
    const pages = node.kind === 'nodes' ? pagesOf('nodePage', 'Nodes', db.nodes) : null;
    if (pages) return pages;
    const counts = sendCounts(db);
    return db.nodes.slice(node.from || 0, node.to === undefined ? db.nodes.length : node.to).map(function (node2) {
      return { kind: 'node', label: node2.name, detail: 'sends ' + D.plural(counts.get(node2.name) || 0, 'message'), expandable: false, offset: node2.start };
    });
  }
  if (node.kind === 'valueTables' || node.kind === 'valueTablePage') {
    const pages = node.kind === 'valueTables' ? pagesOf('valueTablePage', 'Value tables', db.valueTables) : null;
    if (pages) return pages;
    return db.valueTables.slice(node.from || 0, node.to === undefined ? db.valueTables.length : node.to).map(function (t) { return { kind: 'valueTable', label: t.name, detail: D.plural(t.entries.length, 'value'), expandable: false, offset: t.nameStart }; });
  }
  return [];
}

/**
 * Document symbols: { name, detail, kind, start, end, selStart, selEnd, children } with kinds
 * 'nodes', 'node', 'message', 'signal', 'valueTable' (the editor maps them to its symbol kinds).
 */
function symbols(db) {
  const out = [];
  if (db.nodes.length) {
    const first = db.nodes[0];
    const last = db.nodes[db.nodes.length - 1];
    out.push({ name: 'Nodes', detail: String(db.nodes.length), kind: 'nodes', start: first.start, end: last.end, selStart: first.start, selEnd: first.end,
      children: db.nodes.slice(0, SYMBOL_LIMITS.nodes).map(function (node) { return { name: node.name, detail: '', kind: 'node', start: node.start, end: node.end, selStart: node.start, selEnd: node.end, children: [] }; }) });
  }
  for (const t of db.valueTables.slice(0, SYMBOL_LIMITS.valueTables)) out.push({ name: t.name, detail: D.plural(t.entries.length, 'value'), kind: 'valueTable', start: t.start, end: t.end, selStart: t.nameStart, selEnd: t.nameEnd, children: [] });
  for (const m of db.messages.slice(0, SYMBOL_LIMITS.messages)) {
    out.push({
      name: m.pseudo ? 'Signals without a message' : D.messageLabel(m), detail: m.pseudo ? '' : messageDetail(db, m), kind: 'message', start: m.start, end: m.end, selStart: m.nameStart, selEnd: m.nameEnd,
      children: m.signals.slice(0, SYMBOL_LIMITS.signals).map(function (s) { return { name: s.name, detail: signalDetail(s), kind: 'signal', start: s.start, end: s.end, selStart: s.nameStart, selEnd: s.nameEnd, children: [] }; })
    });
  }
  out.sort(function (a, b) { return a.start - b.start; });
  return out;
}

/** Quick pick items for every message: { label, description, detail, message }. */
function messageItems(db) {
  return messagesById(db).map(function (m) {
    return { label: D.messageLabel(m), description: messageDetail(db, m), detail: m.comment ? m.comment.replace(/\s+/g, ' ').slice(0, 120) : undefined, message: m };
  });
}

module.exports = { rootNodes: rootNodes, childrenOf: childrenOf, symbols: symbols, messageItems: messageItems, messagesById: messagesById, SYMBOL_LIMITS: SYMBOL_LIMITS, signalDetail: signalDetail, messageDetail: messageDetail, PAGE: PAGE };
