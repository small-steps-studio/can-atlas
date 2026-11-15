'use strict';
// Decoding a frame into the signals of a message, and encoding physical values into a frame.
//
// Raw values are BigInt; physical values are exact decimals (raw * factor + offset with the
// factor and offset exactly as written). Multiplexed signals are decoded only when their
// multiplexor (and every multiplexor above it) holds a value that selects them; a signal whose
// multiplexor cannot be determined is reported as not decoded, never decoded by guess.

const D = require('./decimal');
const B = require('./bits');
const M = require('./mux');

const SAFE = 9007199254740991n;
const MAX_OVERLAP_CHECKS = 300;
const MAX_OVERLAP_NOTES = 20;

/** Text of an exact integer v / 10^S without trailing zeros (v is a Number or a BigInt). */
function scaledText(v, S) {
  if (S === 0) return String(v === 0 ? 0 : v);
  const negative = v < 0;
  let digits = String(negative ? -v : v);
  if (digits.length <= S) digits = '0'.repeat(S - digits.length + 1) + digits;
  const whole = digits.slice(0, digits.length - S);
  const frac = digits.slice(digits.length - S).replace(/0+$/, '');
  const out = whole + (frac ? '.' + frac : '');
  return negative && out !== '0' ? '-' + out : out;
}

/** The prepared signals of a message (kept on the message): layout, scaling, value texts. */
function planOf(message) {
  if (message._plan) return message._plan;
  const mux = M.analyseMux(message);
  const plans = message.signals.map(function (s) {
    const layout = s.length >= 1 && s.length <= 64 ? B.layoutOf(s.startBit, s.length, s.little) : null;
    const factor = D.cached(s.factorText);
    const offset = D.cached(s.offsetText);
    const float = s.valueType === 1 || s.valueType === 2;
    let usable = !!layout && !!factor && !!offset;
    let why = !layout ? 'its start bit or length is not valid' : (!factor || !offset) ? 'its factor or offset cannot be read' : '';
    if (usable && layout.bytes > 64) { usable = false; why = 'it lies outside the 64 bytes of the largest frame'; }
    if (usable && float && !((s.valueType === 1 && s.length === 32) || (s.valueType === 2 && s.length === 64))) { usable = false; why = 'its float type does not match its length'; }
    const st = mux.info.get(s);
    if (usable && st.status !== 'ok') { usable = false; why = st.reason; }
    let fast = null;
    let big = null;
    if (usable && !float) {
      const S = Math.max(factor.s, offset.s);
      const F = factor.n * D.pow10(S - factor.s);
      const O = offset.n * D.pow10(S - offset.s);
      big = { S: S, F: F, O: O };
      const range = B.rawRange(s.length, s.signed);
      const maxAbs = -range.lo > range.hi ? -range.lo : range.hi;
      const absF = F < 0n ? -F : F;
      const absO = O < 0n ? -O : O;
      if (maxAbs <= SAFE && maxAbs * absF + absO <= SAFE) fast = { S: S, F: Number(F), O: Number(O) };
    }
    const values = s.values ? new Map(s.values.map(function (e) { return [e.value.toString(), e.text]; })) : null;
    return { signal: s, layout: layout, factor: factor, offset: offset, float: float, usable: usable, why: why, fast: fast, big: big, values: values, info: st };
  });
  const bySignal = new Map(plans.map(function (p) { return [p.signal, p]; }));
  message._plan = { plans: plans, bySignal: bySignal, mux: mux };
  return message._plan;
}

/** The physical value text of an integer raw value (BigInt, already signed). */
function physicalOfRaw(p, raw) {
  if (p.fast) return scaledText(Number(raw) * p.fast.F + p.fast.O, p.fast.S);
  return scaledText(raw * p.big.F + p.big.O, p.big.S);
}

