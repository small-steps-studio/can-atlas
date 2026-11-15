'use strict';
// Multiplexing of the signals of one message.
//
// Simple multiplexing: one signal is the multiplexor (written M). A signal written m<v> is present
// only in frames whose multiplexor holds the raw value v.
//
// Extended multiplexing: SG_MUL_VAL_ statements name the multiplexor of a multiplexed signal and
// the ranges of multiplexor values for which it is present. A multiplexor may itself be
// multiplexed (written m<v>M), so multiplexors can be nested.
//
// A signal whose multiplexor cannot be determined (none, several candidates, a loop, a float
// multiplexor) is marked here and is never decoded; the checks report the reason.

const B = require('./bits');

const MAX_DEPTH = 32;
// Signals times groups that groupsOf() checks at most (about a second of work).
const GROUP_WORK = 1500000;
const NO_PARTS = Object.freeze([]);

// The record of every signal of a message without multiplexing (shared, never changed).
const PLAIN_RECORD = Object.freeze({ parent: null, ranges: null, status: 'ok', depth: 0, cond: new Map(), reason: '' });
const PLAIN_INFO = Object.freeze({ get: function () { return PLAIN_RECORD; } });

function rangesText(ranges) {
  return ranges.map(function (r) { return r[0] === r[1] ? r[0].toString() : r[0] + '-' + r[1]; }).join(', ');
}

// Lists of ranges are compared by sorting (once per list) instead of pair by pair, so that a list
// of 100,000 ranges costs 100,000 steps and not 10,000,000,000.
const NORMALISED = new WeakMap();

/** The ranges sorted and joined where they overlap or touch: [[lo, hi], ...] (BigInt, not changed afterwards). */
function normalised(ranges) {
  let out = NORMALISED.get(ranges);
  if (out) return out;
  const sorted = ranges.filter(function (r) { return r[0] <= r[1]; }).sort(function (p, q) { return p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0; });
  out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1n) { if (r[1] > last[1]) last[1] = r[1]; } else out.push([r[0], r[1]]);
  }
  NORMALISED.set(ranges, out);
  return out;
}

function intersects(a, b) {
  if (a.length * b.length <= 256) {
    for (const x of a) for (const y of b) if (x[0] <= y[1] && y[0] <= x[1]) return true;
    return false;
  }
  const p = normalised(a);
  const q = normalised(b);
  let i = 0;
  let j = 0;
  while (i < p.length && j < q.length) {
    if (p[i][0] <= q[j][1] && q[j][0] <= p[i][1]) return true;
    if (p[i][1] < q[j][1]) i++; else j++;
  }
  return false;
}

/** True when every value of `inner` lies in one of the ranges of `outer`. */
function within(inner, outer) {
  const o = normalised(outer);
  for (const x of inner) {
    // the last joined range that starts at or before the start of x
    let lo = 0;
    let hi = o.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (o[mid][0] <= x[0]) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best === -1 || x[1] > o[best][1]) return false;
  }
  return true;
}

/**
 * Analyses a message once (the result is kept on the message): { any, info, issues, switches }.
 * info maps each signal to { parent, ranges, status, depth, cond } where status is 'ok', 'bad'
 * (no usable multiplexor), 'cycle' (part of a loop) or 'parent' (its multiplexor is not usable),
 * and cond maps each multiplexor above the signal to the ranges of values it must hold.
 */
