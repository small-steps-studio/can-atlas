'use strict';
// Bit numbering of DBC signals.
//
// The bits of a frame are numbered byte by byte: bit 8*k + j is bit j of byte k, where bit 0 is
// the least significant bit of the byte and bit 7 the most significant one.
//
// Little-endian signals ("Intel", written @1): the start bit is the least significant bit of the
// signal; the signal continues upwards through the numbering (bit 7 of byte 0 is followed by bit 0
// of byte 1, which is bit 8).
//
// Big-endian signals ("Motorola", written @0): the start bit is the most significant bit of the
// signal; the signal continues with the next lower bit of the same byte, and after bit 0 of a byte
// with bit 7 of the next byte.
//
// Raw values are BigInt, so signals of up to 64 bits keep every digit.

const MAX_FRAME_BYTES = 64;
const MAX_LENGTH = 64;

/** Position of a bit when the frame is read as one big-endian bit string (bit 7 of byte 0 is 0). */
function motorolaLinear(bit) { return (bit >> 3) * 8 + (7 - (bit & 7)); }
/** The inverse of motorolaLinear (the mapping is its own inverse). */
function linearBit(lin) { return (lin >> 3) * 8 + (7 - (lin & 7)); }

/**
 * Where a signal lies: { little, start, length, msb, lsb, firstByte, lastByte, bytes, mask } with
 * msb and lsb as bit numbers and `bytes` the number of frame bytes needed to hold the signal.
 * null when the start bit or the length cannot describe a signal.
 */
function layoutOf(startBit, length, little) {
  // Start bits above 4095 are far outside the largest frame (512 bits); refusing them here also keeps
  // the shifts below inside 32 bits.
  if (!Number.isInteger(startBit) || startBit < 0 || startBit > 4095 || !Number.isInteger(length) || length < 1 || length > MAX_LENGTH) return null;
  const mask = (1n << BigInt(length)) - 1n;
  if (little) {
    const last = startBit + length - 1;
    return { little: true, start: startBit, length: length, lsb: startBit, msb: last, firstByte: startBit >> 3, lastByte: last >> 3, bytes: (last >> 3) + 1, mask: mask, shift: BigInt(startBit) };
  }
  const msbLin = motorolaLinear(startBit);
  const lsbLin = msbLin + length - 1;
  return { little: false, start: startBit, length: length, msb: startBit, lsb: linearBit(lsbLin), msbLin: msbLin, lsbLin: lsbLin, firstByte: msbLin >> 3, lastByte: lsbLin >> 3, bytes: (lsbLin >> 3) + 1, mask: mask };
}

/** The bit numbers of a signal, from the most significant to the least significant bit. */
function bitsOf(layout) {
  const out = new Array(layout.length);
  if (layout.little) for (let i = 0; i < layout.length; i++) out[i] = layout.msb - i;
  else for (let i = 0; i < layout.length; i++) out[i] = linearBit(layout.msbLin + i);
  return out;
}

/** A BigInt with bit b set for every bit number b of the signal. */
function maskOf(layout) {
  if (layout.little) return layout.mask << layout.shift;
  let m = 0n;
  for (const b of bitsOf(layout)) m |= 1n << BigInt(b);
  return m;
}

const SCRATCH = new Uint8Array(MAX_FRAME_BYTES + 8);
const SCRATCH_VIEW = new DataView(SCRATCH.buffer);

/** The first n bytes as one little-endian integer (byte 0 holds bits 0 to 7). */
function leInt(bytes, n) {
  if (n <= 0) return 0n;
  const padded = (n + 7) & ~7;
  SCRATCH.fill(0, 0, padded);
  for (let k = 0; k < n; k++) SCRATCH[k] = bytes[k];
  let v = 0n;
  for (let off = padded - 8; off >= 0; off -= 8) v = (v << 64n) | SCRATCH_VIEW.getBigUint64(off, true);
  return v;
}

/** The first n bytes as one big-endian integer (byte 0 is the most significant byte). */
function beInt(bytes, n) {
  if (n <= 0) return 0n;
  const padded = (n + 7) & ~7;
  SCRATCH.fill(0, 0, padded);
  const lead = padded - n;
  for (let k = 0; k < n; k++) SCRATCH[lead + k] = bytes[k];
  let v = 0n;
  for (let off = 0; off < padded; off += 8) v = (v << 64n) | SCRATCH_VIEW.getBigUint64(off, false);
  return v;
}

