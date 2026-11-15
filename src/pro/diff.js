'use strict';
// Comparison of two DBC databases. Messages are matched by identifier (extended flag and frame
// number), signals by name inside a matched message; what is left over is looked at once more for
// an identifier change of a message and a rename of a signal. Every difference gets a stable code
// and one of three classes:
//   BREAKING      an existing receiver decodes bytes differently or no longer finds something
//   NON-BREAKING  something was added or relaxed that existing receivers do not depend on
//   COSMETIC      documentation, order or spelling only
// The rules are written down in docs/diff-rules.md; the table RULES below is the same list.
// Nothing here uses recursion, and every lookup goes through a Map.

const D = require('../dbc/decimal');
const B = require('../dbc/bits');
const P = require('../dbc/parse');
const M = require('../dbc/mux');
const V = require('../dbc/validate');

const BREAKING = 'BREAKING';
const NON_BREAKING = 'NON-BREAKING';
const COSMETIC = 'COSMETIC';
const CLASSES = Object.freeze([BREAKING, NON_BREAKING, COSMETIC]);
const CLASS_WORD = Object.freeze({ 'BREAKING': 'Breaking.', 'NON-BREAKING': 'Non-breaking.', 'COSMETIC': 'Cosmetic.' });

// Comparisons the overlap check of added signals may make in one run before it stops.
const OVERLAP_BUDGET = 2000000;
// Start bits above this are treated as having no usable bit layout (a frame has at most 512 bits).
const MAX_LAYOUT_BIT = 4095;

const CYCLE_ATTRIBUTES = Object.freeze(['GenMsgCycleTime', 'CycleTime']);
// Attributes whose value changes how a message is sent or what a receiver starts with.
const BEHAVIOUR_ATTRIBUTES = Object.freeze(['GenMsgCycleTimeFast', 'GenMsgDelayTime', 'GenMsgStartDelayTime', 'GenMsgNrOfRepetition', 'GenMsgSendType',
  'GenSigStartValue', 'GenSigInactiveValue', 'GenSigSendType', 'VFrameFormat']);
const BEHAVIOUR_SET = new Set(BEHAVIOUR_ATTRIBUTES);

// ---- the rules ---------------------------------------------------------------------------------

const RULES = {};
function rule(code, cls, text, why) { RULES[code] = Object.freeze({ class: cls, text: CLASS_WORD[cls] + ' ' + text, why: why }); }