/** The value of a float signal as text (shortest form that reads back to the same float). */
function floatText(x, length) {
  if (Number.isNaN(x)) return 'NaN';
  if (!isFinite(x)) return x > 0 ? 'Infinity' : '-Infinity';
  const d = length === 32 ? D.fromSingle(x) : D.fromDouble(x);
  return D.toString(d);
}

/** Reads one signal: { raw, rawText, physical, text } or null when the frame is too short. */
function readValue(p, frame) {
  const u = B.extract(frame, p.layout);
  if (u === null) return null;
  if (p.float) {
    const x = B.floatOf(u, p.signal.length);
    const xt = floatText(x, p.signal.length);
    let physical = xt;
    if (isFinite(x)) physical = D.toString(D.add(D.mul(p.signal.length === 32 ? D.fromSingle(x) : D.fromDouble(x), p.factor), p.offset));
    else if (!(D.cmp(p.factor, D.ONE) === 0 && D.isZero(p.offset))) physical = xt;
    return { raw: x, rawText: xt, physical: physical, text: '', bits: u };
  }
  const raw = p.signal.signed ? B.toSigned(u, p.signal.length) : u;
  let text = '';
  if (p.values) {
    const hit = p.values.get(raw.toString());
    if (hit !== undefined) text = hit;
    else if (p.signal.signed) { const h2 = p.values.get(u.toString()); if (h2 !== undefined) text = h2; }
  }
  return { raw: raw, rawText: raw.toString(), physical: physicalOfRaw(p, raw), text: text, bits: u };
}

/**
 * Decodes a frame with the signals of a message. Returns { rows, length } where each row is
 * { plan, signal, status, raw, rawText, physical, text, reason } with status 'ok', 'absent'
 * (multiplexed out), 'short' (the frame is too short for it) or 'undecodable'.
 */
function decodeMessage(message, bytes, length) {
  const plan = planOf(message);
  const frame = B.frameOf(bytes, length);
  const values = new Map();
  const presence = new Map();
  function valueOf(p) {
    if (values.has(p)) return values.get(p);
    const v = readValue(p, frame);
    values.set(p, v);
    return v;
  }
  function presentOf(p) {
    if (presence.has(p)) return presence.get(p);
    let out;
    if (!p.usable) out = 'undecodable';
    else if (!p.info.parent) out = true;
    else {
      const pp = plan.bySignal.get(p.info.parent);
      const up = presentOf(pp);
      if (up !== true) out = up === 'short' ? 'short' : up === 'undecodable' ? 'undecodable' : false;
      else {
        const v = valueOf(pp);
        if (!v) out = 'short';
        else out = p.info.ranges.some(function (r) { return r[0] <= v.raw && v.raw <= r[1]; });
      }
    }
    presence.set(p, out);
    return out;
  }
  const rows = plan.plans.map(function (p) {
    const pres = presentOf(p);
    if (pres === 'undecodable') return { plan: p, signal: p.signal, status: 'undecodable', reason: p.why || 'its multiplexor cannot be decoded' };
    if (pres === 'short') return { plan: p, signal: p.signal, status: 'short', reason: 'the frame has ' + frame.n + ' data bytes; the signal needs ' + p.layout.bytes };
    if (pres === false) return { plan: p, signal: p.signal, status: 'absent', reason: M.conditionText(plan.mux, p.signal) };
    const v = valueOf(p);
    if (!v) return { plan: p, signal: p.signal, status: 'short', reason: 'the frame has ' + frame.n + ' data bytes; the signal needs ' + p.layout.bytes };
    return { plan: p, signal: p.signal, status: 'ok', raw: v.raw, rawText: v.rawText, physical: v.physical, text: v.text, bits: v.bits };
  });
  return { rows: rows, length: frame.n };
}

// ---- encoding -----------------------------------------------------------------------------------

function unquote(t) { const m = /^"(.*)"$/.exec(t); return m ? { text: m[1], quoted: true } : { text: t, quoted: false }; }

/**
 * The raw value for an input text: a number (physical value) or a value description. Returns
 * { raw (BigInt; for floats the bit pattern), physical (text actually encoded), note } or { error }.
 */
