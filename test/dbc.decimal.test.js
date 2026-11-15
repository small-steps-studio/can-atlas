'use strict';
// Exact decimals (src/dbc/decimal.js): a decimal is a BigInt numerator n and a scale s, value = n / 10^s.

const test = require('node:test');
const assert = require('node:assert/strict');

const D = require('../src/dbc/decimal');

function t(text) { return D.toString(D.parse(text)); }

test('parse: the forms DBC files use', () => {
  assert.deepEqual(D.parse('1'), { n: 1n, s: 0 });
  assert.deepEqual(D.parse('-12.5'), { n: -125n, s: 1 });
  assert.deepEqual(D.parse('.5'), { n: 5n, s: 1 });
  assert.deepEqual(D.parse('5.'), { n: 5n, s: 0 });
  assert.deepEqual(D.parse('+3'), { n: 3n, s: 0 });
  assert.deepEqual(D.parse('1E-3'), { n: 1n, s: 3 });
  assert.deepEqual(D.parse('1e-05'), { n: 1n, s: 5 });
  assert.deepEqual(D.parse('2.5e+2'), { n: 250n, s: 0 });
  assert.deepEqual(D.parse('2.5E2'), { n: 250n, s: 0 });
  assert.deepEqual(D.parse('0.10'), { n: 1n, s: 1 });
  assert.deepEqual(D.parse('100'), { n: 100n, s: 0 });
  assert.deepEqual(D.parse('  7  '), { n: 7n, s: 0 });
  assert.deepEqual(D.parse('0.00390625'), { n: 390625n, s: 8 });
  assert.deepEqual(D.parse('18446744073709551615'), { n: 18446744073709551615n, s: 0 });
});

test('parse: zero in every spelling is the same zero', () => {
  for (const z of ['0', '-0', '+0', '0.0', '-0.000', '0e5', '.0', '0.', '-0e-3']) assert.deepEqual(D.parse(z), { n: 0n, s: 0 }, z);
  assert.equal(D.isZero(D.parse('-0.0')), true);
  assert.equal(t('-0'), '0');
});

test('parse: text that is not a number, and exponents that are too large', () => {
  for (const bad of ['', ' ', '+', '-', '.', 'e5', '1e', '1e+', '1.2.3', '--1', '1,5', '0x10', 'NaN', 'Infinity', '1 2', '12abc', '1e1000000', '1e401', '1e-401', '١٢']) assert.equal(D.parse(bad), null, JSON.stringify(bad));
  assert.equal(D.parse(5), null);
  assert.equal(D.parse(null), null);
  assert.equal(D.parse(undefined), null);
  assert.equal(D.parse('1'.repeat(421)), null, 'text longer than 420 characters');
  assert.notEqual(D.parse('1'.repeat(420)), null);
  // An exponent of 400 is the largest accepted: 10^400 is exact.
  assert.equal(D.toString(D.parse('1e400')), '1' + '0'.repeat(400));
  assert.equal(D.toString(D.parse('1e-400')), '0.' + '0'.repeat(399) + '1');
});

test('toString writes the exact digits', () => {
  assert.equal(t('18446744073709551615'), '18446744073709551615');
  assert.equal(t('0.05'), '0.05');
  assert.equal(t('-0.05'), '-0.05');
  assert.equal(t('100'), '100');
  assert.equal(t('1.50'), '1.5');
  assert.equal(t('1e5'), '100000');
  assert.equal(t('-1e-5'), '-0.00001');
  assert.equal(t('123.456'), '123.456');
  assert.equal(t('0.001'), '0.001');
  assert.equal(D.toString(D.ZERO), '0');
  assert.equal(D.toString(D.ONE), '1');
});

test('arithmetic is exact where binary floating point is not', () => {
  assert.equal(D.toString(D.mul(D.parse('3'), D.parse('0.1'))), '0.3');
  assert.equal(0.1 * 3, 0.30000000000000004);
  assert.equal(D.toString(D.add(D.parse('0.1'), D.parse('0.2'))), '0.3');
  assert.equal(D.toString(D.sub(D.parse('0.3'), D.parse('0.1'))), '0.2');
  assert.equal(D.toString(D.mul(D.parse('18446744073709551615'), D.parse('0.001'))), '18446744073709551.615');
  assert.equal(D.toString(D.add(D.mul(D.parse('27315'), D.parse('0.01')), D.parse('-273.15'))), '0');
  assert.equal(D.toString(D.neg(D.parse('2.5'))), '-2.5');
  assert.equal(D.toString(D.neg(D.ZERO)), '0');
  assert.equal(D.toString(D.mul(D.parse('1e-05'), D.parse('65535'))), '0.65535');
  assert.equal(D.toString(D.mul(D.parse('-0.5'), D.parse('-4'))), '2');
  assert.equal(D.toString(D.fromBigInt(-7n)), '-7');
});

test('comparison, minimum, maximum, integer test', () => {
  assert.equal(D.cmp(D.parse('1.0'), D.parse('1')), 0);
  assert.equal(D.cmp(D.parse('0.1'), D.parse('0.09')), 1);
  assert.equal(D.cmp(D.parse('-0.1'), D.parse('0.09')), -1);
  assert.equal(D.cmp(D.parse('1e-5'), D.parse('0.00001')), 0);
  assert.equal(D.cmp(D.parse('18446744073709551615'), D.parse('18446744073709551614.999')), 1);
  assert.equal(D.toString(D.min(D.parse('2'), D.parse('-3'))), '-3');
  assert.equal(D.toString(D.max(D.parse('2'), D.parse('-3'))), '2');
  assert.equal(D.isInteger(D.parse('3.0')), true);
  assert.equal(D.isInteger(D.parse('3.5')), false);
  assert.equal(D.isInteger(D.parse('1e3')), true);
});