// database
rule('DIFF-VERSION-CHANGED', COSMETIC, 'The version text of the file changed.', 'which no receiver reads when it decodes frames');
rule('DIFF-FILE-COMMENT-CHANGED', COSMETIC, 'The comment on the whole database was added, removed or changed.', 'which is documentation only');
rule('DIFF-NODE-ADDED', NON_BREAKING, 'A node (control unit) was added to the node list.', 'so no existing message or signal changes');
rule('DIFF-NODE-REMOVED', BREAKING, 'A node was removed from the node list.', 'so tools and simulations that address the node by name no longer find it');
rule('DIFF-NODE-COMMENT-CHANGED', COSMETIC, 'The comment on a node was added, removed or changed.', 'which is documentation only');
rule('DIFF-NODE-ORDER-CHANGED', COSMETIC, 'The nodes that exist in both files are listed in another order.', 'which does not change any node');
rule('DIFF-VALUE-TABLE-ADDED', NON_BREAKING, 'A named value table (VAL_TABLE_) was added.', 'so nothing that exists today depends on it');
rule('DIFF-VALUE-TABLE-REMOVED', BREAKING, 'A named value table was removed.', 'so tools that look the table up by name no longer find it');
rule('DIFF-VALUE-TABLE-RENAMED', COSMETIC, 'A named value table kept all its entries and received another name.', 'which does not change any raw value or description');
rule('DIFF-VALUE-TABLE-ENTRY-ADDED', NON_BREAKING, 'An entry was added to a named value table.', 'so existing entries keep their meaning');
rule('DIFF-VALUE-TABLE-ENTRY-REMOVED', BREAKING, 'An entry was removed from a named value table.', 'so the raw value no longer has a description');
rule('DIFF-VALUE-TABLE-ENTRY-CHANGED', BREAKING, 'The description of a raw value in a named value table changed.', 'so the same raw value now has another meaning');
rule('DIFF-VALUE-TABLE-ORDER-CHANGED', COSMETIC, 'The named value tables that exist in both files are listed in another order.', 'which does not change any table');
rule('DIFF-ATTRIBUTE-DEFINITION-CHANGED', COSMETIC, 'The definition of an attribute (BA_DEF_) was added, removed or changed.', 'while the attribute values that matter are reported on their own');
rule('DIFF-ATTRIBUTE-DEFAULT-CHANGED', COSMETIC, 'The default value of an attribute (BA_DEF_DEF_) was added, removed or changed.', 'which is reported as a change of a value only for the cycle time and the send-behaviour attributes');
rule('DIFF-ATTRIBUTE-ADDED', NON_BREAKING, 'An attribute that is not about timing or send behaviour got a value on an object that had none.', 'and such an attribute does not change how bytes are decoded');
rule('DIFF-ATTRIBUTE-REMOVED', NON_BREAKING, 'An attribute that is not about timing or send behaviour lost its value on an object.', 'and such an attribute does not change how bytes are decoded');
rule('DIFF-ATTRIBUTE-CHANGED', NON_BREAKING, 'The value of an attribute that is not about timing or send behaviour changed.', 'and such an attribute does not change how bytes are decoded');
rule('DIFF-BEHAVIOUR-ATTRIBUTE-CHANGED', BREAKING, 'A send-behaviour attribute (send type, delays, repetitions, start or inactive value, frame format) was added, removed or changed.', 'so receivers and test setups that rely on the old behaviour no longer match');
rule('DIFF-CYCLE-TIME-CHANGED', BREAKING, 'The cycle time of a message (GenMsgCycleTime or CycleTime) was added, removed or changed.', 'so timeout monitoring and simulations built on the old period no longer match');
// messages
rule('DIFF-MESSAGE-ADDED', NON_BREAKING, 'A message was added.', 'so no receiver of an existing message is affected');
rule('DIFF-MESSAGE-REMOVED', BREAKING, 'A message of the old file is not in the new file.', 'so receivers that expect its frames no longer get them');
rule('DIFF-MESSAGE-ID-CHANGED', BREAKING, 'A message kept its name and its signals but received another identifier.', 'so receivers that filter on the old identifier no longer see it');
rule('DIFF-MESSAGE-FRAME-FORMAT-CHANGED', BREAKING, 'A message kept its name, its frame number and its signals but changed between a standard 11-bit and an extended 29-bit identifier.', 'so it is a different identifier on the bus');
rule('DIFF-MESSAGE-RENAMED', BREAKING, 'A message kept its identifier but received another name.', 'so tools and code that look it up by name no longer find it');
rule('DIFF-MESSAGE-DLC-INCREASED', NON_BREAKING, 'The data length of a message grew.', 'so the signals that were there before keep their bit positions');
rule('DIFF-MESSAGE-DLC-DECREASED', BREAKING, 'The data length of a message shrank.', 'so signals and receivers that use the removed bytes are cut off');
rule('DIFF-MESSAGE-SENDER-CHANGED', BREAKING, 'The sending node of a message changed.', 'so the frame now comes from another node');
rule('DIFF-MESSAGE-TRANSMITTER-ADDED', NON_BREAKING, 'A further transmitter (BO_TX_BU_) was added to a message.', 'so existing senders and receivers are unchanged');
rule('DIFF-MESSAGE-TRANSMITTER-REMOVED', BREAKING, 'A further transmitter (BO_TX_BU_) was removed from a message.', 'so a node that sent the frame no longer does');
rule('DIFF-MESSAGE-COMMENT-CHANGED', COSMETIC, 'The comment on a message was added, removed or changed.', 'which is documentation only');
rule('DIFF-MESSAGE-ORDER-CHANGED', COSMETIC, 'The messages that exist in both files are listed in another order.', 'which does not change any message');
rule('DIFF-SIGNAL-ORDER-CHANGED', COSMETIC, 'The signals that exist in both versions of a message are listed in another order.', 'which does not change any signal');
// signals
rule('DIFF-SIGNAL-ADDED', NON_BREAKING, 'A signal was added to a message on bits that no existing signal uses.', 'so the existing signals are read from the same bits as before');
rule('DIFF-SIGNAL-ADDED-OVERLAP', BREAKING, 'A signal was added on bits that an existing signal of the same message also uses.', 'so the two signals corrupt each other');
rule('DIFF-SIGNAL-REMOVED', BREAKING, 'A signal of the old file is not in the new file.', 'so receivers that read it no longer find it');
rule('DIFF-SIGNAL-RENAMED', BREAKING, 'A signal kept its bits and its scaling but received another name.', 'so receivers that look it up by name no longer find it');
rule('DIFF-SIGNAL-START-BIT-CHANGED', BREAKING, 'The start bit of a signal changed and the signal now uses other bits.', 'so receivers read the value from the wrong place');
rule('DIFF-SIGNAL-LENGTH-CHANGED', BREAKING, 'The length of a signal in bits changed.', 'so receivers read a different number of bits');
rule('DIFF-SIGNAL-BYTE-ORDER-CHANGED', BREAKING, 'A signal changed between little-endian (Intel) and big-endian (Motorola) and now uses other bits or a different bit significance.', 'so the same start bit and length describe different bits');
rule('DIFF-SIGNAL-LAYOUT-REWRITTEN', COSMETIC, 'The start bit or byte order of a signal is written differently, but the signal occupies the same bits with the same bit significance.', 'so every decoded value stays the same');
rule('DIFF-SIGNAL-SIGN-CHANGED', BREAKING, 'A signal changed between unsigned and signed.', 'so the same bits give different values');
rule('DIFF-SIGNAL-VALUE-TYPE-CHANGED', BREAKING, 'A signal changed between an integer and a 32-bit or 64-bit float.', 'so the same bits give different values');
rule('DIFF-SIGNAL-FACTOR-CHANGED', BREAKING, 'The factor of a signal changed (compared as exact decimals).', 'so receivers that apply the old factor read wrong values');
rule('DIFF-SIGNAL-OFFSET-CHANGED', BREAKING, 'The offset of a signal changed (compared as exact decimals).', 'so receivers that apply the old offset read wrong values');
rule('DIFF-SIGNAL-UNIT-CHANGED', BREAKING, 'The unit of a signal changed.', 'so the same number now means another quantity or scale to the reader');
rule('DIFF-SIGNAL-RANGE-NARROWED', BREAKING, 'The minimum and maximum of a signal no longer contain the old range.', 'so values that were valid before may now be outside the range');
rule('DIFF-SIGNAL-RANGE-WIDENED', NON_BREAKING, 'The minimum and maximum of a signal now contain the old range and more.', 'so every value that was valid before is still valid');
rule('DIFF-SIGNAL-RECEIVER-ADDED', NON_BREAKING, 'A node was added to the receivers of a signal.', 'so existing receivers are unchanged');
rule('DIFF-SIGNAL-RECEIVER-REMOVED', BREAKING, 'A node was removed from the receivers of a signal.', 'so that node is no longer documented as a reader of the signal');
rule('DIFF-SIGNAL-COMMENT-CHANGED', COSMETIC, 'The comment on a signal was added, removed or changed.', 'which is documentation only');
rule('DIFF-VALUE-DESCRIPTION-ADDED', NON_BREAKING, 'A value description (VAL_) was added for a raw value of a signal.', 'so existing descriptions keep their meaning');
rule('DIFF-VALUE-DESCRIPTION-REMOVED', BREAKING, 'A value description was removed from a signal.', 'so the raw value no longer has a description');
rule('DIFF-VALUE-DESCRIPTION-CHANGED', BREAKING, 'The description of a raw value of a signal changed.', 'so the same raw value now has another meaning');
rule('DIFF-VALUE-DESCRIPTION-WHITESPACE', COSMETIC, 'A value description differs only in spaces.', 'which does not change its meaning');
rule('DIFF-MUX-ROLE-CHANGED', BREAKING, 'The multiplexing role of a signal changed (multiplexor, multiplexed value, both or neither).', 'so the signal is present in other frames than before');
rule('DIFF-MUX-RANGES-CHANGED', BREAKING, 'The extended multiplexing (SG_MUL_VAL_) of a signal changed: another multiplexor or other value ranges.', 'so the signal is present in other frames than before');

Object.freeze(RULES);

function isRule(code) { return Object.prototype.hasOwnProperty.call(RULES, code); }

// ---- small helpers -----------------------------------------------------------------------------

function clip(s, n) { const t = String(s); const m = n || 48; return t.length > m ? t.slice(0, m - 1) + '…' : t; }
function q(name) { return '"' + clip(name) + '"'; }
function decText(text) { const d = D.cached(text); return d ? D.toString(d) : null; }
function sameNumber(a, b) {
  const x = D.cached(a);
  const y = D.cached(b);
  return x && y ? D.cmp(x, y) === 0 : a === b;
}
function normWs(t) { return String(t).replace(/\s+/g, ' ').trim(); }
function nodeText(name) { return name === P.NO_NODE ? '(none)' : name; }

function idLabel(m) {
  if (!isFinite(m.rawId)) return m.idText;
  return V.hex(m.frameId) + (m.extended ? ' (extended)' : ' (standard)');
}

function layoutFor(s) {
  if (!(s.length >= 1 && s.length <= 64) || !Number.isInteger(s.startBit) || s.startBit < 0 || s.startBit > MAX_LAYOUT_BIT) return null;
  return B.layoutOf(s.startBit, s.length, s.little);
}

function sameList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Pairs two lists by a key; equal keys are paired in order of appearance. */
function pairByKey(oldList, newList, keyFn) {
  const queues = new Map();
  for (const item of newList) {
    const k = keyFn(item);
    let queue = queues.get(k);
    if (!queue) { queue = { list: [], pos: 0 }; queues.set(k, queue); }
    queue.list.push(item);
  }
  const pairs = [];
  const removed = [];
  const taken = new Set();
  for (const o of oldList) {
    const queue = queues.get(keyFn(o));
    if (queue && queue.pos < queue.list.length) {
      const n = queue.list[queue.pos++];
      taken.add(n);
      pairs.push({ o: o, n: n });
    } else removed.push(o);
  }
  const added = newList.filter(function (n) { return !taken.has(n); });
  return { pairs: pairs, removed: removed, added: added };
}

