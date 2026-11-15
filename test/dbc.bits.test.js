'use strict';
// Bit numbering, layouts, extraction and insertion (src/dbc/bits.js). Expected bit lists are written
// out by hand from the DBC convention.

const test = require('node:test');
const assert = require('node:assert/strict');

const B = require('../src/dbc/bits');
const ref = require('./helpers/ref-decoder');
const G = require('./helpers/gen-dbc');

test('the linear position of a bit: bit 7 of byte 0 is first, bit 0 of byte 0 is eighth, bit 7 of byte 1 is ninth', () => {
  assert.equal(B.motorolaLinear(7), 0);
  assert.equal(B.motorolaLinear(0), 7);
  assert.equal(B.motorolaLinear(15), 8);
  assert.equal(B.motorolaLinear(8), 15);
  assert.equal(B.motorolaLinear(63), 56);
  assert.equal(B.motorolaLinear(56), 63);
  for (let b = 0; b < 512; b++) assert.equal(B.linearBit(B.motorolaLinear(b)), b);
});

test('Intel layouts (start bit = least significant bit)', () => {
  let l = B.layoutOf(0, 8, true);
  assert.deepEqual([l.lsb, l.msb, l.firstByte, l.lastByte, l.bytes, l.little], [0, 7, 0, 0, 1, true]);
  l = B.layoutOf(5, 9, true);
  assert.deepEqual([l.lsb, l.msb, l.firstByte, l.lastByte, l.bytes], [5, 13, 0, 1, 2]);
  l = B.layoutOf(63, 1, true);
  assert.deepEqual([l.lsb, l.msb, l.firstByte, l.lastByte, l.bytes], [63, 63, 7, 7, 8]);
  l = B.layoutOf(0, 64, true);
  assert.deepEqual([l.lsb, l.msb, l.bytes], [0, 63, 8]);
  l = B.layoutOf(7, 2, true);
  assert.deepEqual([l.lsb, l.msb, l.firstByte, l.lastByte], [7, 8, 0, 1]);
  assert.equal(l.mask, 3n);
});

test('Motorola layouts (start bit = most significant bit)', () => {
  let l = B.layoutOf(7, 16, false);
  assert.deepEqual([l.msb, l.lsb, l.firstByte, l.lastByte, l.bytes, l.little], [7, 8, 0, 1, 2, false]);
  l = B.layoutOf(0, 8, false);
  assert.deepEqual([l.msb, l.lsb, l.firstByte, l.lastByte, l.bytes], [0, 9, 0, 1, 2]);
  l = B.layoutOf(4, 20, false);
  assert.deepEqual([l.msb, l.lsb, l.firstByte, l.lastByte, l.bytes], [4, 17, 0, 2, 3]);
  l = B.layoutOf(7, 64, false);
  assert.deepEqual([l.msb, l.lsb, l.bytes], [7, 56, 8]);
  l = B.layoutOf(59, 4, false);
  assert.deepEqual([l.msb, l.lsb, l.firstByte, l.lastByte], [59, 56, 7, 7]);
  l = B.layoutOf(63, 4, false);
  assert.deepEqual([l.msb, l.lsb], [63, 60]);
  l = B.layoutOf(255, 16, false);
  assert.deepEqual([l.firstByte, l.lastByte, l.bytes], [31, 32, 33]);
});

test('bitsOf lists the bit numbers from the most significant bit to the least significant bit', () => {
  assert.deepEqual(B.bitsOf(B.layoutOf(5, 9, true)), [13, 12, 11, 10, 9, 8, 7, 6, 5]);
  assert.deepEqual(B.bitsOf(B.layoutOf(7, 16, false)), [7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8]);
  assert.deepEqual(B.bitsOf(B.layoutOf(0, 8, false)), [0, 15, 14, 13, 12, 11, 10, 9]);
  assert.deepEqual(B.bitsOf(B.layoutOf(4, 20, false)), [4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8, 23, 22, 21, 20, 19, 18, 17]);
  assert.deepEqual(B.bitsOf(B.layoutOf(3, 1, false)), [3]);
});

test('bit lists of 5,000 random layouts equal the lists of the reference walk', () => {
  const rnd = G.mulberry32(99);
  for (let i = 0; i < 5000; i++) {
    const little = rnd() < 0.5;
    const len = 1 + Math.floor(rnd() * 64);
    const start = Math.floor(rnd() * 512);
    const l = B.layoutOf(start, len, little);
    assert.deepEqual(B.bitsOf(l), ref.bitPositions(start, len, little), 'start ' + start + ' len ' + len + ' ' + little);
    // The recorded msb, lsb and byte span agree with the list.
    const bits = ref.bitPositions(start, len, little);
    assert.equal(l.msb, bits[0]);
    assert.equal(l.lsb, bits[bits.length - 1]);
    assert.equal(l.firstByte, Math.min.apply(null, bits.map(function (b) { return b >> 3; })));
    assert.equal(l.lastByte, Math.max.apply(null, bits.map(function (b) { return b >> 3; })));
    assert.equal(l.bytes, l.lastByte + 1);
  }
});

