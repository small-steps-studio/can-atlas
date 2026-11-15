'use strict';
// Exact decimal numbers: value = n / 10^s, with a BigInt n and a whole number s >= 0. Factors,
// offsets, ranges and physical values are computed with these and never with binary floating
// point, so 3 * 0.1 is exactly 0.3 and a 64-bit raw value keeps every digit.

const MAX_EXPONENT = 400;
const MAX_TEXT = 420;
const TEN = 10n;
const POW = [1n];

function pow10(k) {
  while (POW.length <= k) POW.push(POW[POW.length - 1] * TEN);
  return POW[k];
}

/** A normalised decimal (no trailing zeros after the point). */
function make(n, s) {
  if (n === 0n) return { n: 0n, s: 0 };
  while (s > 0 && n % TEN === 0n) { n /= TEN; s--; }
  return { n: n, s: s };
}

const ZERO = make(0n, 0);
const ONE = make(1n, 0);
const NUMBER = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,6}))?$/;

/** Reads a decimal number such as "-12.5", ".25", "1E-3" or "2.5e+2"; null when it is not one. */
function parse(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t || t.length > MAX_TEXT) return null;
  const m = NUMBER.exec(t);
  if (!m) return null;
  const whole = m[2] || '';
  const frac = m[3] || '';
  if (!whole && !frac) return null;
  const exp = m[4] ? Number(m[4]) : 0;
  if (Math.abs(exp) > MAX_EXPONENT) return null;
  let scale = frac.length - exp;
  let n = BigInt((whole + frac) || '0');
  if (scale < 0) { n *= pow10(-scale); scale = 0; }
  if (m[1] === '-') n = -n;
  return make(n, scale);
}

const CACHE = new Map();
/** parse() with a cache: DBC files repeat the same factors and offsets many times. */
function cached(text) {
  let d = CACHE.get(text);
  if (d === undefined) {
    d = parse(text);
    if (CACHE.size >= 20000) CACHE.clear();
    CACHE.set(text, d);
  }
  return d;
}

function fromBigInt(b) { return make(BigInt(b), 0); }

function align(a, b) {
  const s = Math.max(a.s, b.s);
  return { a: a.n * pow10(s - a.s), b: b.n * pow10(s - b.s), s: s };
}

function add(a, b) { const x = align(a, b); return make(x.a + x.b, x.s); }
function sub(a, b) { const x = align(a, b); return make(x.a - x.b, x.s); }
function neg(a) { return make(-a.n, a.s); }
function mul(a, b) { return make(a.n * b.n, a.s + b.s); }
function cmp(a, b) { const x = align(a, b); return x.a < x.b ? -1 : x.a > x.b ? 1 : 0; }
function isZero(a) { return a.n === 0n; }
function isInteger(a) { return a.s === 0; }
function min(a, b) { return cmp(a, b) <= 0 ? a : b; }
function max(a, b) { return cmp(a, b) >= 0 ? a : b; }

/** The exact digits, for example "-0.05" or "18446744073709551615". */
function toString(a) {
  if (a.s === 0) return a.n.toString();
  const negative = a.n < 0n;
  let digits = (negative ? -a.n : a.n).toString();
  if (digits.length <= a.s) digits = '0'.repeat(a.s - digits.length + 1) + digits;
  const cut = digits.length - a.s;
  return (negative ? '-' : '') + digits.slice(0, cut) + '.' + digits.slice(cut);
}

/** a / b rounded to a whole number, halves away from zero; null when b is zero. */
function divRound(a, b) {
  if (b.n === 0n) return null;
  let num = a.n * pow10(b.s);
  let den = b.n * pow10(a.s);
  if (den < 0n) { num = -num; den = -den; }
  let q = num / den;
  const r = num - q * den;
  if ((r < 0n ? -r : r) * 2n >= den) q += num < 0n ? -1n : 1n;
  return q;
}

/** a / b with `scale` digits after the point, halves away from zero; null when b is zero. */
function divScale(a, b, scale) {
  const q = divRound(make(a.n * pow10(scale), a.s), b);
  return q === null ? null : make(q, scale);
}

/** The shortest decimal that reads back to the same 64-bit float; null for NaN and infinities. */
function fromDouble(x) {
  if (typeof x !== 'number' || !isFinite(x)) return null;
  return parse(String(x));
}

/** The shortest decimal that reads back to the same 32-bit float; null for NaN and infinities. */
function fromSingle(x) {
  if (typeof x !== 'number' || !isFinite(x)) return null;
  for (let p = 1; p <= 9; p++) {
    const s = x.toPrecision(p);
    if (Math.fround(Number(s)) === x) return parse(s);
  }
  return parse(String(x));
}

/** A JavaScript number close to the value, for display widths and statistics of floats only. */
function toNumber(a) { return Number(toString(a)); }

module.exports = {
  ZERO: ZERO, ONE: ONE, parse: parse, cached: cached, fromBigInt: fromBigInt, add: add, sub: sub, neg: neg, mul: mul, cmp: cmp,
  isZero: isZero, isInteger: isInteger, min: min, max: max, toString: toString, divRound: divRound, divScale: divScale,
  fromDouble: fromDouble, fromSingle: fromSingle, toNumber: toNumber, pow10: pow10
};