/** The first item of every distinct name, in file order. */
function firstByName(list) {
  const seen = new Set();
  const out = [];
  for (const it of list) { if (!seen.has(it.name)) { seen.add(it.name); out.push(it); } }
  return out;
}

/** True when the new positions of pairs listed in old order do not increase. */
function orderChanged(newPositions) {
  for (let i = 1; i < newPositions.length; i++) if (newPositions[i] <= newPositions[i - 1]) return true;
  return false;
}

function collect(ctx, fn) {
  const saved = ctx.changes;
  ctx.changes = [];
  try { fn(); return ctx.changes; } finally { ctx.changes = saved; }
}

function add(ctx, code, f) {
  const r = RULES[code];
  const val = function (x) { return x === undefined || x === null ? '' : String(x); };
  ctx.changes.push({
    code: code, class: r.class, kind: f.kind, message: val(f.message), id: val(f.id), signal: val(f.signal), field: val(f.field),
    oldValue: val(f.oldValue), newValue: val(f.newValue), text: f.what + ', ' + r.why + '.',
    oldOffset: typeof f.oldOffset === 'number' ? f.oldOffset : -1, newOffset: typeof f.newOffset === 'number' ? f.newOffset : -1
  });
}

// ---- attributes --------------------------------------------------------------------------------

function rawAttr(db, obj, name) {
  const own = obj && obj.attributes ? obj.attributes.get(name) : undefined;
  if (own) return own.value;
  const d = db.attributeDefaultByName ? db.attributeDefaultByName.get(name) : undefined;
  return d ? d.value : null;
}

function enumName(def, value) {
  if (!def || def.type !== 'ENUM' || !def.enumValues) return null;
  if (value.isString) return def.enumValues.indexOf(value.text) !== -1 ? value.text : null;
  const d = D.cached(value.text);
  if (d && D.isInteger(d) && d.n >= 0n && d.n < BigInt(def.enumValues.length)) return def.enumValues[Number(d.n)];
  return null;
}

function valueKey(def, value) {
  if (!value) return null;
  const e = enumName(def, value);
  if (e !== null) return 'e:' + e;
  if (!value.isString) return 'n:' + (decText(value.text) || value.text);
  return 's:' + value.text;
}

function valueShown(def, value) {
  if (!value) return '';
  const e = enumName(def, value);
  if (e !== null) return e;
  return value.isString ? '"' + clip(value.text, 60) + '"' : clip(value.text, 60);
}

function defKey(def) {
  if (!def) return null;
  return [def.objectType, def.type, def.min === null ? '' : (decText(def.min) || def.min), def.max === null ? '' : (decText(def.max) || def.max), def.enumValues ? def.enumValues.join('\u0001') : ''].join('|');
}

function defShown(def) {
  if (!def) return '';
  let t = (def.objectType || 'database') + ' ' + def.type;
  if (def.min !== null) t += ' ' + def.min + ' ' + def.max;
  if (def.enumValues) t += ' ' + def.enumValues.map(function (x) { return '"' + clip(x, 30) + '"'; }).join(', ');
  return clip(t, 120);
}

function scopeOf(ctx, name) {
  const def = ctx.b.attributeDefByName.get(name) || ctx.a.attributeDefByName.get(name);
  return def ? def.objectType : '';
}

/** Differences of the attribute values of one matched object. `w` describes where it is. */
function diffObjectAttributes(ctx, oldObj, newObj, scope, w, label) {
  const names = [];
  const seen = new Set();
  const push = function (n) { if (!seen.has(n)) { seen.add(n); names.push(n); } };
  if (oldObj && oldObj.attributes) for (const k of oldObj.attributes.keys()) push(k);
  if (newObj && newObj.attributes) for (const k of newObj.attributes.keys()) push(k);
  for (const n of ctx.behaviourDefaultNames) if (scopeOf(ctx, n) === scope) push(n);
  for (const name of names) {
    if (CYCLE_ATTRIBUTES.indexOf(name) !== -1) continue;
    const defA = ctx.a.attributeDefByName.get(name);
    const defB = ctx.b.attributeDefByName.get(name);
    const va = rawAttr(ctx.a, oldObj, name);
    const vb = rawAttr(ctx.b, newObj, name);
    const ka = valueKey(defA, va);
    const kb = valueKey(defB, vb);
    if (ka === kb) {
      // The same effective value; one file writes it out and the other leaves it to the default.
      const ea = oldObj && oldObj.attributes ? oldObj.attributes.get(name) : undefined;
      const eb = newObj && newObj.attributes ? newObj.attributes.get(name) : undefined;
      if (!ea !== !eb) { ctx.writtenOut.push(ea ? 'old' : 'new'); }
      continue;
    }
    const code = BEHAVIOUR_SET.has(name) ? 'DIFF-BEHAVIOUR-ATTRIBUTE-CHANGED' : ka === null ? 'DIFF-ATTRIBUTE-ADDED' : kb === null ? 'DIFF-ATTRIBUTE-REMOVED' : 'DIFF-ATTRIBUTE-CHANGED';
    const shownA = valueShown(defA, va);
    const shownB = valueShown(defB, vb);
    const what = ka === null ? 'The attribute ' + q(name) + ' of ' + label + ' was set to ' + shownB
      : kb === null ? 'The attribute ' + q(name) + ' of ' + label + ' was removed (it was ' + shownA + ')'
        : 'The attribute ' + q(name) + ' of ' + label + ' changed from ' + shownA + ' to ' + shownB;
    const oa = oldObj && oldObj.attributes ? oldObj.attributes.get(name) : undefined;
    const ob = newObj && newObj.attributes ? newObj.attributes.get(name) : undefined;
    add(ctx, code, Object.assign({}, w, { kind: 'attribute', field: name, oldValue: shownA, newValue: shownB, what: what, oldOffset: oa ? oa.start : -1, newOffset: ob ? ob.start : -1 }));
  }
}

// ---- database level ----------------------------------------------------------------------------

function diffVersion(ctx) {
  const a = ctx.a;
  const b = ctx.b;
  const va = a.version ? a.version.text : '';
  const vb = b.version ? b.version.text : '';
  if (va !== vb) {
    add(ctx, 'DIFF-VERSION-CHANGED', { kind: 'database', field: 'version', oldValue: va, newValue: vb, what: 'The version text changed from ' + q(va) + ' to ' + q(vb), oldOffset: a.version ? a.version.start : -1, newOffset: b.version ? b.version.start : -1 });
  }
  const ca = a.fileComment || '';
  const cb = b.fileComment || '';
  if (ca !== cb) add(ctx, 'DIFF-FILE-COMMENT-CHANGED', { kind: 'database', field: 'comment', oldValue: clip(ca, 80), newValue: clip(cb, 80), what: 'The comment on the whole database changed' });
}

