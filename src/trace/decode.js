'use strict';
// Frame decoding for trace files: finds the message of a frame, decodes its signals, keeps the
// running statistics and hands out the table rows.
//
// The values are the same as those of src/dbc/codec.js (exact BigInt arithmetic, exact decimals,
// multiplexing, value descriptions, float signals). Signals of up to 48 bits that are not floats
// are read with plain number arithmetic that stays below 2^53 and is therefore exact; longer
// signals and floats go through codec.readValue. Nothing is kept per frame except the counters
// and accumulators below and, at most, `maxRows` table rows.

const B = require('../dbc/bits');
const C = require('../dbc/codec');
const P = require('../dbc/parse');

const FAST_BITS = 48;
const SUM_LIMIT = 4503599627370496;
const EXT_FLAG = 0x80000000;
const MAX_UNKNOWN_IDS = 1000;
const MAX_SAFE = 9007199254740991n;

/** "0x123" for a standard and "0x18FF50E5" for an extended identifier. */
function idTextOf(id, extended) {
  return '0x' + id.toString(16).toUpperCase().padStart(extended ? 8 : 3, '0');
}

/** Flat list [byte, shift, mask, factor, ...] that reads a signal of at most 48 bits from the data bytes. */
function segmentsOf(layout) {
  const segs = [];
  if (layout.little) {
    let pos = layout.lsb;
    let left = layout.length;
    let weight = 1;
    while (left > 0) {
      const off = pos & 7;
      const take = Math.min(8 - off, left);
      segs.push(pos >> 3, off, (1 << take) - 1, weight);
      weight *= (1 << take);
      pos += take;
      left -= take;
    }
  } else {
    let byte = layout.msb >> 3;
    let inByte = layout.msb & 7;
    let left = layout.length;
    while (left > 0) {
      const take = Math.min(inByte + 1, left);
      segs.push(byte, inByte + 1 - take, (1 << take) - 1, 1 << take);
      left -= take;
      byte++;
      inByte = 7;
    }
  }
  return Float64Array.from(segs);
}

function clampNumber(b) { return b > MAX_SAFE ? Infinity : Number(b); }

function compileFilter(filter) {
  const f = filter || {};
  const text = typeof f.text === 'string' ? f.text.trim().toLowerCase() : '';
  const ids = Array.isArray(f.ids) && f.ids.length ? new Set(f.ids.filter(function (x) { return x && Number.isInteger(x.id); }).map(function (x) { return x.extended ? x.id + EXT_FLAG : x.id; })) : null;
  const names = Array.isArray(f.messages) && f.messages.length ? new Set(f.messages.map(function (x) { return String(x).toLowerCase(); })) : null;
  return {
    text: text, ids: ids, names: names,
    fromUs: Number.isFinite(f.fromUs) ? f.fromUs : -Infinity,
    toUs: Number.isFinite(f.toUs) ? f.toUs : Infinity
  };
}

/**
 * Creates the decoder. Options: channel (only frames of this channel, case-insensitive), filter
 * { text, ids, messages, fromUs, toUs }, maxRows (rows kept), sink (called with every matching row).
 */
