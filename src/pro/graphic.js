'use strict';
// The graphical bit layout of one message as a complete HTML document for an editor webview.
//
// One grid per combination of multiplexor values (rows are bytes, columns are bits 7 to 0). Every
// signal has a letter key, a colour and a border style, so colour is never the only carrier; the
// most significant bit of a signal is marked with a triangle pointing up and the least significant
// bit with one pointing down; a bit used by more than one signal has a thick red border, a hatched
// fill and the text "!". Cells carry an aria-label such as "byte 2 bit 5: signal EngineSpeed,
// most significant bit". The page has no script, no external resource and no style attribute; its
// content security policy allows only the styles of the page itself (by nonce). It follows the
// editor's colours with fallbacks, and has rules for forced-colors (high contrast) mode.

const crypto = require('node:crypto');
const Lay = require('../dbc/layout');
const M = require('../dbc/mux');
const B = require('../dbc/bits');
const Desc = require('../dbc/describe');
const V = require('../dbc/validate');
const U = require('../util');

const MAX_GRIDS = 32;
const MAX_TABLE_ROWS = 1000;
const MAX_OVERLAP_LINES = 20;
const HUES = [210, 30, 130, 280, 0, 55, 170, 330, 90, 250, 15, 195];
const NONCE = /^[A-Za-z0-9+/=_-]{8,128}$/;

function colourOf(index) { return index % 12; }
function borderOf(index) { return (index + Math.floor(index / 12)) % 4; }
function styleClasses(index) { return 'k' + colourOf(index) + ' b' + borderOf(index); }

function css() {
  const lines = [
    ':root { color-scheme: light dark; }',
    'body { font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: var(--vscode-font-size, 14px); color: var(--vscode-foreground, CanvasText); background: var(--vscode-editor-background, Canvas); margin: 1.5rem; line-height: 1.5; }',
    'h1 { font-size: 1.4em; margin: 0 0 .5rem; }',
    'h2 { font-size: 1.15em; margin: 1.8rem 0 .5rem; }',
    'ul.facts { margin: .25rem 0 1rem; padding-left: 1.2rem; }',
    'table { border-collapse: separate; border-spacing: 2px; margin: .5rem 0 1rem; }',
    'caption { text-align: left; font-weight: 600; padding: .25rem 0; }',
    'th, td { padding: .2rem .5rem; text-align: left; vertical-align: top; }',
    'table.sig th, table.sig td { border: 1px solid var(--vscode-panel-border, #8888); }',
    'table.grid th { font-weight: 600; text-align: center; white-space: nowrap; }',
    'table.grid th[scope="row"] { text-align: right; }',
    'td.cell { min-width: 4.8rem; height: 2.3rem; text-align: center; vertical-align: middle; font-family: var(--vscode-editor-font-family, ui-monospace, monospace); border-width: 3px; border-style: solid; border-color: var(--vscode-panel-border, #8888); }',
    'td.cell.empty { border-style: dotted; opacity: .6; }',
    '.b0 { border-style: solid; } .b1 { border-style: dashed; } .b2 { border-style: dotted; } .b3 { border-style: double; }',
    'td.cell.ov { border: 4px solid #e53935; background: repeating-linear-gradient(45deg, transparent 0 4px, rgba(229, 57, 53, .35) 4px 8px); font-weight: 700; }',
    'span.swatch { display: inline-block; min-width: 2.2rem; text-align: center; border-width: 3px; padding: 0 .3rem; font-weight: 700; }',
    'ul.legend { margin: .25rem 0 1rem; padding-left: 1.2rem; }',
    'p.note { opacity: .85; }'
  ];
  HUES.forEach(function (h, i) { lines.push('.k' + i + ' { background-color: hsl(' + h + ', 65%, 55%, .45); border-color: hsl(' + h + ', 55%, 45%); }'); });
  lines.push('@media (forced-colors: active) {',
    '  td.cell, span.swatch { background-color: Canvas; color: CanvasText; border-color: CanvasText; forced-color-adjust: none; }',
    '  td.cell.ov { background: Canvas; border-color: Highlight; }',
    '}');
  return lines.join('\n');
}