function diffNodes(ctx) {
  const oldNodes = firstByName(ctx.a.nodes);
  const newNodes = firstByName(ctx.b.nodes);
  const newMap = new Map(newNodes.map(function (n, i) { return [n.name, { node: n, pos: i }]; }));
  const oldMap = new Map(oldNodes.map(function (n) { return [n.name, n]; }));
  const positions = [];
  for (const n of oldNodes) {
    const hit = newMap.get(n.name);
    if (!hit) {
      add(ctx, 'DIFF-NODE-REMOVED', { kind: 'node', field: 'name', oldValue: n.name, what: 'The node ' + q(n.name) + ' was removed from the node list', oldOffset: n.start });
      continue;
    }
    ctx.matched.nodes++;
    positions.push(hit.pos);
    if ((n.comment || '') !== (hit.node.comment || '')) {
      add(ctx, 'DIFF-NODE-COMMENT-CHANGED', { kind: 'node', field: 'comment', oldValue: clip(n.comment || '', 80), newValue: clip(hit.node.comment || '', 80), what: 'The comment on the node ' + q(n.name) + ' changed', oldOffset: n.start, newOffset: hit.node.start });
    }
    diffObjectAttributes(ctx, n, hit.node, 'BU_', { kind: 'node' }, 'the node ' + q(n.name));
  }
  for (const n of newNodes) {
    if (!oldMap.has(n.name)) add(ctx, 'DIFF-NODE-ADDED', { kind: 'node', field: 'name', newValue: n.name, what: 'The node ' + q(n.name) + ' was added to the node list', newOffset: n.start });
  }
  if (orderChanged(positions)) add(ctx, 'DIFF-NODE-ORDER-CHANGED', { kind: 'node', field: 'order', what: 'The nodes are listed in another order' });
}

function entryMap(entries) {
  const m = new Map();
  for (const e of entries) { const k = e.value.toString(); if (!m.has(k)) m.set(k, e); }
  return m;
}

function entriesSignature(entries) {
  const m = entryMap(entries);
  return Array.from(m.keys()).sort().map(function (k) { return k + '=' + m.get(k).text; }).join('\u0001');
}

/** Compares two lists of (raw value, description) entries; `table` selects the codes of value tables. */
function diffEntries(ctx, oldEntries, newEntries, w, label, table) {
  const mo = entryMap(oldEntries);
  const mn = entryMap(newEntries);
  const kind = table ? 'valueTable' : 'valueDescription';
  const prefix = table ? 'DIFF-VALUE-TABLE-ENTRY-' : 'DIFF-VALUE-DESCRIPTION-';
  for (const [k, e] of mo) {
    const n = mn.get(k);
    if (!n) {
      add(ctx, prefix + 'REMOVED', Object.assign({}, w, { kind: kind, field: k, oldValue: e.text, what: 'The description ' + q(e.text) + ' of the raw value ' + k + ' of ' + label + ' was removed', oldOffset: e.start }));
    } else if (n.text !== e.text) {
      const code = normWs(n.text) === normWs(e.text) ? 'DIFF-VALUE-DESCRIPTION-WHITESPACE' : prefix + 'CHANGED';
      add(ctx, code, Object.assign({}, w, { kind: kind, field: k, oldValue: e.text, newValue: n.text, what: 'The description of the raw value ' + k + ' of ' + label + ' changed from ' + q(e.text) + ' to ' + q(n.text), oldOffset: e.start, newOffset: n.start }));
    }
  }
  for (const [k, e] of mn) {
    if (!mo.has(k)) add(ctx, prefix + 'ADDED', Object.assign({}, w, { kind: kind, field: k, newValue: e.text, what: 'The raw value ' + k + ' of ' + label + ' got the description ' + q(e.text), newOffset: e.start }));
  }
}

function diffValueTables(ctx) {
  const oldTables = firstByName(ctx.a.valueTables);
  const newTables = firstByName(ctx.b.valueTables);
  const newMap = new Map(newTables.map(function (t, i) { return [t.name, { table: t, pos: i }]; }));
  const oldMap = new Map(oldTables.map(function (t) { return [t.name, t]; }));
  const removed = oldTables.filter(function (t) { return !newMap.has(t.name); });
  const added = newTables.filter(function (t) { return !oldMap.has(t.name); });
  // A table that only has another name: the same entries, unique on both sides.
  const sigOld = new Map();
  const sigNew = new Map();
  for (const t of removed) { const s = entriesSignature(t.entries); sigOld.set(s, (sigOld.get(s) || 0) + 1); }
  for (const t of added) { const s = entriesSignature(t.entries); sigNew.set(s, (sigNew.get(s) || 0) + 1); }
  const renamedTo = new Map();
  const renamedFrom = new Set();
  const addedBySig = new Map(added.map(function (t) { return [entriesSignature(t.entries), t]; }));
  for (const t of removed) {
    const s = entriesSignature(t.entries);
    if (sigOld.get(s) === 1 && sigNew.get(s) === 1) { renamedTo.set(t, addedBySig.get(s)); renamedFrom.add(addedBySig.get(s)); }
  }
  const positions = [];
  for (const t of oldTables) {
    const hit = newMap.get(t.name);
    if (!hit) {
      const to = renamedTo.get(t);
      if (to) add(ctx, 'DIFF-VALUE-TABLE-RENAMED', { kind: 'valueTable', field: 'name', oldValue: t.name, newValue: to.name, what: 'The value table ' + q(t.name) + ' is now called ' + q(to.name), oldOffset: t.nameStart, newOffset: to.nameStart });
      else add(ctx, 'DIFF-VALUE-TABLE-REMOVED', { kind: 'valueTable', field: 'name', oldValue: t.name, what: 'The value table ' + q(t.name) + ' was removed', oldOffset: t.nameStart });
      continue;
    }
    ctx.matched.valueTables++;
    positions.push(hit.pos);
    diffEntries(ctx, t.entries, hit.table.entries, { oldOffset: t.nameStart, newOffset: hit.table.nameStart }, 'the value table ' + q(t.name), true);
  }
  for (const t of added) {
    if (!renamedFrom.has(t)) add(ctx, 'DIFF-VALUE-TABLE-ADDED', { kind: 'valueTable', field: 'name', newValue: t.name, what: 'The value table ' + q(t.name) + ' was added', newOffset: t.nameStart });
  }
  if (orderChanged(positions)) add(ctx, 'DIFF-VALUE-TABLE-ORDER-CHANGED', { kind: 'valueTable', field: 'order', what: 'The value tables are listed in another order' });
}

function diffAttributeDefinitions(ctx) {
  const a = ctx.a;
  const b = ctx.b;
  const names = [];
  const seen = new Set();
  const push = function (n) { if (!seen.has(n)) { seen.add(n); names.push(n); } };
  for (const d of a.attributeDefs) push(d.name);
  for (const d of b.attributeDefs) push(d.name);
  for (const d of a.attributeDefaults) push(d.name);
  for (const d of b.attributeDefaults) push(d.name);
  for (const name of names) {
    const da = a.attributeDefByName.get(name);
    const db = b.attributeDefByName.get(name);
    const ka = defKey(da);
    const kb = defKey(db);
    if (ka !== kb) {
      const what = ka === null ? 'The attribute ' + q(name) + ' was defined (' + defShown(db) + ')' : kb === null ? 'The definition of the attribute ' + q(name) + ' was removed (it was ' + defShown(da) + ')' : 'The definition of the attribute ' + q(name) + ' changed from ' + defShown(da) + ' to ' + defShown(db);
      add(ctx, 'DIFF-ATTRIBUTE-DEFINITION-CHANGED', { kind: 'attribute', field: name, oldValue: defShown(da), newValue: defShown(db), what: what, oldOffset: da ? da.start : -1, newOffset: db ? db.start : -1 });
    }
    const fa = a.attributeDefaultByName.get(name);
    const fb = b.attributeDefaultByName.get(name);
    const va = fa ? fa.value : null;
    const vb = fb ? fb.value : null;
    const dka = valueKey(da, va);
    const dkb = valueKey(db, vb);
    if (dka !== dkb) {
      const shownA = valueShown(da, va);
      const shownB = valueShown(db, vb);
      const what = dka === null ? 'The default of the attribute ' + q(name) + ' was set to ' + shownB : dkb === null ? 'The default of the attribute ' + q(name) + ' was removed (it was ' + shownA + ')' : 'The default of the attribute ' + q(name) + ' changed from ' + shownA + ' to ' + shownB;
      add(ctx, 'DIFF-ATTRIBUTE-DEFAULT-CHANGED', { kind: 'attribute', field: name, oldValue: shownA, newValue: shownB, what: what, oldOffset: fa ? fa.start : -1, newOffset: fb ? fb.start : -1 });
    }
    if (BEHAVIOUR_SET.has(name) && (ka !== kb || dka !== dkb)) ctx.behaviourDefaultNames.push(name);
  }
}