function analyseMux(message) {
  if (message._mux) return message._mux;
  const signals = message.signals;
  let any = false;
  for (const s of signals) { if (s.isMultiplexor || s.muxValue !== null || s.muxSpec) { any = true; break; } }
  if (!any) {
    // No multiplexing: every signal shares one record, so a message with very many signals costs
    // no memory here.
    const plain = { any: false, info: PLAIN_INFO, issues: [], switches: [] };
    message._mux = plain;
    return plain;
  }
  const byName = message.signalIndex || new Map(signals.map(function (s) { return [s.name, s]; }));
  const info = new Map();
  const issues = [];
  for (const s of signals) info.set(s, { parent: null, ranges: null, status: 'ok', depth: 0, cond: null, reason: '' });
  const result = { any: true, info: info, issues: issues, switches: [] };
  message._mux = result;
  function issue(code, severity, signal, text, start, end) {
    issues.push({ code: code, severity: severity, signal: signal, message: text, start: start, end: end });
  }
  const switches = signals.filter(function (s) { return s.isMultiplexor; });
  const firstSwitches = switches.slice(0, 6);
  result.switches = switches;

  for (const s of signals) {
    const me = info.get(s);
    const spec = s.muxSpec;
    if (s.muxValue === null) {
      if (spec) issue('DBC-MUX-NOT-MULTIPLEXED', 'warning', s, 'SG_MUL_VAL_ names a multiplexor for "' + s.name + '", but the signal is not written as multiplexed (m<value>); it is decoded in every frame.', spec.signalStart, spec.signalEnd);
      continue;
    }
    if (spec) {
      const sw = byName.get(spec.switchName);
      if (!sw || sw === s) {
        me.status = 'bad';
        me.reason = 'its multiplexor "' + spec.switchName + '" is not a signal of this message';
        issue('DBC-MUX-EXTENDED-UNKNOWN', 'warning', s, 'SG_MUL_VAL_ names "' + spec.switchName + '" as the multiplexor of "' + s.name + '", but this message has no other signal of that name; "' + s.name + '" is not decoded.', spec.switchStart, spec.switchEnd);
        continue;
      }
      if (!sw.isMultiplexor) {
        me.status = 'bad';
        me.reason = '"' + sw.name + '" is not a multiplexor';
        issue('DBC-MUX-EXTENDED-UNKNOWN', 'warning', s, 'SG_MUL_VAL_ names "' + sw.name + '" as the multiplexor of "' + s.name + '", but "' + sw.name + '" is not written as a multiplexor (M or m<value>M); "' + s.name + '" is not decoded.', spec.switchStart, spec.switchEnd);
        continue;
      }
      let broken = false;
      for (const r of spec.ranges) {
        if (r.lo > r.hi) {
          broken = true;
          issue('DBC-MUX-EXTENDED-RANGE', 'error', s, 'The range ' + r.lo + '-' + r.hi + ' of multiplexor values for "' + s.name + '" ends below its start; the signal is not decoded.', r.start, r.end);
        }
      }
      if (broken || !spec.ranges.length) { me.status = 'bad'; me.reason = 'its SG_MUL_VAL_ ranges are not valid'; continue; }
      me.parent = sw;
      me.ranges = spec.ranges.map(function (r) { return [r.lo, r.hi]; });
      if (!me.ranges.some(function (r) { return r[0] <= s.muxValue && s.muxValue <= r[1]; })) {
        issue('DBC-MUX-EXTENDED-MISMATCH', 'warning', s, '"' + s.name + '" is written m' + s.muxValue + ', but its SG_MUL_VAL_ ranges (' + rangesText(me.ranges) + ') do not contain ' + s.muxValue + '; decoding follows SG_MUL_VAL_.', s.muxStart, s.muxEnd);
      }
    } else {
      // The multiplexors that could select this signal: all of them, except the signal itself.
      const count = switches.length - (s.isMultiplexor ? 1 : 0);
      if (count === 1) { me.parent = switches[0] === s ? switches[1] : switches[0]; me.ranges = [[s.muxValue, s.muxValue]]; }
      else if (!count) {
        me.status = 'bad';
        me.reason = 'the message has no multiplexor';
        issue('DBC-MUX-NO-MULTIPLEXOR', 'error', s, '"' + s.name + '" is multiplexed (' + s.muxText + '), but the message has no multiplexor signal (M); the signal is not decoded.', s.muxStart, s.muxEnd);
      } else {
        me.status = 'bad';
        me.reason = 'several multiplexors could select it';
        const names = firstSwitches.filter(function (w) { return w !== s; }).slice(0, 5).map(function (w) { return w.name; });
        issue('DBC-MUX-AMBIGUOUS', 'error', s, 'The message has several multiplexors (' + names.join(', ') + (count > 5 ? ' and ' + (count - 5) + ' more' : '') + ') and no SG_MUL_VAL_ statement says which one selects "' + s.name + '"; the signal is not decoded.', s.muxStart, s.muxEnd);
      }
    }
  }

  // A float multiplexor cannot select signals by value.
  for (const w of switches) {
    if (w.valueType === 1 || w.valueType === 2) {
      issue('DBC-MUX-SWITCH-FLOAT', 'error', w, 'The multiplexor "' + w.name + '" is a floating-point signal (SIG_VALTYPE_), so it cannot select signals by value; the signals it selects are not decoded.', w.nameStart, w.nameEnd);
      for (const s of signals) { const me = info.get(s); if (me.parent === w) { me.status = 'bad'; me.reason = 'its multiplexor is a floating-point signal'; } }
    }
  }

  // Values a multiplexor cannot hold.
  for (const s of signals) {
    const me = info.get(s);
    if (me.status !== 'ok' || !me.parent) continue;
    const p = me.parent;
    if (!(p.length >= 1 && p.length <= 64)) continue;
    const range = B.rawRange(p.length, p.signed);
    const outside = me.ranges.filter(function (r) { return r[1] < range.lo || r[0] > range.hi; });
    if (outside.length === me.ranges.length) {
      issue('DBC-MUX-VALUE-RANGE', 'warning', s, 'The multiplexor "' + p.name + '" (' + p.length + ' bits, ' + (p.signed ? 'signed' : 'unsigned') + ') can never hold ' + rangesText(me.ranges) + ', so "' + s.name + '" is never present.', s.muxSpec ? s.muxSpec.signalStart : s.muxStart, s.muxSpec ? s.muxSpec.signalEnd : s.muxEnd);
    }
  }

  // Loops and multiplexors that are not usable themselves. The chains of multiplexors are followed
  // with a loop, not with recursion, so that a very long chain in a damaged file cannot overflow
  // the stack.
  const state = new Map();
  const inLoop = new Set();
  for (const first of signals) {
    if (state.has(first)) continue;
    const path = [];
    const onPath = new Set();
    let cur = first;
    let outcome;
    for (;;) {
      if (state.has(cur)) { outcome = state.get(cur); break; }
      const me = info.get(cur);
      if (me.status !== 'ok') { state.set(cur, me.status); outcome = me.status; break; }
      if (!me.parent) { state.set(cur, 'ok'); outcome = 'ok'; break; }
      if (onPath.has(cur)) {
        // `cur` closes a loop: it and everything after it on the path select each other.
        for (let k = path.indexOf(cur); k < path.length; k++) inLoop.add(path[k]);
        outcome = 'cycle';
        break;
      }
      onPath.add(cur);
      path.push(cur);
      cur = me.parent;
    }
    const out = outcome === 'ok' ? 'ok' : outcome === 'cycle' ? 'cycle' : 'parent';
    for (const x of path) state.set(x, out);
  }
  for (const s of signals) {
    const me = info.get(s);
    const st = state.get(s);
    if (st === 'cycle') {
      if (inLoop.has(s)) {
        me.status = 'cycle';
        me.reason = 'its multiplexors select each other in a loop';
        issue('DBC-MUX-CYCLE', 'error', s, 'The multiplexors of "' + s.name + '" select each other in a loop (through "' + me.parent.name + '"); the signal is not decoded.', s.muxSpec ? s.muxSpec.switchStart : s.muxStart, s.muxSpec ? s.muxSpec.switchEnd : s.muxEnd);
      } else { me.status = 'parent'; me.reason = 'its multiplexor is part of a loop'; }
    } else if (st === 'parent' && me.status === 'ok') {
      me.status = 'parent';
      me.reason = 'its multiplexor "' + me.parent.name + '" is not decoded';
    }
  }

  // Depth of the decodable signals (a chain deeper than MAX_DEPTH is refused), then the
  // conditions: for each multiplexor above a signal, the values it must hold.
  const depthOf = new Map();
  for (const first of signals) {
    if (info.get(first).status !== 'ok' || depthOf.has(first)) continue;
    // Climb to a signal whose depth is known (or to the top of the chain), then count back down.
    const path = [];
    let cur = first;
    while (cur && !depthOf.has(cur)) { path.push(cur); cur = info.get(cur).parent; }
    let d = cur ? depthOf.get(cur) + 1 : 0;
    for (let k = path.length - 1; k >= 0; k--) { depthOf.set(path[k], d); d++; }
  }
  for (const s of signals) {
    const me = info.get(s);
    if (me.status !== 'ok') continue;
    me.depth = depthOf.get(s) || 0;
    if (me.depth > MAX_DEPTH) {
      me.status = 'bad';
      me.reason = 'it is nested more than ' + MAX_DEPTH + ' levels deep below its multiplexors';
      issue('DBC-MUX-TOO-DEEP', 'error', s, 'The multiplexors of "' + s.name + '" are nested more than ' + MAX_DEPTH + ' levels deep; the signal is not decoded.', s.muxSpec ? s.muxSpec.switchStart : s.muxStart, s.muxSpec ? s.muxSpec.switchEnd : s.muxEnd);
    }
  }
  function condOf(s) {
    const me = info.get(s);
    if (me.cond) return me.cond;
    const cond = me.parent ? new Map(condOf(me.parent)) : new Map();
    if (me.parent) cond.set(me.parent, me.ranges);
    me.cond = cond;
    return cond;
  }
  for (const s of signals) {
    const me = info.get(s);
    if (me.status === 'ok') condOf(s);
  }

  // Multiplexors that select nothing.
  const selecting = new Set();
  for (const s of signals) { const p = info.get(s).parent; if (p) selecting.add(p); }
  for (const w of switches) {
    const used = selecting.has(w);
    if (!used) issue('DBC-MUX-UNUSED', 'info', w, '"' + w.name + '" is written as a multiplexor, but no signal of this message is selected by it.', w.muxStart >= 0 ? w.muxStart : w.nameStart, w.muxStart >= 0 ? w.muxEnd : w.nameEnd);
  }
  return result;
}