function rawFromInput(p, input) {
  const s = p.signal;
  const q = unquote(String(input).trim());
  if (p.values) {
    for (const [raw, desc] of p.values) {
      if (desc.toLowerCase() === q.text.toLowerCase()) {
        const r = BigInt(raw);
        const range = B.rawRange(s.length, s.signed);
        if (r < range.lo || r > range.hi) return { error: '"' + desc + '" stands for the raw value ' + raw + ', which ' + s.name + ' cannot hold.' };
        return { raw: s.signed ? B.toUnsigned(r, s.length) : r, physical: physicalOfRaw(p, r), rawText: raw, note: 'value description "' + desc + '"' };
      }
    }
  }
  if (q.quoted) return { error: s.name + ' has no value description "' + q.text + '".' };
  const d = D.parse(q.text);
  if (!d) return { error: s.name + ': "' + q.text + '" is neither a number nor one of its value descriptions.' };
  if (D.isZero(p.factor)) return { error: s.name + ' has the factor 0, so no value can be encoded.' };
  if (p.float) {
    const x = Number(D.toString(D.sub(d, p.offset))) / Number(D.toString(p.factor));
    const v = s.length === 32 ? Math.fround(x) : x;
    if (!isFinite(v)) return { error: s.name + ': ' + q.text + ' is outside the range of a ' + s.length + '-bit float.' };
    const fd = s.length === 32 ? D.fromSingle(v) : D.fromDouble(v);
    const physical = D.toString(D.add(D.mul(fd, p.factor), p.offset));
    return { raw: B.floatBits(v, s.length), physical: physical, rawText: floatText(v, s.length), note: D.cmp(D.parse(physical), d) === 0 ? '' : 'stored as the nearest float, ' + physical, requested: d };
  }
  const raw = D.divRound(D.sub(d, p.offset), p.factor);
  if (raw === null) return { error: s.name + ' has the factor 0, so no value can be encoded.' };
  const range = B.rawRange(s.length, s.signed);
  if (raw < range.lo || raw > range.hi) return { error: s.name + ': ' + q.text + ' needs the raw value ' + raw + ', but its ' + s.length + ' ' + (s.signed ? 'signed' : 'unsigned') + ' bits hold ' + range.lo + ' to ' + range.hi + ' (physical ' + physicalOfRaw(p, range.lo) + ' to ' + physicalOfRaw(p, range.hi) + ').' };
  const physical = physicalOfRaw(p, raw);
  return { raw: s.signed ? B.toUnsigned(raw, s.length) : raw, physical: physical, rawText: raw.toString(), note: D.cmp(D.parse(physical), d) === 0 ? '' : 'rounded to ' + physical, requested: d };
}

/**
 * Encodes one message. `inputs` maps signal names to texts (numbers or value descriptions).
 * Returns { ok, bytes, frameText, rows, errors, warnings } where rows list every signal with
 * { name, encoded, rawText, physical, unit, source, note }.
 */