// ---- messages ----------------------------------------------------------------------------------

function messageKey(m) { return isFinite(m.rawId) ? (m.extended ? 'x' : 's') + m.frameId : 'i' + m.idText; }

function signalNameSet(m) { return new Set(m.signals.map(function (s) { return s.name; })); }

function sameSignalNames(a, b) {
  const sa = signalNameSet(a);
  const sb = signalNameSet(b);
  if (sa.size !== sb.size) return false;
  for (const n of sa) if (!sb.has(n)) return false;
  return true;
}

/** Messages that are gone and new at once, with the same name and the same signals: one identifier change. */
function pairIdChanges(removed, added, pairs) {
  const addedByName = new Map();
  for (const m of added) { const l = addedByName.get(m.name); if (l) l.push(m); else addedByName.set(m.name, [m]); }
  const removedCount = new Map();
  for (const m of removed) removedCount.set(m.name, (removedCount.get(m.name) || 0) + 1);
  const usedOld = new Set();
  const usedNew = new Set();
  for (const r of removed) {
    const l = addedByName.get(r.name);
    if (!l || l.length !== 1 || removedCount.get(r.name) !== 1) continue;
    if (!sameSignalNames(r, l[0])) continue;
    pairs.push({ o: r, n: l[0], idChanged: true });
    usedOld.add(r);
    usedNew.add(l[0]);
  }
  return { removed: removed.filter(function (m) { return !usedOld.has(m); }), added: added.filter(function (m) { return !usedNew.has(m); }) };
}

function compareMessages(x, y) {
  const ex = x.extended ? 1 : 0;
  const ey = y.extended ? 1 : 0;
  if (ex !== ey) return ex - ey;
  const ix = isFinite(x.frameId) ? x.frameId : Infinity;
  const iy = isFinite(y.frameId) ? y.frameId : Infinity;
  if (ix !== iy) return ix < iy ? -1 : 1;
  if (x.name !== y.name) return x.name < y.name ? -1 : 1;
  return x.index - y.index;
}

function messageWhere(m, o) {
  return { kind: 'message', message: m.name, id: V.idText(m), oldOffset: o ? o.nameStart : -1, newOffset: m.nameStart };
}

function diffSet(ctx, listOld, listNew, codeAdded, codeRemoved, w, label, what) {
  const so = new Set(listOld);
  const sn = new Set(listNew);
  for (const x of listOld) if (!sn.has(x)) add(ctx, codeRemoved, Object.assign({}, w, { oldValue: x, what: what(x, false) + label }));
  for (const x of listNew) if (!so.has(x)) add(ctx, codeAdded, Object.assign({}, w, { newValue: x, what: what(x, true) + label }));
}

function diffMessage(ctx, pair) {
  const o = pair.o;
  const n = pair.n;
  ctx.matched.messages++;
  const w = messageWhere(n, o);
  const label = 'message ' + q(n.name);
  if (pair.idChanged) {
    ctx.matched.idChanged++;
    if (o.frameId === n.frameId && o.extended !== n.extended) {
      add(ctx, 'DIFF-MESSAGE-FRAME-FORMAT-CHANGED', Object.assign({}, w, { field: 'id', oldValue: idLabel(o), newValue: idLabel(n), what: 'The ' + label + ' changed from ' + idLabel(o) + ' to ' + idLabel(n) }));
    } else {
      add(ctx, 'DIFF-MESSAGE-ID-CHANGED', Object.assign({}, w, { field: 'id', oldValue: idLabel(o), newValue: idLabel(n), what: 'The ' + label + ' changed its identifier from ' + idLabel(o) + ' to ' + idLabel(n) }));
    }
  }
  if (o.name !== n.name) add(ctx, 'DIFF-MESSAGE-RENAMED', Object.assign({}, w, { field: 'name', oldValue: o.name, newValue: n.name, what: 'The message ' + q(o.name) + ' (' + idLabel(n) + ') is now called ' + q(n.name) }));
  if (o.size !== n.size) {
    const grew = n.size > o.size;
    add(ctx, grew ? 'DIFF-MESSAGE-DLC-INCREASED' : 'DIFF-MESSAGE-DLC-DECREASED', Object.assign({}, w, { field: 'dlc', oldValue: o.size, newValue: n.size, what: 'The data length of the ' + label + ' ' + (grew ? 'grew' : 'shrank') + ' from ' + o.size + ' to ' + n.size + ' bytes' }));
  }
  if (o.sender !== n.sender) add(ctx, 'DIFF-MESSAGE-SENDER-CHANGED', Object.assign({}, w, { field: 'sender', oldValue: nodeText(o.sender), newValue: nodeText(n.sender), what: 'The sender of the ' + label + ' changed from ' + nodeText(o.sender) + ' to ' + nodeText(n.sender) }));
  diffSet(ctx, o.transmitters, n.transmitters, 'DIFF-MESSAGE-TRANSMITTER-ADDED', 'DIFF-MESSAGE-TRANSMITTER-REMOVED', Object.assign({}, w, { field: 'transmitters' }), ' for the ' + label, function (x, added) { return 'The node ' + q(x) + (added ? ' was added as a further transmitter' : ' was removed as a further transmitter'); });
  const ca = P.cycleTimeOf(ctx.a, o);
  const cb = P.cycleTimeOf(ctx.b, n);
  if (ca !== cb) {
    add(ctx, 'DIFF-CYCLE-TIME-CHANGED', Object.assign({}, w, { kind: 'attribute', field: 'cycle time', oldValue: ca === null ? 'none' : ca + ' ms', newValue: cb === null ? 'none' : cb + ' ms',
      what: 'The cycle time of the ' + label + ' changed from ' + (ca === null ? 'none' : ca + ' ms') + ' to ' + (cb === null ? 'none' : cb + ' ms') }));
  }
  if ((o.comment || '') !== (n.comment || '')) add(ctx, 'DIFF-MESSAGE-COMMENT-CHANGED', Object.assign({}, w, { field: 'comment', oldValue: clip(o.comment || '', 80), newValue: clip(n.comment || '', 80), what: 'The comment on the ' + label + ' changed' }));
  diffObjectAttributes(ctx, o, n, 'BO_', w, 'the ' + label);
  diffSignals(ctx, o, n, w);
}

function layoutKey(s) {
  return [s.startBit, s.length, s.little ? 1 : 0, s.signed ? 1 : 0, s.valueType, decText(s.factorText) || s.factorText, decText(s.offsetText) || s.offsetText].join('|');
}