function ariaOfCell(cell, byte, bit, message) {
  const where = 'byte ' + byte + ' bit ' + bit + ': ';
  if (!cell.length) return where + 'unused';
  const name = function (e) { const s = message.signals[e.index]; return s ? s.name : '?'; };
  if (cell.length > 1) return where + 'signals ' + cell.map(name).join(' and ') + ' overlap';
  const e = cell[0];
  return where + 'signal ' + name(e) + (e.msb && e.lsb ? ', the only bit' : e.msb ? ', most significant bit' : e.lsb ? ', least significant bit' : '');
}

function cellHtml(cell, byte, bit, message, keys) {
  const label = U.escapeHtml(ariaOfCell(cell, byte, bit, message));
  const text = U.escapeHtml(Lay.cellText(cell, keys));
  if (!cell.length) return '<td class="cell empty" aria-label="' + label + '"><span aria-hidden="true">' + text + '</span></td>';
  if (cell.length > 1) return '<td class="cell ov" aria-label="' + label + '"><span aria-hidden="true">' + text + '</span></td>';
  const e = cell[0];
  const both = e.msb && e.lsb ? ' ▲▼' : '';
  const shown = both ? U.escapeHtml(keys.get(e.index) + both) : text;
  return '<td class="cell ' + styleClasses(e.index) + '" aria-label="' + label + '"><span aria-hidden="true">' + shown + '</span></td>';
}

function overlapLines(grp, message, keys) {
  const out = [];
  let total = 0;
  for (let i = 0; i < grp.grid.cells.length; i++) {
    const cell = grp.grid.cells[i];
    if (cell.length < 2) continue;
    total++;
    if (out.length < MAX_OVERLAP_LINES) out.push('byte ' + (i >> 3) + ' bit ' + (i & 7) + ': ' + cell.map(function (e) { return keys.get(e.index) + ' (' + (message.signals[e.index] ? message.signals[e.index].name : '?') + ')'; }).join(', '));
  }
  return { lines: out, more: Math.max(0, total - out.length) };
}

function signalNote(mux, message, s) {
  const layout = s.length >= 1 && s.length <= 64 ? B.layoutOf(s.startBit, s.length, s.little) : null;
  if (!layout) return 'not drawn: start bit or length is not valid';
  if (layout.bytes > 64) return 'not drawn: outside the 64 bytes of the largest frame';
  const me = mux.info.get(s);
  if (me && me.status !== 'ok') return 'not decoded: ' + me.reason;
  if (!mux.any) return '';
  const cond = M.conditionText(mux, s);
  if (s.isMultiplexor && !(s.muxValue !== null || s.muxSpec)) return 'multiplexor';
  return (s.isMultiplexor ? 'multiplexor; ' : '') + cond;
}

/**
 * The page for one message. Options: nonce (a base64-like value for the style rule; a random one
 * is made when it is missing or not of that form), title, cspSource (accepted for the caller's
 * convenience; the page loads nothing from outside, so it is not used).
 */