test('layouts that cannot describe a signal are refused', () => {
  assert.equal(B.layoutOf(4096, 8, true), null);
  assert.equal(B.layoutOf(2147483648, 8, true), null, 'a start bit above 2^31 must not wrap around');
  assert.equal(B.layoutOf(4294967295, 8, false), null);
  assert.equal(B.layoutOf(-1, 8, true), null);
  assert.equal(B.layoutOf(0, 0, true), null);
  assert.equal(B.layoutOf(0, 65, true), null);
  assert.equal(B.layoutOf(1.5, 8, true), null);
  assert.equal(B.layoutOf(0, 8.5, true), null);
  assert.equal(B.layoutOf(Infinity, 8, true), null);
  assert.equal(B.layoutOf(NaN, 8, false), null);
  assert.equal(B.layoutOf('3', 8, true), null);
  assert.notEqual(B.layoutOf(4095, 8, true), null);
  assert.equal(B.layoutOf(4095, 8, true).bytes, 513, 'the frame check reports such a signal as outside every frame');
});

test('masks have a one for every bit of the signal', () => {
  assert.equal(B.maskOf(B.layoutOf(5, 9, true)), 511n << 5n);
  assert.equal(B.maskOf(B.layoutOf(7, 16, false)), 0xFFFFn);
  assert.equal(B.maskOf(B.layoutOf(0, 8, false)), 0xFE01n);
  assert.equal(B.maskOf(B.layoutOf(0, 64, true)), 0xFFFFFFFFFFFFFFFFn);
  assert.equal(B.maskOf(B.layoutOf(59, 4, false)), 0xFn << 56n);
});

test('extract and insert are inverse for 3,000 random signals (compared with the reference writer)', () => {
  const rnd = G.mulberry32(5);
  for (let i = 0; i < 3000; i++) {
    const little = rnd() < 0.5;
    const len = 1 + Math.floor(rnd() * 64);
    const n = 8 + Math.floor(rnd() * 57);
    const start = little ? Math.floor(rnd() * (8 * n - len + 1)) : Math.floor(rnd() * 8 * n);
    const l = B.layoutOf(start, len, little);
    if (l.bytes > n) continue;
    let raw = 0n;
    for (let k = 0; k < len; k += 16) raw = raw * 65536n + BigInt(Math.floor(rnd() * 65536));
    raw %= 1n << BigInt(len);
    const bytes = new Uint8Array(n);
    for (let k = 0; k < n; k++) bytes[k] = Math.floor(rnd() * 256);
    const other = bytes.slice();
    B.insert(bytes, l, raw);
    ref.writeBits(other, start, len, little, raw);
    assert.deepEqual(Array.from(bytes), Array.from(other));
    assert.equal(B.extract(B.frameOf(bytes), l), raw);
    assert.equal(ref.rawText(bytes, start, len, little, false), raw.toString());
  }
});

test('extract returns null when the frame is too short for the signal and uses only the bytes given', () => {
  const l = B.layoutOf(8, 16, true);
  assert.equal(B.extract(B.frameOf(Uint8Array.from([1, 2])), l), null);
  assert.equal(B.extract(B.frameOf(Uint8Array.from([0, 2, 1])), l), 0x0102n);
  assert.equal(B.extract(B.frameOf(Uint8Array.from([0, 2, 1, 9, 9]), 3), l), 0x0102n, 'a length limit hides the bytes behind it');
  assert.equal(B.extract(B.frameOf(Uint8Array.from([0, 2, 1, 9, 9]), 2), l), null);
  const m = B.layoutOf(15, 16, false);
  assert.equal(B.extract(B.frameOf(Uint8Array.from([0, 1, 2])), m), 0x0102n);
  assert.equal(B.frameOf(Uint8Array.from([1, 2, 3]), 99).n, 3);
});