/** Signals that are gone and new at once with the same bits and scaling: one rename each. */
function pairRenames(removed, added) {
  const inRemoved = new Map();
  const inAdded = new Map();
  for (const s of removed) { const k = layoutKey(s); const l = inRemoved.get(k); if (l) l.push(s); else inRemoved.set(k, [s]); }
  for (const s of added) { const k = layoutKey(s); const l = inAdded.get(k); if (l) l.push(s); else inAdded.set(k, [s]); }
  const pairs = [];
  const usedOld = new Set();
  const usedNew = new Set();
  for (const s of removed) {
    const k = layoutKey(s);
    const a = inAdded.get(k);
    const r = inRemoved.get(k);
    if (a && a.length === 1 && r.length === 1) { pairs.push({ o: s, n: a[0], renamed: true }); usedOld.add(s); usedNew.add(a[0]); }
  }
  return { pairs: pairs, removed: removed.filter(function (s) { return !usedOld.has(s); }), added: added.filter(function (s) { return !usedNew.has(s); }) };
}

function signalLabel(m, s) { return 'signal ' + q(s.name) + ' of message ' + q(m.name); }

function receiverSet(s) { return s.receivers.filter(function (r) { return r !== P.NO_NODE; }); }

function rangeOf(s) {
  const lo = D.cached(s.minText);
  const hi = D.cached(s.maxText);
  if (!lo || !hi) return { bad: true };
  if (D.isZero(lo) && D.isZero(hi)) return null;
  return { lo: lo, hi: hi };
}

function rangeText(s) { return '[' + s.minText + '|' + s.maxText + ']'; }

function muxKey(s) { return (s.muxValue !== null ? 'm' + s.muxValue : '') + (s.isMultiplexor ? 'M' : ''); }

function rangesKey(spec) {
  if (!spec) return '';
  const r = spec.ranges.map(function (x) { return [x.lo, x.hi]; }).sort(function (x, y) { return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0; });
  const merged = [];
  for (const x of r) {
    const last = merged[merged.length - 1];
    if (last && x[0] <= last[1] + 1n) { if (x[1] > last[1]) last[1] = x[1]; } else merged.push([x[0], x[1]]);
  }
  return spec.switchName + ':' + merged.map(function (x) { return x[0] + '-' + x[1]; }).join(',');
}

function diffSignals(ctx, om, nm, mw) {
  const first = pairByKey(om.signals, nm.signals, function (s) { return s.name; });
  const renames = pairRenames(first.removed, first.added);
  const pairs = first.pairs;
  const all = pairs.concat(renames.pairs);
  ctx.matched.signals += all.length;
  ctx.matched.renamedSignals += renames.pairs.length;

  // Order of the signals that exist in both versions (renamed ones are left out).
  const pos = pairs.map(function (p) { return p.n.index; });
  const items = [];
  let owners = null;
  let mux = null;
  const buildOwners = function () {
    if (owners) return;
    owners = new Map();
    mux = M.analyseMux(nm);
    for (const p of all) {
      if (mux.info.get(p.n).status !== 'ok') continue;
      const lay = layoutFor(p.n);
      if (!lay) continue;
      for (const bit of B.bitsOf(lay)) { let l = owners.get(bit); if (!l) owners.set(bit, l = []); l.push(p.n); }
    }
  };
  for (const p of all) items.push({ pos: p.n.index, changes: collect(ctx, function () { diffSignal(ctx, om, nm, p, mw); }) });
  for (const s of renames.added) {
    items.push({
      pos: s.index, changes: collect(ctx, function () {
        buildOwners();
        let hit = null;
        const lay = layoutFor(s);
        if (lay && mux.info.get(s).status === 'ok') hit = overlapOwner(ctx, mux, owners, s, lay);
        const w = Object.assign({}, mw, { kind: 'signal', signal: s.name, oldOffset: -1, newOffset: s.nameStart, field: 'name', newValue: s.name });
        const where = s.startBit + '|' + s.length + '@' + (s.little ? '1' : '0');
        if (hit) add(ctx, 'DIFF-SIGNAL-ADDED-OVERLAP', Object.assign(w, { what: 'The ' + signalLabel(nm, s) + ' (' + where + ') was added on bits that the signal ' + q(hit.name) + ' also uses' }));
        else add(ctx, 'DIFF-SIGNAL-ADDED', Object.assign(w, { what: 'The ' + signalLabel(nm, s) + ' (' + where + ') was added' }));
      })
    });
  }
  items.sort(function (x, y) { return x.pos - y.pos; });
  for (const it of items) for (const c of it.changes) ctx.changes.push(c);
  for (const s of renames.removed) {
    add(ctx, 'DIFF-SIGNAL-REMOVED', Object.assign({}, mw, { kind: 'signal', signal: s.name, field: 'name', oldValue: s.name, oldOffset: s.nameStart, newOffset: -1, what: 'The ' + signalLabel(om, s) + ' was removed' }));
  }
  if (orderChanged(pos)) add(ctx, 'DIFF-SIGNAL-ORDER-CHANGED', Object.assign({}, mw, { kind: 'signal', field: 'order', what: 'The signals of the message ' + q(nm.name) + ' are listed in another order' }));
}

function overlapOwner(ctx, mux, owners, s, lay) {
  for (const bit of B.bitsOf(lay)) {
    const list = owners.get(bit);
    if (!list) continue;
    for (const other of list) {
      if (--ctx.budget < 0) {
        if (!ctx.limited) { ctx.limited = true; ctx.notes.push('The check whether added signals overlap existing signals stopped after ' + OVERLAP_BUDGET + ' comparisons; signals added after that point are listed as added without that check.'); }
        return null;
      }
      if (mux.any && !M.compatible(mux, other, s)) continue;
      return other;
    }
  }
  return null;
}

function sameBits(la, lb) {
  if (!la || !lb) return false;
  return sameList(B.bitsOf(la), B.bitsOf(lb));
}