test('divRound rounds to a whole number, halves away from zero', () => {
  const q = function (a, b) { return D.divRound(D.parse(a), D.parse(b)); };
  assert.equal(q('5', '2'), 3n);
  assert.equal(q('-5', '2'), -3n);
  assert.equal(q('5', '-2'), -3n);
  assert.equal(q('-5', '-2'), 3n);
  assert.equal(q('7', '2'), 4n);
  assert.equal(q('1', '3'), 0n);
  assert.equal(q('2', '3'), 1n);
  assert.equal(q('-2', '3'), -1n);
  assert.equal(q('0.5', '1'), 1n);
  assert.equal(q('-0.5', '1'), -1n);
  assert.equal(q('0.25', '0.5'), 1n);
  assert.equal(q('0.124999', '0.25'), 0n);
  assert.equal(q('0.125', '0.25'), 1n);
  assert.equal(q('10', '0.1'), 100n);
  assert.equal(q('0', '7'), 0n);
  assert.equal(q('18446744073709551615000', '1000'), 18446744073709551615n);
  assert.equal(q('1', '0'), null);
  assert.equal(q('1', '0.0'), null);
  assert.equal(q('99999999999999999999.5', '1'), 100000000000000000000n);
});

test('divScale divides to a number of digits after the point', () => {
  const d = function (a, b, s) { return D.toString(D.divScale(D.parse(a), D.parse(b), s)); };
  assert.equal(d('1', '3', 4), '0.3333');
  assert.equal(d('2', '3', 4), '0.6667');
  assert.equal(d('-2', '3', 4), '-0.6667');
  assert.equal(d('10', '4', 0), '3');
  assert.equal(d('1', '8', 2), '0.13');
  assert.equal(d('7', '1', 3), '7');
  assert.equal(D.divScale(D.parse('1'), D.parse('0'), 2), null);
});

test('the shortest decimals of floats', () => {
  const s = function (x) { return D.toString(D.fromSingle(Math.fround(x))); };
  assert.equal(s(0.1), '0.1');
  assert.equal(s(1013.25), '1013.25');
  assert.equal(s(16777216), '16777216');
  assert.equal(s(1 / 3), '0.33333334');
  assert.equal(s(-1.5), '-1.5');
  assert.equal(s(0), '0');
  assert.equal(s(1e10), '10000000000');
  assert.equal(s(3.4028234663852886e38), '340282350000000000000000000000000000000');
  const f = function (x) { return D.toString(D.fromDouble(x)); };
  assert.equal(f(0.1), '0.1');
  assert.equal(f(1 / 3), '0.3333333333333333');
  assert.equal(f(Math.PI), '3.141592653589793');
  assert.equal(f(1e21), '1' + '0'.repeat(21));
  assert.equal(f(-2.5), '-2.5');
  assert.equal(f(5e-7), '0.0000005');
  assert.equal(D.fromDouble(NaN), null);
  assert.equal(D.fromDouble(Infinity), null);
  assert.equal(D.fromDouble(-Infinity), null);
  assert.equal(D.fromSingle(NaN), null);
  assert.equal(D.fromSingle(Infinity), null);
  assert.equal(D.fromDouble('1'), null);
  assert.equal(D.toNumber(D.parse('0.25')), 0.25);
});

test('every shortest decimal reads back to the same float (2,000 random floats)', () => {
  let seed = 123456789;
  const next = function () { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 2000; i++) {
    const x = (next() - 0.5) * Math.pow(10, Math.floor(next() * 30) - 15);
    assert.equal(Number(D.toString(D.fromDouble(x))), x);
    const y = Math.fround(x);
    if (isFinite(y)) assert.equal(Math.fround(Number(D.toString(D.fromSingle(y)))), y);
  }
});

test('cached parsing returns the same answer, also for text that is not a number', () => {
  assert.deepEqual(D.cached('0.25'), D.parse('0.25'));
  assert.equal(D.cached('0.25'), D.cached('0.25'));
  assert.equal(D.cached('abc'), null);
  assert.equal(D.cached('abc'), null);
  assert.equal(D.pow10(0), 1n);
  assert.equal(D.pow10(5), 100000n);
  assert.equal(D.pow10(30), 10n ** 30n);
});

test('a thousand products of decimals agree with integer arithmetic', () => {
  let seed = 42;
  const next = function (m) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % m; };
  for (let i = 0; i < 1000; i++) {
    const a = BigInt(next(2000000) - 1000000);
    const sa = next(8);
    const b = BigInt(next(2000000) - 1000000);
    const sb = next(8);
    const A = D.parse(a + 'e-' + sa);
    const Bd = D.parse(b + 'e-' + sb);
    const prod = D.mul(A, Bd);
    // Compare as integers after scaling to 10^(sa + sb).
    const p = D.parse(String(a * b) + 'e-' + (sa + sb));
    assert.equal(D.cmp(prod, p), 0);
    assert.equal(D.toString(prod), D.toString(p));
    const sum = D.add(A, Bd);
    const S = Math.max(sa, sb);
    const total = a * 10n ** BigInt(S - sa) + b * 10n ** BigInt(S - sb);
    assert.equal(D.cmp(sum, D.parse(String(total) + 'e-' + S)), 0);
  }
});
