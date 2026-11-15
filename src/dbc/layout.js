'use strict';
// The bit layout of a message: which signal uses which bit, byte by byte, for every combination
// of multiplexor values. Used by the text view (free) and the graphical view (Pro).

const B = require('./bits');
const M = require('./mux');
const D = require('./describe');
const U = require('../util');

/** Letters for signals: A to Z, then AA, AB and so on. */
function keyOf(i) {
  let s = '';
  let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

/**
 * The grid of one group of signals: { bytes, cells } where cells[8 * byte + bit] lists the
 * entries { index, msb, lsb } of the signals that use the bit.
 */
function gridOf(message, signals, bytes) {
  const n = Math.max(1, Math.min(64, bytes));
  const cells = new Array(n * 8);
  for (let k = 0; k < cells.length; k++) cells[k] = [];
  for (const s of signals) {
    const layout = s.length >= 1 && s.length <= 64 ? B.layoutOf(s.startBit, s.length, s.little) : null;
    if (!layout) continue;
    const bits = B.bitsOf(layout);
    for (let i = 0; i < bits.length; i++) {
      const b = bits[i];
      if (b < cells.length) cells[b].push({ index: s.index, msb: i === 0, lsb: i === bits.length - 1 });
    }
  }
  return { bytes: n, cells: cells };
}

/** The layout of a message: { bytes, keys, groups: [{ title, signals, grid, overlaps }], more, undecodable }. */
function layoutOf(message) {
  const g = M.groupsOf(message);
  let needed = Math.max(0, Math.min(64, message.size | 0));
  for (const s of message.signals) {
    const layout = s.length >= 1 && s.length <= 64 ? B.layoutOf(s.startBit, s.length, s.little) : null;
    if (layout && layout.bytes <= 64) needed = Math.max(needed, layout.bytes);
  }
  const keys = new Map(message.signals.map(function (s, i) { return [s.index, keyOf(i)]; }));
  const groups = g.groups.map(function (grp) {
    const grid = gridOf(message, grp.signals, needed);
    let overlaps = 0;
    for (const c of grid.cells) if (c.length > 1) overlaps++;
    return { title: grp.title, signals: grp.signals, grid: grid, overlaps: overlaps };
  });
  return { bytes: Math.max(1, needed), size: message.size, keys: keys, groups: groups, more: g.more, undecodable: g.undecodable };
}

function cellText(cell, keys) {
  if (!cell.length) return '·';
  if (cell.length > 1) return cell.map(function (e) { return keys.get(e.index); }).join('+') + ' !';
  const e = cell[0];
  return keys.get(e.index) + (e.msb && e.lsb ? '' : e.msb ? ' ▲' : e.lsb ? ' ▼' : '');
}

/** The layout as a Markdown document (the free text view). */
function layoutMarkdown(db, message) {
  const L = layoutOf(message);
  const lines = [];
  lines.push('# Bit layout of ' + U.escapeMarkdown(message.name) + ' (' + U.escapeMarkdown(D.messageLabel(message).split(' ')[0]) + ')');
  lines.push('');
  lines.push(U.escapeMarkdown(D.plural(message.size, 'data byte') + ', ' + D.plural(message.signals.length, 'signal') + '. Rows are bytes, columns are bits 7 (most significant) to 0. A letter names the signal that uses the bit; ▲ marks the most significant bit of a signal, ▼ its least significant bit, · an unused bit and ! a bit used by more than one signal.'));
  lines.push('');
  lines.push('| Key | Signal | Start\\|length | Byte order | Value | Scaling | Unit |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of message.signals) {
    lines.push('| ' + L.keys.get(s.index) + ' | ' + U.escapeMarkdown(s.name + (s.muxText ? ' (' + s.muxText + ')' : '')) + ' | ' + s.startBit + '\\|' + s.length + ' | ' + (s.little ? 'little-endian' : 'big-endian') + ' | ' +
      U.escapeMarkdown(D.valueTypeLine(s)) + ' | ' + U.escapeMarkdown(D.formulaLine(s).replace('physical = ', '')) + ' | ' + U.escapeMarkdown(s.unit) + ' |');
  }
  for (const grp of L.groups) {
    if (L.groups.length > 1 && !grp.signals.length) continue;
    lines.push('');
    lines.push('## ' + U.escapeMarkdown(L.groups.length === 1 ? 'Layout' : grp.title));
    if (grp.overlaps) lines.push('', U.escapeMarkdown(D.plural(grp.overlaps, 'bit') + ' used by more than one signal (marked !).'));
    lines.push('');
    lines.push('| Byte | 7 | 6 | 5 | 4 | 3 | 2 | 1 | 0 |');
    lines.push('| ---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');
    for (let byte = 0; byte < grp.grid.bytes; byte++) {
      const row = ['| ' + byte + (byte >= message.size ? ' (beyond the data length)' : '') + ' '];
      for (let bit = 7; bit >= 0; bit--) row.push(' ' + cellText(grp.grid.cells[byte * 8 + bit], L.keys).replace(/\|/g, '\\|') + ' ');
      lines.push(row.join('|') + '|');
    }
  }
  if (L.more) lines.push('', U.escapeMarkdown(L.more + ' further combinations of multiplexor values are not shown.'));
  if (L.undecodable.length) {
    lines.push('', '## Not decoded', '');
    const mux = M.analyseMux(message);
    for (const s of L.undecodable) lines.push('* ' + U.escapeMarkdown(s.name + ': ' + mux.info.get(s).reason));
  }
  return lines.join('\n') + '\n';
}

module.exports = { layoutOf: layoutOf, layoutMarkdown: layoutMarkdown, gridOf: gridOf, keyOf: keyOf, cellText: cellText };