function createDecoder(db, options) {
  const opts = options || {};
  const filter = compileFilter(opts.filter);
  const channel = typeof opts.channel === 'string' && opts.channel.trim() ? opts.channel.trim().toLowerCase() : null;
  const maxRows = Number.isFinite(opts.maxRows) ? Math.max(0, Math.floor(opts.maxRows)) : 100000;
  const sink = typeof opts.sink === 'function' ? opts.sink : null;
  const plans = new Map();
  const rows = [];
  const unknown = new Map();
  const counters = { framesInWindow: 0, framesOutsideWindow: 0, decodedFrames: 0, unknownFrames: 0, shortFrames: 0, shortSignals: 0, timeBackwards: 0 };
  let unknownOther = 0;
  let totalMatching = 0;
  let firstTimeUs = -1;
  let lastTimeUs = -1;

  function buildPlan(key, message, id, extended) {
    const cp = C.planOf(message);
    const n = cp.plans.length;
    const position = new Map();
    for (let k = 0; k < n; k++) position.set(cp.plans[k].signal, k);
    const msgName = message.name;
    const msgLower = msgName.toLowerCase();
    let planRow = true;
    if (filter.ids && !filter.ids.has(key)) planRow = false;
    if (planRow && filter.names && !filter.names.has(msgLower)) planRow = false;
    const sigs = new Array(n);
    const order = [];
    let undecodable = 0;
    for (let k = 0; k < n; k++) {
      const p = cp.plans[k];
      const s = p.signal;
      const S = {
        p: p, name: s.name, unit: s.unit || '', usable: p.usable, parent: -1, ranges: null, rangesNum: null, signed: s.signed, length: s.length,
        kind: 0, layoutBytes: 0, segs: null, little: s.little, full: 0, half: 0, hasFast: false, F: 0, O: 0, bigF: 0n, bigO: 0n, S: 0, values: p.values,
        rowOk: false, depth: 0,
        count: 0, small: 0, big: 0n, min: Infinity, max: -Infinity, minB: null, maxB: null, fsum: 0, fcomp: 0, fmin: Infinity, fmax: -Infinity, nonFinite: 0, firstTime: -1, lastTime: -1
      };
      S.rowOk = planRow && (!filter.text || msgLower.indexOf(filter.text) !== -1 || s.name.toLowerCase().indexOf(filter.text) !== -1);
      if (p.usable) {
        S.layoutBytes = p.layout.bytes;
        S.depth = p.info.depth || 0;
        if (p.info.parent) {
          S.parent = position.get(p.info.parent);
          S.ranges = p.info.ranges;
          S.rangesNum = p.info.ranges.map(function (r) { return [clampNumber(r[0]), clampNumber(r[1])]; });
        }
        if (p.float) S.kind = 2;
        else if (s.length <= FAST_BITS) {
          S.kind = 0;
          S.segs = segmentsOf(p.layout);
          S.full = Math.pow(2, s.length);
          S.half = Math.pow(2, s.length - 1);
          S.S = p.big.S;
          if (p.fast) { S.hasFast = true; S.F = p.fast.F; S.O = p.fast.O; } else { S.bigF = p.big.F; S.bigO = p.big.O; }
        } else S.kind = 1;
        order.push(k);
      } else undecodable++;
      sigs[k] = S;
    }
    order.sort(function (a, b) { return sigs[a].depth - sigs[b].depth || a - b; });
    const cycle = P.cycleTimeOf(db, message);
    return {
      key: key, message: message, id: id, extended: extended, idText: idTextOf(id, extended), name: msgName, sigs: sigs, order: order, n: n, undecodable: undecodable,
      anyRow: sigs.some(function (S) { return S.rowOk && S.usable; }), vals: new Array(n).fill(0), st: new Uint8Array(n), res: new Array(n).fill(null), size: message.size,
      cycleUs: cycle === null ? null : Math.round(cycle * 1000),
      frames: 0, shortFrames: 0, firstTime: -1, lastTime: -1, lastByChannel: new Map(),
      intervals: 0, psmall: 0, pbig: 0n, minPeriod: Infinity, maxPeriod: -Infinity, pmean: 0, pm2: 0, deviating: 0, maxCycleDeviation: 0
    };
  }

  function inRanges(S, v) {
    if (typeof v === 'number') {
      const r = S.rangesNum;
      for (let i = 0; i < r.length; i++) if (r[i][0] <= v && v <= r[i][1]) return true;
      return false;
    }
    const r = S.ranges;
    for (let i = 0; i < r.length; i++) if (r[i][0] <= v && v <= r[i][1]) return true;
    return false;
  }

  function physicalOfFast(S, raw) {
    return S.hasFast ? C.scaledText(raw * S.F + S.O, S.S) : C.scaledText(BigInt(raw) * S.bigF + S.bigO, S.S);
  }

  function valueTextOfFast(S, raw) {
    if (!S.values) return '';
    const hit = S.values.get(String(raw));
    if (hit !== undefined) return hit;
    if (S.signed && raw < 0) { const h2 = S.values.get(String(raw + S.full)); if (h2 !== undefined) return h2; }
    return '';
  }

  function periodStep(plan, t, ch) {
    const last = plan.lastByChannel.get(ch);
    plan.lastByChannel.set(ch, t);
    if (last === undefined) return;
    const p = t - last;
    if (p < 0) { counters.timeBackwards++; return; }
    plan.intervals++;
    plan.psmall += p;
    if (plan.psmall > SUM_LIMIT) { plan.pbig += BigInt(plan.psmall); plan.psmall = 0; }
    if (p < plan.minPeriod) plan.minPeriod = p;
    if (p > plan.maxPeriod) plan.maxPeriod = p;
    const delta = p - plan.pmean;
    plan.pmean += delta / plan.intervals;
    plan.pm2 += delta * (p - plan.pmean);
    if (plan.cycleUs !== null && Math.abs(p - plan.cycleUs) * 2 > plan.cycleUs) plan.deviating++;
  }

  function emit(plan, S, k, t, chan, raw) {
    totalMatching++;
    let row;
    if (S.kind === 0) {
      row = { timeUs: t, channel: chan, messageName: plan.name, idText: plan.idText, signalName: S.name, rawText: String(raw), physicalText: physicalOfFast(S, raw), unit: S.unit, valueText: valueTextOfFast(S, raw) };
    } else {
      const v = plan.res[k];
      row = { timeUs: t, channel: chan, messageName: plan.name, idText: plan.idText, signalName: S.name, rawText: v.rawText, physicalText: v.physical, unit: S.unit, valueText: v.text };
    }
    if (rows.length < maxRows) rows.push(row);
    if (sink) sink(row);
  }

  function decodePlan(plan, rec, t) {
    counters.decodedFrames++;
    plan.frames++;
    if (plan.firstTime < 0) plan.firstTime = t;
    plan.lastTime = t;
    periodStep(plan, t, rec.channel);
    const len = rec.len;
    const data = rec.data;
    if (len < plan.size) { plan.shortFrames++; counters.shortFrames++; }
    const sigs = plan.sigs;
    const st = plan.st;
    const vals = plan.vals;
    const order = plan.order;
    let frameObj = null;
    for (let oi = 0; oi < order.length; oi++) {
      const k = order[oi];
      const S = sigs[k];
      if (S.parent >= 0) {
        const ps = st[S.parent];
        if (ps !== 1) { st[k] = ps === 2 ? 2 : 0; if (ps === 2) counters.shortSignals++; continue; }
        if (!inRanges(S, vals[S.parent])) { st[k] = 0; continue; }
      }
      if (S.layoutBytes > len) { st[k] = 2; counters.shortSignals++; continue; }
      if (S.kind === 0) {
        const segs = S.segs;
        let v = 0;
        if (S.little) for (let i = 0; i < segs.length; i += 4) v += ((data[segs[i]] >> segs[i + 1]) & segs[i + 2]) * segs[i + 3];
        else for (let i = 0; i < segs.length; i += 4) v = v * segs[i + 3] + ((data[segs[i]] >> segs[i + 1]) & segs[i + 2]);
        if (S.signed && v >= S.half) v -= S.full;
        vals[k] = v;
        st[k] = 1;
        S.count++;
        S.small += v;
        if (S.small > SUM_LIMIT || S.small < -SUM_LIMIT) { S.big += BigInt(S.small); S.small = 0; }
        if (v < S.min) S.min = v;
        if (v > S.max) S.max = v;
      } else {
        if (frameObj === null) frameObj = B.frameOf(data, len);
        const v = C.readValue(S.p, frameObj);
        if (v === null) { st[k] = 2; counters.shortSignals++; continue; }
        plan.res[k] = v;
        vals[k] = v.raw;
        st[k] = 1;
        if (S.kind === 1) {
          S.count++;
          S.big += v.raw;
          if (S.minB === null || v.raw < S.minB) S.minB = v.raw;
          if (S.maxB === null || v.raw > S.maxB) S.maxB = v.raw;
        } else if (Number.isFinite(v.raw)) {
          S.count++;
          const y = v.raw - S.fcomp;
          const sum = S.fsum + y;
          S.fcomp = (sum - S.fsum) - y;
          S.fsum = sum;
          if (v.raw < S.fmin) S.fmin = v.raw;
          if (v.raw > S.fmax) S.fmax = v.raw;
        } else S.nonFinite++;
      }
      if (S.firstTime < 0) S.firstTime = t;
      S.lastTime = t;
    }
    if (plan.anyRow && (sink || rows.length < maxRows)) {
      const chan = rec.channel;
      for (let k = 0; k < plan.n; k++) {
        if (st[k] === 1 && sigs[k].rowOk) emit(plan, sigs[k], k, t, chan, vals[k]);
      }
    } else if (plan.anyRow) {
      for (let k = 0; k < plan.n; k++) if (st[k] === 1 && sigs[k].rowOk) totalMatching++;
    }
    st.fill(0);
  }

  /** Decodes one frame record { timeUs, channel, id, extended, len, data } (the data is not kept). */
  function frame(rec) {
    if (channel !== null && rec.channel.toLowerCase() !== channel) { counters.framesOutsideWindow++; return; }
    const t = rec.timeUs;
    if (t < filter.fromUs || t > filter.toUs) { counters.framesOutsideWindow++; return; }
    counters.framesInWindow++;
    if (firstTimeUs < 0 || t < firstTimeUs) firstTimeUs = t;
    if (t > lastTimeUs) lastTimeUs = t;
    const key = rec.extended ? rec.id + EXT_FLAG : rec.id;
    let plan = plans.get(key);
    if (plan === undefined) {
      const message = db.messageByRawId ? db.messageByRawId.get(key) : undefined;
      plan = message && !message.pseudo ? buildPlan(key, message, rec.id, rec.extended) : null;
      plans.set(key, plan);
    }
    if (plan === null) {
      counters.unknownFrames++;
      const u = unknown.get(key);
      if (u) { u.frames++; u.lastTimeUs = t; }
      else if (unknown.size < MAX_UNKNOWN_IDS) unknown.set(key, { id: rec.id, extended: rec.extended, idText: idTextOf(rec.id, rec.extended), frames: 1, firstTimeUs: t, lastTimeUs: t });
      else unknownOther++;
      return;
    }
    decodePlan(plan, rec, t);
  }

  function finish() {
    const known = [];
    for (const plan of plans.values()) if (plan !== null) known.push(plan);
    return {
      rows: rows, totalMatching: totalMatching, truncated: totalMatching > rows.length, counters: counters, plans: known,
      unknownIds: { distinct: unknown.size, frames: counters.unknownFrames, otherFrames: unknownOther, items: Array.from(unknown.values()) },
      firstTimeUs: firstTimeUs, lastTimeUs: lastTimeUs
    };
  }

  return { frame: frame, finish: finish };
}

module.exports = { createDecoder: createDecoder, idTextOf: idTextOf, segmentsOf: segmentsOf, EXT_FLAG: EXT_FLAG, FAST_BITS: FAST_BITS };