function diffSignal(ctx, om, nm, pair, mw) {
  const o = pair.o;
  const n = pair.n;
  const w = Object.assign({}, mw, { kind: 'signal', signal: n.name, oldOffset: o.nameStart, newOffset: n.nameStart });
  const label = signalLabel(nm, n);
  if (pair.renamed) add(ctx, 'DIFF-SIGNAL-RENAMED', Object.assign({}, w, { field: 'name', oldValue: o.name, newValue: n.name, what: 'The signal ' + q(o.name) + ' of message ' + q(nm.name) + ' is now called ' + q(n.name) }));

  // Bits: the same bits in the same significance order are the same signal, however they are written.
  const la = layoutFor(o);
  const lb = layoutFor(n);
  if (sameBits(la, lb)) {
    if (o.startBit !== n.startBit || o.little !== n.little) {
      add(ctx, 'DIFF-SIGNAL-LAYOUT-REWRITTEN', Object.assign({}, w, { field: 'layout', oldValue: o.startBit + '|' + o.length + '@' + (o.little ? '1' : '0'), newValue: n.startBit + '|' + n.length + '@' + (n.little ? '1' : '0'),
        what: 'The ' + label + ' is written as ' + n.startBit + '|' + n.length + '@' + (n.little ? '1' : '0') + ' instead of ' + o.startBit + '|' + o.length + '@' + (o.little ? '1' : '0') + ' and uses the same bits' }));
    }
  } else {
    if (o.startBit !== n.startBit) add(ctx, 'DIFF-SIGNAL-START-BIT-CHANGED', Object.assign({}, w, { field: 'start bit', oldValue: o.startBit, newValue: n.startBit, what: 'The start bit of the ' + label + ' changed from ' + o.startBit + ' to ' + n.startBit }));
    if (o.length !== n.length) add(ctx, 'DIFF-SIGNAL-LENGTH-CHANGED', Object.assign({}, w, { field: 'length', oldValue: o.length, newValue: n.length, what: 'The length of the ' + label + ' changed from ' + o.length + ' to ' + n.length + ' bits' }));
    if (o.little !== n.little) add(ctx, 'DIFF-SIGNAL-BYTE-ORDER-CHANGED', Object.assign({}, w, { field: 'byte order', oldValue: o.little ? 'little-endian' : 'big-endian', newValue: n.little ? 'little-endian' : 'big-endian', what: 'The byte order of the ' + label + ' changed from ' + (o.little ? 'little-endian (@1)' : 'big-endian (@0)') + ' to ' + (n.little ? 'little-endian (@1)' : 'big-endian (@0)') }));
  }
  if (o.signed !== n.signed) add(ctx, 'DIFF-SIGNAL-SIGN-CHANGED', Object.assign({}, w, { field: 'sign', oldValue: o.signed ? 'signed' : 'unsigned', newValue: n.signed ? 'signed' : 'unsigned', what: 'The ' + label + ' changed from ' + (o.signed ? 'signed' : 'unsigned') + ' to ' + (n.signed ? 'signed' : 'unsigned') }));
  if (o.valueType !== n.valueType) {
    const t = function (v) { return v === 1 ? '32-bit float' : v === 2 ? '64-bit float' : 'integer'; };
    add(ctx, 'DIFF-SIGNAL-VALUE-TYPE-CHANGED', Object.assign({}, w, { field: 'value type', oldValue: t(o.valueType), newValue: t(n.valueType), what: 'The ' + label + ' changed from ' + t(o.valueType) + ' to ' + t(n.valueType) }));
  }
  if (!sameNumber(o.factorText, n.factorText)) add(ctx, 'DIFF-SIGNAL-FACTOR-CHANGED', Object.assign({}, w, { field: 'factor', oldValue: o.factorText, newValue: n.factorText, what: 'The factor of the ' + label + ' changed from ' + o.factorText + ' to ' + n.factorText }));
  if (!sameNumber(o.offsetText, n.offsetText)) add(ctx, 'DIFF-SIGNAL-OFFSET-CHANGED', Object.assign({}, w, { field: 'offset', oldValue: o.offsetText, newValue: n.offsetText, what: 'The offset of the ' + label + ' changed from ' + o.offsetText + ' to ' + n.offsetText }));
  if (o.unit !== n.unit) add(ctx, 'DIFF-SIGNAL-UNIT-CHANGED', Object.assign({}, w, { field: 'unit', oldValue: o.unit, newValue: n.unit, what: 'The unit of the ' + label + ' changed from ' + q(o.unit) + ' to ' + q(n.unit) }));

  const ra = rangeOf(o);
  const rb = rangeOf(n);
  if (ra && ra.bad || rb && rb.bad) {
    if (o.minText !== n.minText || o.maxText !== n.maxText) add(ctx, 'DIFF-SIGNAL-RANGE-NARROWED', Object.assign({}, w, { field: 'range', oldValue: rangeText(o), newValue: rangeText(n), what: 'The range of the ' + label + ' changed from ' + rangeText(o) + ' to ' + rangeText(n) + ' and could not be compared exactly' }));
  } else if (ra || rb) {
    let code = '';
    if (ra && !rb) code = 'DIFF-SIGNAL-RANGE-WIDENED';
    else if (!ra && rb) code = 'DIFF-SIGNAL-RANGE-NARROWED';
    else {
      const loCmp = D.cmp(rb.lo, ra.lo);
      const hiCmp = D.cmp(rb.hi, ra.hi);
      if (loCmp === 0 && hiCmp === 0) code = '';
      else if (loCmp <= 0 && hiCmp >= 0) code = 'DIFF-SIGNAL-RANGE-WIDENED';
      else code = 'DIFF-SIGNAL-RANGE-NARROWED';
    }
    if (code) {
      const shown = function (s, r) { return r ? rangeText(s) : 'none'; };
      add(ctx, code, Object.assign({}, w, { field: 'range', oldValue: shown(o, ra), newValue: shown(n, rb), what: 'The range of the ' + label + ' changed from ' + shown(o, ra) + ' to ' + shown(n, rb) }));
    }
  }

  diffSet(ctx, receiverSet(o), receiverSet(n), 'DIFF-SIGNAL-RECEIVER-ADDED', 'DIFF-SIGNAL-RECEIVER-REMOVED', Object.assign({}, w, { field: 'receivers' }), ' for the ' + label, function (x, added) { return 'The node ' + q(x) + (added ? ' was added as a receiver' : ' was removed as a receiver'); });

  if (muxKey(o) !== muxKey(n)) {
    add(ctx, 'DIFF-MUX-ROLE-CHANGED', Object.assign({}, w, { kind: 'multiplexing', field: 'multiplexing', oldValue: muxKey(o) || 'none', newValue: muxKey(n) || 'none', what: 'The multiplexing of the ' + label + ' changed from ' + (muxKey(o) || 'none') + ' to ' + (muxKey(n) || 'none') }));
  }
  const spa = rangesKey(o.muxSpec);
  const spb = rangesKey(n.muxSpec);
  if (spa !== spb) {
    add(ctx, 'DIFF-MUX-RANGES-CHANGED', Object.assign({}, w, { kind: 'multiplexing', field: 'SG_MUL_VAL_', oldValue: clip(spa || 'none', 80), newValue: clip(spb || 'none', 80), what: 'The extended multiplexing of the ' + label + ' changed from ' + clip(spa || 'none', 80) + ' to ' + clip(spb || 'none', 80) }));
  }

  if (o.values || n.values) diffEntries(ctx, o.values || [], n.values || [], w, 'the ' + label, false);
  if ((o.comment || '') !== (n.comment || '')) add(ctx, 'DIFF-SIGNAL-COMMENT-CHANGED', Object.assign({}, w, { field: 'comment', oldValue: clip(o.comment || '', 80), newValue: clip(n.comment || '', 80), what: 'The comment on the ' + label + ' changed' }));
  diffObjectAttributes(ctx, o, n, 'SG_', w, 'the ' + label);
}

// ---- the whole database ------------------------------------------------------------------------

// Said when the two databases hold the same content but the files are not byte for byte the same.
const FORMATTING_TEXT = 'No differences in the database content. The files differ only in how the same content is written: spacing, blank lines, line ends, the byte order mark, the way numbers are written or the order of list entries.';

function isDatabase(db) {
  return !!db && typeof db === 'object' && Array.isArray(db.messages) && Array.isArray(db.nodes) && db.attributeDefByName instanceof Map;
}

/**
 * The statements that are read over without interpretation (db.uncompared): those that exist only
 * in one of the two files, counted as a multiset. Returns { onlyOld, onlyNew, keywords }.
 */
