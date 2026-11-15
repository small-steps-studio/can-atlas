'use strict';
// A second, deliberately different decoder for the raw value of a signal. It shares no code with
// src/dbc/bits.js: it walks the bits of the signal one at a time in the order the DBC convention
// gives them and builds the value by doubling and adding, so it never shifts a big integer.
//
// Bit numbers: bit b of the frame is bit (b % 8) of byte (b div 8); bit 0 is the least significant
// bit of a byte.
//   Little-endian (Intel, @1): the start bit is the least significant bit of the signal; the next
//     more significant bit is the next higher bit number.
//   Big-endian (Motorola, @0): the start bit is the most significant bit of the signal; the next
//     less significant bit is the next lower bit number inside the byte, and after bit 0 of a byte
//     comes bit 7 of the following byte.

/** The bit numbers of a signal from its most significant bit to its least significant bit. */
function bitPositions(startBit, length, little) {
  const out = [];
  if (little) {
    for (let i = length - 1; i >= 0; i--) out.push(startBit + i);
    return out;
  }
  let b = startBit;
  for (let i = 0; i < length; i++) {
    out.push(b);
    if (b % 8 === 0) b += 15; else b -= 1;
  }
  return out;
}

/** The value of bit b of a frame given as an array-like of bytes. */
function bitOf(bytes, b) { return (bytes[Math.floor(b / 8)] >> (b % 8)) & 1; }

/**
 * The raw value of the signal as a decimal string (signed when `signed`), or null when a bit of the
 * signal lies beyond the end of the frame.
 */
function rawText(bytes, startBit, length, little, signed) {
  const positions = bitPositions(startBit, length, little);
  let v = 0n;
  for (const p of positions) {
    if (Math.floor(p / 8) >= bytes.length) return null;
    v = v * 2n + BigInt(bitOf(bytes, p));
  }
  if (signed && positions.length > 0 && bitOf(bytes, positions[0]) === 1) v -= 2n ** BigInt(length);
  return v.toString();
}

/** The raw value as a BigInt (unsigned bit pattern), or null when the frame is too short. */
function rawPattern(bytes, startBit, length, little) { return rawText(bytes, startBit, length, little, false); }

/** Writes `value` (a non-negative BigInt below 2^length) into `bytes` bit by bit. */
function writeBits(bytes, startBit, length, little, value) {
  const positions = bitPositions(startBit, length, little);
  let v = value;
  for (let i = positions.length - 1; i >= 0; i--) {
    const bit = Number(v % 2n);
    v = v / 2n;
    const p = positions[i];
    const k = Math.floor(p / 8);
    if (bit) bytes[k] |= 1 << (p % 8); else bytes[k] &= ~(1 << (p % 8)) & 0xFF;
  }
}

module.exports = { bitPositions: bitPositions, bitOf: bitOf, rawText: rawText, rawPattern: rawPattern, writeBits: writeBits };