/** True when two decodable signals can be present in the same frame. */
function compatible(mux, a, b) {
  const ca = mux.info.get(a).cond;
  const cb = mux.info.get(b).cond;
  if (!ca || !cb) return false;
  for (const [sw, ra] of ca) {
    const rb = cb.get(sw);
    if (rb && !intersects(ra, rb)) return false;
  }
  return true;
}

/**
 * The layout groups of a message for display: one group of the signals present in every frame,
 * then one per combination of multiplexor values: [{ title, condition, signals }]. At most `limit`
 * groups (default 64); `more` counts the groups left out.
 */
function groupsOf(message, limit) {
  const mux = analyseMux(message);
  const max = limit || 64;
  const ok = message.signals.filter(function (s) { return mux.info.get(s).status === 'ok'; });
  if (!mux.any) return { groups: [{ title: 'All signals', condition: null, signals: message.signals.slice() }], more: 0, undecodable: [] };
  const base = ok.filter(function (s) { return mux.info.get(s).depth === 0; });
  const conds = new Map();
  const partsOfSignal = new Array(ok.length);
  for (let i = 0; i < ok.length; i++) {
    const s = ok[i];
    const c = mux.info.get(s).cond;
    if (!c.size) { partsOfSignal[i] = NO_PARTS; continue; }
    const parts = Array.from(c.entries()).sort(function (x, y) { return mux.info.get(x[0]).depth - mux.info.get(y[0]).depth || x[0].index - y[0].index; });
    partsOfSignal[i] = parts;
    const key = parts.map(function (p) { return p[0].name + ' = ' + rangesText(p[1]); }).join(', ');
    if (!conds.has(key)) conds.set(key, { key: key, parts: parts, cond: c });
  }
  const sorted = Array.from(conds.values()).sort(function (x, y) {
    const n = Math.min(x.parts.length, y.parts.length);
    for (let i = 0; i < n; i++) {
      if (x.parts[i][0] !== y.parts[i][0]) return x.parts[i][0].index - y.parts[i][0].index;
      const a = x.parts[i][1][0][0];
      const b = y.parts[i][1][0][0];
      if (a !== b) return a < b ? -1 : 1;
    }
    return x.parts.length - y.parts.length;
  });
  const groups = [{ title: 'Signals present in every frame', condition: null, signals: base }];
  // Every group is checked against every signal; a message with very many multiplexed signals shows
  // fewer groups (the rest is counted in `more`) so that this stays fast.
  const shown = Math.min(max, Math.max(8, Math.floor(GROUP_WORK / Math.max(1, ok.length))));
  for (const c of sorted.slice(0, shown)) {
    const members = [];
    for (let i = 0; i < ok.length; i++) {
      const parts = partsOfSignal[i];
      let all = true;
      for (let k = 0; k < parts.length; k++) { const rc = c.cond.get(parts[k][0]); if (!rc || !within(rc, parts[k][1])) { all = false; break; } }
      if (all) members.push(ok[i]);
    }
    groups.push({ title: c.key, condition: c.cond, signals: members });
  }
  return { groups: groups, more: Math.max(0, sorted.length - shown), undecodable: message.signals.filter(function (s) { return mux.info.get(s).status !== 'ok'; }) };
}

/** Plain words for the condition under which a signal is present, or '' for every frame. */
function conditionText(mux, signal) {
  const me = mux.info.get(signal);
  if (!me) return '';
  if (me.status !== 'ok') return 'not decoded: ' + me.reason;
  if (!me.cond || !me.cond.size) return '';
  const parts = Array.from(me.cond.entries()).sort(function (x, y) { return mux.info.get(x[0]).depth - mux.info.get(y[0]).depth; });
  return 'present when ' + parts.map(function (p) { return p[0].name + ' = ' + rangesText(p[1]); }).join(' and ');
}

module.exports = { analyseMux: analyseMux, compatible: compatible, groupsOf: groupsOf, conditionText: conditionText, rangesText: rangesText, intersects: intersects, within: within };