/** A frame prepared for reading several signals: { bytes, n } plus integers built on first use. */
function frameOf(bytes, n) {
  return { bytes: bytes, n: n === undefined ? bytes.length : Math.min(n, bytes.length), le: undefined, be: undefined };
}

/** The raw value of a signal as an unsigned BigInt, or null when the frame is too short for it. */
function extract(frame, layout) {
  if (layout.bytes > frame.n) return null;
  if (layout.little) {
    if (frame.le === undefined) frame.le = leInt(frame.bytes, frame.n);
    return (frame.le >> layout.shift) & layout.mask;
  }
  if (frame.be === undefined) frame.be = beInt(frame.bytes, frame.n);
  return (frame.be >> BigInt(frame.n * 8 - 1 - layout.lsbLin)) & layout.mask;
}

/** Writes an unsigned raw value into the bytes (which must be long enough), bit by bit. */
function insert(bytes, layout, raw) {
  const bits = bitsOf(layout);
  for (let i = 0; i < layout.length; i++) {
    const on = ((raw >> BigInt(layout.length - 1 - i)) & 1n) === 1n;
    const b = bits[i];
    const byte = b >> 3;
    const m = 1 << (b & 7);
    if (on) bytes[byte] |= m; else bytes[byte] &= (~m) & 0xFF;
  }
}

/** Two's complement: the signed value of an unsigned raw pattern of `length` bits. */
function toSigned(raw, length) {
  const half = 1n << BigInt(length - 1);
  return raw >= half ? raw - (half << 1n) : raw;
}

/** The unsigned bit pattern of a signed value of `length` bits. */
function toUnsigned(value, length) { return value < 0n ? value + (1n << BigInt(length)) : value; }

/** Smallest and largest raw value: { lo, hi } as BigInt. */
function rawRange(length, signed) {
  if (signed) { const half = 1n << BigInt(length - 1); return { lo: -half, hi: half - 1n }; }
  return { lo: 0n, hi: (1n << BigInt(length)) - 1n };
}

const FLOAT_VIEW = new DataView(new ArrayBuffer(8));

/** The IEEE 754 value of a 32-bit or 64-bit raw pattern. */
function floatOf(raw, length) {
  if (length === 32) { FLOAT_VIEW.setUint32(0, Number(raw)); return FLOAT_VIEW.getFloat32(0); }
  FLOAT_VIEW.setBigUint64(0, raw);
  return FLOAT_VIEW.getFloat64(0);
}

/** The raw pattern of an IEEE 754 value with 32 or 64 bits. */
function floatBits(value, length) {
  if (length === 32) { FLOAT_VIEW.setFloat32(0, value); return BigInt(FLOAT_VIEW.getUint32(0)); }
  FLOAT_VIEW.setFloat64(0, value);
  return FLOAT_VIEW.getBigUint64(0);
}

/** Hex text of bytes, for example "1A 00 FF". */
function hexBytes(bytes, separator) {
  const out = [];
  for (let k = 0; k < bytes.length; k++) out.push((bytes[k] < 16 ? '0' : '') + bytes[k].toString(16).toUpperCase());
  return out.join(separator === undefined ? ' ' : separator);
}

/** Data length codes of CAN FD above 8 bytes. */
const FD_LENGTHS = Object.freeze([12, 16, 20, 24, 32, 48, 64]);
function isFrameLength(n) { return Number.isInteger(n) && ((n >= 0 && n <= 8) || FD_LENGTHS.indexOf(n) !== -1); }
/** Payload length of a CAN FD data length code (0 to 15). */
function lengthOfDlc(dlc) { return dlc <= 8 ? dlc : [12, 16, 20, 24, 32, 48, 64][dlc - 9]; }

module.exports = {
  MAX_FRAME_BYTES: MAX_FRAME_BYTES, MAX_LENGTH: MAX_LENGTH, motorolaLinear: motorolaLinear, linearBit: linearBit, layoutOf: layoutOf, bitsOf: bitsOf,
  maskOf: maskOf, leInt: leInt, beInt: beInt, frameOf: frameOf, extract: extract, insert: insert, toSigned: toSigned, toUnsigned: toUnsigned,
  rawRange: rawRange, floatOf: floatOf, floatBits: floatBits, hexBytes: hexBytes, isFrameLength: isFrameLength, lengthOfDlc: lengthOfDlc, FD_LENGTHS: FD_LENGTHS
};