function encodeMessage(db, message, inputs) {
  const plan = planOf(message);
  const given = inputs instanceof Map ? inputs : new Map(Object.entries(inputs || {}));
  const errors = [];
  const warnings = [];
  for (const name of given.keys()) if (!message.signalIndex.has(name)) errors.push('The message ' + message.name + ' has no signal "' + name + '".');
  const size = Math.max(0, Math.min(64, message.size | 0));
  const bytes = new Uint8Array(size);
  const chosen = new Map();
  const rows = [];
  const order = plan.plans.slice().sort(function (a, b) { return (a.info.depth || 0) - (b.info.depth || 0) || a.signal.index - b.signal.index; });
  const masks = [];
  let overlapNotes = 0;
  for (const p of order) {
    const s = p.signal;
    const row = { name: s.name, encoded: false, rawText: '', physical: '', unit: s.unit, source: '', note: '' };
    rows[s.index] = row;
    if (!p.usable) {
      row.note = 'not encoded: ' + p.why;
      if (given.has(s.name)) warnings.push(s.name + ' is not encoded: ' + p.why + '.');
      continue;
    }
    if (p.layout.bytes > size) { row.note = 'not encoded: it does not fit into the ' + size + ' data bytes'; if (given.has(s.name)) warnings.push(s.name + ' does not fit into the ' + size + ' data bytes and is not encoded.'); continue; }
    if (p.info.parent) {
      const parentValue = chosen.get(p.info.parent);
      const present = parentValue !== undefined && p.info.ranges.some(function (r) { return r[0] <= parentValue && parentValue <= r[1]; });
      if (!present) {
        row.note = 'not present: ' + M.conditionText(plan.mux, s);
        if (given.has(s.name)) warnings.push(s.name + ' is not encoded: it is ' + M.conditionText(plan.mux, s) + '.');
        continue;
      }
    }
    let raw;
    if (given.has(s.name)) {
      const r = rawFromInput(p, given.get(s.name));
      if (r.error) { errors.push(r.error); row.note = r.error; continue; }
      raw = r.raw;
      row.rawText = r.rawText;
      row.physical = r.physical;
      row.source = 'given';
      row.note = r.note || '';
      const min = D.cached(s.minText);
      const max = D.cached(s.maxText);
      if (r.requested && min && max && !(D.isZero(min) && D.isZero(max)) && (D.cmp(r.requested, min) < 0 || D.cmp(r.requested, max) > 0)) {
        warnings.push(s.name + ': ' + D.toString(r.requested) + ' is outside its range [' + s.minText + '|' + s.maxText + ']; it is encoded anyway.');
      }
    } else {
      // A signal that was not given starts at the raw value 0.
      raw = 0n;
      row.rawText = '0';
      row.physical = p.float ? D.toString(p.offset) : physicalOfRaw(p, 0n);
      row.source = 'zero';
    }
    if (s.isMultiplexor) chosen.set(s, s.signed && !p.float ? B.toSigned(raw, s.length) : raw);
    B.insert(bytes, p.layout, raw);
    row.encoded = true;
    if (masks.length < MAX_OVERLAP_CHECKS) {
      const mask = B.maskOf(p.layout);
      for (const other of masks) {
        if ((other.mask & mask) === 0n) continue;
        if (overlapNotes < MAX_OVERLAP_NOTES) warnings.push(s.name + ' overlaps ' + other.name + '; the bits written last win.');
        else if (overlapNotes === MAX_OVERLAP_NOTES) warnings.push('More signals overlap; only the first ' + MAX_OVERLAP_NOTES + ' overlaps are listed here (the problems list has them all).');
        overlapNotes++;
        if (overlapNotes > MAX_OVERLAP_NOTES) break;
      }
      masks.push({ name: s.name, mask: mask });
    } else if (masks.length === MAX_OVERLAP_CHECKS) {
      masks.push({ name: '', mask: 0n });
      warnings.push('The message has more than ' + MAX_OVERLAP_CHECKS + ' signals; overlaps between the remaining ones are not reported here (the problems list has them).');
    }
  }
  const frameText = frameIdText(message) + '#' + B.hexBytes(bytes, '');
  return { ok: errors.length === 0, bytes: bytes, frameText: frameText, rows: rows, errors: errors, warnings: warnings };
}

/** The identifier as candump writes it: three hex digits for standard, eight for extended frames. */
function frameIdText(message) {
  const id = isFinite(message.frameId) ? message.frameId : 0;
  return id.toString(16).toUpperCase().padStart(message.extended ? 8 : 3, '0');
}

module.exports = { planOf: planOf, decodeMessage: decodeMessage, encodeMessage: encodeMessage, readValue: readValue, physicalOfRaw: physicalOfRaw, rawFromInput: rawFromInput, scaledText: scaledText, frameIdText: frameIdText, floatText: floatText };