test('two-complement conversion', () => {
  assert.equal(B.toSigned(0xFFn, 8), -1n);
  assert.equal(B.toSigned(0x80n, 8), -128n);
  assert.equal(B.toSigned(0x7Fn, 8), 127n);
  assert.equal(B.toSigned(0n, 8), 0n);
  assert.equal(B.toSigned(1n, 1), -1n);
  assert.equal(B.toSigned(0n, 1), 0n);
  assert.equal(B.toSigned(0xFFFn, 12), -1n);
  assert.equal(B.toSigned(0x800n, 12), -2048n);
  assert.equal(B.toSigned(0xFFFFFFFFFFFFFFFFn, 64), -1n);
  assert.equal(B.toSigned(0x8000000000000000n, 64), -9223372036854775808n);
  assert.equal(B.toSigned(0x7FFFFFFFFFFFFFFFn, 64), 9223372036854775807n);
  assert.equal(B.toUnsigned(-1n, 8), 255n);
  assert.equal(B.toUnsigned(-128n, 8), 128n);
  assert.equal(B.toUnsigned(5n, 8), 5n);
  assert.equal(B.toUnsigned(-1n, 64), 18446744073709551615n);
  for (let len = 1; len <= 64; len++) {
    const r = B.rawRange(len, true);
    assert.equal(B.toSigned(B.toUnsigned(r.lo, len), len), r.lo);
    assert.equal(B.toSigned(B.toUnsigned(r.hi, len), len), r.hi);
  }
});

test('raw ranges', () => {
  assert.deepEqual(B.rawRange(8, false), { lo: 0n, hi: 255n });
  assert.deepEqual(B.rawRange(8, true), { lo: -128n, hi: 127n });
  assert.deepEqual(B.rawRange(1, true), { lo: -1n, hi: 0n });
  assert.deepEqual(B.rawRange(1, false), { lo: 0n, hi: 1n });
  assert.deepEqual(B.rawRange(64, false), { lo: 0n, hi: 18446744073709551615n });
  assert.deepEqual(B.rawRange(64, true), { lo: -9223372036854775808n, hi: 9223372036854775807n });
  assert.deepEqual(B.rawRange(12, true), { lo: -2048n, hi: 2047n });
});

test('IEEE 754 bit patterns', () => {
  assert.equal(B.floatBits(1013.25, 32), 0x447D5000n);
  assert.equal(B.floatOf(0x447D5000n, 32), 1013.25);
  assert.equal(B.floatBits(-1.5, 32), 0xBFC00000n);
  assert.equal(B.floatBits(Math.PI, 64), 0x400921FB54442D18n);
  assert.equal(B.floatOf(0x400921FB54442D18n, 64), Math.PI);
  assert.ok(Number.isNaN(B.floatOf(0x7FC00000n, 32)));
  assert.equal(B.floatOf(0x7F800000n, 32), Infinity);
  assert.equal(B.floatOf(0xFF800000n, 32), -Infinity);
  assert.equal(B.floatOf(0x7FF0000000000000n, 64), Infinity);
  assert.ok(Object.is(B.floatOf(0x80000000n, 32), -0));
  assert.equal(B.floatBits(-0, 32), 0x80000000n);
  assert.equal(B.floatBits(0.1, 32), 0x3DCCCCCDn);
  assert.equal(B.floatBits(0.1, 64), 0x3FB999999999999An);
  assert.equal(B.floatBits(1e39, 32), 0x7F800000n, 'too large for single precision becomes infinity');
});

test('bytes as text', () => {
  assert.equal(B.hexBytes(Uint8Array.from([0x1A, 0, 0xFF])), '1A 00 FF');
  assert.equal(B.hexBytes(Uint8Array.from([0x1A, 0, 0xFF]), ''), '1A00FF');
  assert.equal(B.hexBytes(Uint8Array.from([1, 2]), ':'), '01:02');
  assert.equal(B.hexBytes(new Uint8Array(0)), '');
});

test('frame lengths: classic CAN 0 to 8 and the CAN FD lengths', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64]) assert.equal(B.isFrameLength(n), true, String(n));
  for (const n of [9, 10, 11, 13, 14, 15, 17, 25, 33, 49, 63, 65, 128, -1, 1.5, NaN, Infinity]) assert.equal(B.isFrameLength(n), false, String(n));
  const dlc = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
  for (let c = 0; c < 16; c++) assert.equal(B.lengthOfDlc(c), dlc[c]);
});

test('whole-frame integers: little-endian and big-endian reading of up to 64 bytes', () => {
  assert.equal(B.leInt(Uint8Array.from([1, 2, 3]), 3), 0x030201n);
  assert.equal(B.beInt(Uint8Array.from([1, 2, 3]), 3), 0x010203n);
  assert.equal(B.leInt(new Uint8Array(0), 0), 0n);
  assert.equal(B.beInt(new Uint8Array(0), 0), 0n);
  const rnd = G.mulberry32(8);
  for (let n = 1; n <= 64; n++) {
    const bytes = new Uint8Array(n);
    for (let k = 0; k < n; k++) bytes[k] = Math.floor(rnd() * 256);
    let le = 0n;
    let be = 0n;
    for (let k = n - 1; k >= 0; k--) le = le * 256n + BigInt(bytes[k]);
    for (let k = 0; k < n; k++) be = be * 256n + BigInt(bytes[k]);
    assert.equal(B.leInt(bytes, n), le, 'le ' + n);
    assert.equal(B.beInt(bytes, n), be, 'be ' + n);
  }
});