function uncomparedDifference(oldDb, newDb) {
  const count = new Map();
  // Keys are "keyword NUL text" for the statements that are read over and "keyword NUL key" for
  // those without effect (their keys are hashes); the two kinds never share a key.
  const addKey = function (key, n, sign) { count.set(key, (count.get(key) || 0) + sign * n); };
  const addMap = function (map, sign) { if (map instanceof Map) for (const [key, n] of map) addKey(key, n, sign); };
  addMap(oldDb.uncompared, 1);
  addMap(oldDb.ineffective, 1);
  addMap(newDb.uncompared, -1);
  addMap(newDb.ineffective, -1);
  let onlyOld = 0;
  let onlyNew = 0;
  const keywords = new Set();
  for (const [key, c] of count) {
    if (c > 0) onlyOld += c; else if (c < 0) onlyNew -= c;
    if (c !== 0) { const k = key.slice(0, key.indexOf('\u0000')); keywords.add(k === '?' ? 'text outside any statement' : k); }
  }
  return { onlyOld: onlyOld, onlyNew: onlyNew, keywords: Array.from(keywords).sort(), capped: !!(oldDb.uncomparedCapped || newDb.uncomparedCapped) };
}

/**
 * Compares two databases read with parseDbc. Returns { changes, counts, matched, notes, summary }:
 * changes in a stable order (database level first, then messages by identifier, signals in the
 * order of the new file, removed signals last), counts by class, matched counts, notes about
 * limits that were reached, and a summary { text, kind, identical, total, breaking, nonBreaking, cosmetic }.
 * summary.kind is 'changes', 'statements' (only statements that are not compared differ), 'formatting'
 * (the same content written differently) or 'identical'; only the last one says "No differences".
 * options.oldFingerprint and options.newFingerprint (see sourceFingerprint in parse.js) replace the
 * fingerprint that parseDbc kept of the text, for example with that of the bytes of a saved file.
 */
function diffDatabases(oldDb, newDb, options) {
  if (!isDatabase(oldDb) || !isDatabase(newDb)) throw new TypeError('diffDatabases needs two databases read with parseDbc');
  const ctx = {
    a: oldDb, b: newDb, changes: [], notes: [], writtenOut: [], budget: OVERLAP_BUDGET, limited: false, behaviourDefaultNames: [],
    matched: { messages: 0, signals: 0, nodes: 0, valueTables: 0, idChanged: 0, renamedSignals: 0 }
  };

  const keyed = pairByKey(oldDb.messages, newDb.messages, messageKey);
  const extra = [];
  const rest = pairIdChanges(keyed.removed, keyed.added, extra);
  const pairs = keyed.pairs.concat(extra);

  diffVersion(ctx);
  diffNodes(ctx);
  diffValueTables(ctx);
  diffAttributeDefinitions(ctx);
  diffObjectAttributes(ctx, oldDb.network, newDb.network, '', { kind: 'database' }, 'the database');

  // Order of the messages that exist in both files.
  const byOld = pairs.slice().sort(function (x, y) { return x.o.index - y.o.index; });
  if (orderChanged(byOld.map(function (p) { return p.n.index; }))) add(ctx, 'DIFF-MESSAGE-ORDER-CHANGED', { kind: 'message', field: 'order', what: 'The messages are listed in another order' });

  const items = [];
  for (const p of pairs) items.push({ m: p.n, run: function () { diffMessage(ctx, p); } });
  for (const m of rest.removed) {
    items.push({ m: m, run: function () {
      add(ctx, 'DIFF-MESSAGE-REMOVED', { kind: 'message', message: m.name, id: V.idText(m), field: 'name', oldValue: m.name + ' ' + idLabel(m), what: 'The message ' + q(m.name) + ' (' + idLabel(m) + ') with ' + m.signals.length + ' signal' + (m.signals.length === 1 ? '' : 's') + ' was removed', oldOffset: m.nameStart });
    } });
  }
  for (const m of rest.added) {
    items.push({ m: m, run: function () {
      add(ctx, 'DIFF-MESSAGE-ADDED', { kind: 'message', message: m.name, id: V.idText(m), field: 'name', newValue: m.name + ' ' + idLabel(m), what: 'The message ' + q(m.name) + ' (' + idLabel(m) + ') with ' + m.signals.length + ' signal' + (m.signals.length === 1 ? '' : 's') + ' was added', newOffset: m.nameStart });
    } });
  }
  items.sort(function (x, y) { return compareMessages(x.m, y.m); });
  for (const it of items) it.run();

  const counts = { 'BREAKING': 0, 'NON-BREAKING': 0, 'COSMETIC': 0 };
  for (const c of ctx.changes) counts[c.class]++;
  const total = ctx.changes.length;
  const unc = uncomparedDifference(oldDb, newDb);
  for (const side of ctx.writtenOut) { if (side === 'old') unc.onlyOld++; else unc.onlyNew++; }
  if (ctx.writtenOut.length) unc.keywords = unc.keywords.concat(['BA_ equal to the default']).sort();
  const uncomparedCount = unc.onlyOld + unc.onlyNew;
  if (uncomparedCount) {
    ctx.notes.push('The files also differ in ' + uncomparedCount + ' statement' + (uncomparedCount === 1 ? '' : 's') + ' that CAN Atlas does not compare or that have no effect on the database (' + unc.keywords.join(', ') + '): ' +
      unc.onlyOld + ' only in the older file, ' + unc.onlyNew + ' only in the newer file. Compare those lines as text if they matter.');
  }
  if (unc.capped) ctx.notes.push('A file holds more than 50,000 different statements that CAN Atlas does not compare; only the first 50,000 of each file were compared, so the files may differ there.');
  // The content is the same only when the files themselves are: the fingerprints of the two sources (see parseDbc, or the
  // bytes of a saved file given in options) are equal. A file that was merely re-spaced, re-ordered or re-saved never reads "No differences".
  const oldPrint = options && typeof options.oldFingerprint === 'string' ? options.oldFingerprint : oldDb.fingerprint;
  const newPrint = options && typeof options.newFingerprint === 'string' ? options.newFingerprint : newDb.fingerprint;
  const sameSource = typeof oldPrint === 'string' && oldPrint === newPrint;
  const noStatementDifference = uncomparedCount === 0 && !unc.capped;
  const kind = total ? 'changes' : !noStatementDifference ? 'statements' : sameSource ? 'identical' : 'formatting';
  const text = {
    changes: total + ' difference' + (total === 1 ? '' : 's') + ': ' + counts[BREAKING] + ' breaking, ' + counts[NON_BREAKING] + ' non-breaking, ' + counts[COSMETIC] + ' cosmetic.',
    statements: 'No differences in the compared statements.',
    identical: 'No differences.',
    formatting: FORMATTING_TEXT
  }[kind];
  const summary = {
    total: total, breaking: counts[BREAKING], nonBreaking: counts[NON_BREAKING], cosmetic: counts[COSMETIC],
    oldMessages: oldDb.messages.length, newMessages: newDb.messages.length,
    identical: kind === 'identical', kind: kind, uncompared: unc,
    text: text
  };
  return { changes: ctx.changes, counts: counts, matched: ctx.matched, notes: ctx.notes, summary: summary };
}

module.exports = {
  diffDatabases: diffDatabases, FORMATTING_TEXT: FORMATTING_TEXT, RULES: RULES, CLASSES: CLASSES, isRule: isRule, BEHAVIOUR_ATTRIBUTES: BEHAVIOUR_ATTRIBUTES, CYCLE_ATTRIBUTES: CYCLE_ATTRIBUTES, OVERLAP_BUDGET: OVERLAP_BUDGET
};
