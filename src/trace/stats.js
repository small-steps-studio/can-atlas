'use strict';
// Statistics of a decoded trace, built from the accumulators that the decoder keeps while it reads:
// per signal the count, minimum, maximum and mean of the physical value; per message the number of
// frames, the period between frames and its spread, and the comparison with the cycle time of the
// database.
//
// Integer signals: the sum of the raw values is kept exactly (a BigInt behind a small number that
// is flushed before it can lose a digit), so the mean is exact before it is rounded to six
// decimals (halves away from zero). Float signals: min, max and mean are computed with ordinary
// floating-point numbers (the sum is compensated); NaN and infinite values are counted apart.

const D = require('../dbc/decimal');
const C = require('../dbc/codec');

function round3(x) { return Math.round(x * 1000) / 1000; }

function physicalOfInt(S, raw) {
  if (typeof raw === 'number') {
    return S.hasFast ? C.scaledText(raw * S.F + S.O, S.S) : C.scaledText(BigInt(raw) * S.bigF + S.bigO, S.S);
  }
  return C.physicalOfRaw(S.p, raw);
}

function physicalOfFloat(S, x) {
  const d = S.length === 32 ? D.fromSingle(x) : D.fromDouble(x);
  if (d === null) return '';
  return D.toString(D.add(D.mul(d, S.p.factor), S.p.offset));
}

function signalStats(plan, S) {
  const out = {
    messageName: plan.name, idText: plan.idText, signalName: S.name, unit: S.unit, count: S.count, nonFinite: S.nonFinite,
    minRaw: '', maxRaw: '', min: '', max: '', mean: '', firstTimeUs: S.firstTime, lastTimeUs: S.lastTime
  };
  if (S.count === 0) return out;
  const negativeFactor = S.p.factor.n < 0n;
  if (S.kind === 2) {
    const mean = S.fsum / S.count;
    const lo = physicalOfFloat(S, S.fmin);
    const hi = physicalOfFloat(S, S.fmax);
    out.minRaw = String(S.fmin);
    out.maxRaw = String(S.fmax);
    out.min = negativeFactor ? hi : lo;
    out.max = negativeFactor ? lo : hi;
    const md = D.fromDouble(mean);
    if (md !== null) out.mean = D.toString(D.divScale(D.add(D.mul(md, S.p.factor), S.p.offset), D.ONE, 6));
    return out;
  }
  const rawMin = S.kind === 0 ? S.min : S.minB;
  const rawMax = S.kind === 0 ? S.max : S.maxB;
  out.minRaw = String(rawMin);
  out.maxRaw = String(rawMax);
  const lo = physicalOfInt(S, rawMin);
  const hi = physicalOfInt(S, rawMax);
  out.min = negativeFactor ? hi : lo;
  out.max = negativeFactor ? lo : hi;
  const sum = S.big + (S.kind === 0 ? BigInt(S.small) : 0n);
  const scale = S.p.big.S;
  const numerator = S.p.big.F * sum + S.p.big.O * BigInt(S.count);
  out.mean = D.toString(D.divScale({ n: numerator, s: scale }, D.fromBigInt(S.count), 6));
  return out;
}

function messageStats(plan) {
  const m = {
    messageName: plan.name, idText: plan.idText, extended: plan.extended, frames: plan.frames, firstTimeUs: plan.firstTime, lastTimeUs: plan.lastTime,
    shortFrames: plan.shortFrames, undecodableSignals: plan.undecodable, intervals: plan.intervals,
    meanPeriodUs: null, minPeriodUs: null, maxPeriodUs: null, stdDevPeriodUs: null, jitterUs: null, frequencyHz: null,
    cycleTimeUs: plan.cycleUs, maxCycleDeviationUs: null, deviatingIntervals: plan.deviating, verdict: ''
  };
  if (plan.intervals > 0) {
    const mean = (Number(plan.pbig) + plan.psmall) / plan.intervals;
    m.meanPeriodUs = round3(mean);
    m.minPeriodUs = plan.minPeriod;
    m.maxPeriodUs = plan.maxPeriod;
    m.stdDevPeriodUs = round3(Math.sqrt(Math.max(0, plan.pm2 / plan.intervals)));
    m.jitterUs = round3(Math.max(plan.maxPeriod - mean, mean - plan.minPeriod));
    m.frequencyHz = mean > 0 ? round3(1000000 / mean) : null;
    if (plan.cycleUs !== null) m.maxCycleDeviationUs = round3(Math.max(plan.maxPeriod - plan.cycleUs, plan.cycleUs - plan.minPeriod));
  }
  if (plan.cycleUs === null) m.verdict = 'no cycle time in the database';
  else if (plan.intervals === 0) m.verdict = 'fewer than two frames, so there is no interval to compare';
  else if (plan.deviating === 0) m.verdict = 'within 50 percent of the cycle time for every frame';
  else m.verdict = plan.deviating + ' of ' + plan.intervals + ' intervals deviate by more than 50 percent';
  return m;
}

/** { signals, messages } from the plans of a finished decoder (see decode.js createDecoder().finish()). */
function buildStats(finished) {
  const plans = finished.plans.slice().sort(function (a, b) {
    if (a.extended !== b.extended) return a.extended ? 1 : -1;
    return a.id - b.id;
  });
  const signals = [];
  const messages = [];
  for (const plan of plans) {
    messages.push(messageStats(plan));
    for (let k = 0; k < plan.n; k++) {
      const S = plan.sigs[k];
      if (!S.usable || S.count + S.nonFinite === 0) continue;
      signals.push(signalStats(plan, S));
    }
  }
  return { signals: signals, messages: messages };
}

module.exports = { buildStats: buildStats, physicalOfInt: physicalOfInt, round3: round3 };