function layoutHtml(db, message, options) {
  const opts = options || {};
  const nonce = typeof opts.nonce === 'string' && NONCE.test(opts.nonce) ? opts.nonce : crypto.randomBytes(16).toString('base64');
  const L = Lay.layoutOf(message);
  const mux = M.analyseMux(message);
  const title = typeof opts.title === 'string' && opts.title ? opts.title : 'Bit layout of ' + message.name + ' (' + (isFinite(message.frameId) ? V.hex(message.frameId) : message.idText) + ')';
  const h = U.escapeHtml;
  const out = ['<!DOCTYPE html>', '<html lang="en">', '<head>', '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'nonce-' + nonce + '\'">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">', '<title>' + h(title) + '</title>', '<style nonce="' + nonce + '">', css(), '</style>', '</head>', '<body>', '<main>'];
  out.push('<h1>' + h(title) + '</h1>');
  out.push('<ul class="facts">' + Desc.messageFacts(db, message).map(function (f) { return '<li>' + h(f[0]) + ': ' + h(f[1]) + '</li>'; }).join('') + '</ul>');
  out.push('<h2>Bit layout</h2>');
  out.push('<ul class="legend"><li>Rows are bytes, columns are bits 7 (most significant, left) to 0.</li><li>A letter is the key of the signal that uses the bit; the signal table below lists the keys. Each signal also has its own colour and border style.</li>' +
    '<li>▲ marks the most significant bit of a signal, ▼ its least significant bit. A one-bit signal shows both.</li><li>· is an unused bit. A bit with a thick red border, hatching and the text ! is used by more than one signal.</li></ul>');
  const shown = L.groups.filter(function (g) { return L.groups.length === 1 || g.signals.length; });
  const drawn = shown.slice(0, MAX_GRIDS);
  for (const grp of drawn) {
    const rows = [];
    for (let byte = 0; byte < grp.grid.bytes; byte++) {
      const cells = [];
      for (let bit = 7; bit >= 0; bit--) cells.push(cellHtml(grp.grid.cells[byte * 8 + bit], byte, bit, message, L.keys));
      rows.push('<tr><th scope="row">Byte ' + byte + (byte >= message.size ? ' (beyond the data length)' : '') + '</th>' + cells.join('') + '</tr>');
    }
    out.push('<table class="grid">', '<caption>' + h(L.groups.length === 1 ? 'Layout of ' + message.name : grp.title) + (grp.overlaps ? ' (' + Desc.plural(grp.overlaps, 'bit') + ' used by more than one signal)' : '') + '</caption>',
      '<thead><tr><th scope="col">Byte</th>' + [7, 6, 5, 4, 3, 2, 1, 0].map(function (b) { return '<th scope="col">Bit ' + b + '</th>'; }).join('') + '</tr></thead>', '<tbody>', rows.join('\n'), '</tbody>', '</table>');
    if (grp.overlaps) {
      const o = overlapLines(grp, message, L.keys);
      out.push('<ul class="legend">' + o.lines.map(function (l) { return '<li>' + h(l) + '</li>'; }).join('') + (o.more ? '<li>' + h('and ' + o.more + ' more bits') + '</li>' : '') + '</ul>');
    }
  }
  const hidden = shown.length - drawn.length + L.more;
  if (hidden > 0) out.push('<p class="note">' + h(hidden + ' further combinations of multiplexor values are not drawn.') + '</p>');
  out.push('<h2>Signals</h2>');
  const head = ['Key', 'Signal', 'Start|length', 'Byte order', 'Value', 'Scaling', 'Unit', 'Note'];
  const rows = message.signals.slice(0, MAX_TABLE_ROWS).map(function (s) {
    return '<tr><th scope="row"><span class="swatch ' + styleClasses(s.index) + '">' + h(L.keys.get(s.index)) + '</span></th><td>' + h(s.name) + '</td><td>' + h(s.startBit + '|' + s.length) + '</td><td>' +
      (s.little ? 'Intel (little-endian)' : 'Motorola (big-endian)') + '</td><td>' + h(Desc.valueTypeLine(s)) + '</td><td>' + h(Desc.formulaLine(s).replace('physical = ', '')) + '</td><td>' + h(s.unit) + '</td><td>' + h(signalNote(mux, message, s)) + '</td></tr>';
  });
  out.push('<table class="sig">', '<caption>' + h('Signals of ' + message.name) + '</caption>', '<thead><tr>' + head.map(function (t) { return '<th scope="col">' + h(t) + '</th>'; }).join('') + '</tr></thead>', '<tbody>', rows.join('\n'), '</tbody>', '</table>');
  if (message.signals.length > MAX_TABLE_ROWS) out.push('<p class="note">' + h('and ' + (message.signals.length - MAX_TABLE_ROWS) + ' more signals.') + '</p>');
  if (!message.signals.length) out.push('<p class="note">The message has no signals.</p>');
  out.push('</main>', '</body>', '</html>');
  return out.join('\n') + '\n';
}

module.exports = { layoutHtml: layoutHtml, styleClasses: styleClasses, MAX_GRIDS: MAX_GRIDS };
