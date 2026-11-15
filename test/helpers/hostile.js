'use strict';
// Helpers for the robustness tests: a seeded random sequence, a builder of large databases,
// hostile names and a small scanner that finds live characters in inline Markdown.

const fs = require('node:fs');
const path = require('node:path');

/** A small seeded random sequence (mulberry32): the same seed gives the same numbers. */
function rng(seed) {
  let a = seed >>> 0;
  function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  next.int = function (n) { return Math.floor(next() * n); };
  next.pick = function (list) { return list[Math.floor(next() * list.length)]; };
  return next;
}

/** Runs fn and returns { value, ms }. */
function timed(fn) {
  const t = process.hrtime.bigint();
  const value = fn();
  return { value: value, ms: Number(process.hrtime.bigint() - t) / 1e6 };
}

const NS = 'NS_ :\n\tNS_DESC_\n\tCM_\n\tBA_DEF_\n\tBA_\n\tVAL_\n\tBA_DEF_DEF_\n\tVAL_TABLE_\n\tSIG_VALTYPE_\n\tBO_TX_BU_\n\tSG_MUL_VAL_\n';

/**
 * A large, valid database: `messages` messages with `signals` signals each (12 by default: four
 * 8-bit signals and eight 4-bit signals in 8 data bytes). Odd messages are big-endian. The first
 * 2,000 messages have standard IDs, the others extended IDs. Nodes N0 to N9.
 */
function bigDbc(messages, signalsPerMessage) {
  const per = signalsPerMessage || 12;
  const out = ['VERSION "big"', '', NS, 'BS_:', '', 'BU_: N0 N1 N2 N3 N4 N5 N6 N7 N8 N9', ''];
  for (let i = 0; i < messages; i++) {
    const motorola = i % 2 === 1;
    const id = i < 2000 ? i + 1 : 2147483648 + i;
    out.push('BO_ ' + id + ' Msg' + i + ': 8 N' + (i % 10));
    for (let k = 0; k < per; k++) {
      let start;
      let len;
      if (k < 4) { len = 8; start = motorola ? k * 8 + 7 : k * 8; }
      else if (k < 12) { len = 4; const nib = k - 4; start = motorola ? 32 + (nib >> 1) * 8 + (nib & 1 ? 3 : 7) : 32 + nib * 4; }
      else { len = 1; start = 0; }
      out.push(' SG_ Sig' + k + ' : ' + start + '|' + len + '@' + (motorola ? '0' : '1') + '+ (0.5,-3) [-3|' + (((1 << len) - 1) * 0.5 - 3) + '] "unit" N' + ((i + 1) % 10));
    }
    out.push('');
  }
  return out.join('\n');
}

/** Names (and texts) that would be dangerous if they reached a page or a spreadsheet unescaped. */
const HOSTILE_NAMES = Object.freeze([
  '<script>alert(1)</script>',
  '<img/src=x/onerror=alert(1)>',
  '"; DROP',
  '=cmd|\'/c',
  '`tick`',
  '``double``',
  '*bold*',
  '_under_',
  '#heading',
  '!image',
  '‮evil',
  '&lt;b&gt;',
  'a\u0000b',
  '+1+1',
  '-2+3',
  '@SUM'
]);

/** Names that the reader keeps as one word (no white space, quote, colon, semicolon, comma, pipe, at sign or brackets). */
const HOSTILE_WORDS = Object.freeze([
  '<script>',
  '<img/src=x/onerror=alert>',
  '`tick`',
  '``double``',
  '*bold*',
  '_under_',
  '#heading',
  '!image',
  '‮evil',
  '&lt',
  '=cmd',
  '+1+1',
  '-2+3',
  '~~strike~~',
  '{x}',
  '>quote',
  '\\back\\slash'
]);

/** Texts for comments, units and value descriptions (they may hold more than a name can). */
const HOSTILE_TEXTS = Object.freeze([
  '<script>alert(1)</script>',
  '[x](javascript:alert(1))',
  '![x](http://example.invalid/a.png)',
  '| a | b |\n| - | - |',
  'line one\nline two\r\nline three',
  '`code` and ``more`` and ```fence```',
  '=cmd|\' /c calc\'!A1',
  '‮right-to-left',
  '<img src=x onerror=alert(1)>',
  '* list\n# heading\n> quote',
  '&amp; &lt; &#60;'
]);

/**
 * Splits inline Markdown into the characters that a renderer would treat as syntax: backslash
 * escapes and code spans are removed, everything else is returned. Used to prove that no raw
 * markup characters from names and texts survive outside code spans.
 */
function liveMarkdown(md) {
  const s = String(md);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { i += 2; continue; }
    if (c === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      let j = i + run;
      let close = -1;
      while (j < s.length) {
        const k = s.indexOf(fence, j);
        if (k === -1) break;
        let end = k + run;
        if (s[end] === '`') { j = end; while (s[j] === '`') j++; continue; }
        close = k;
        break;
      }
      if (close === -1) { out += c; i++; continue; }
      i = close + run;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The cells of one Markdown table row (a row that starts with "|"), split at unescaped pipes. */
function tableCells(line) {
  const body = line.replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && i + 1 < body.length) { cur += body[i] + body[i + 1]; i++; continue; }
    if (body[i] === '|') { cells.push(cur); cur = ''; continue; }
    cur += body[i];
  }
  cells.push(cur);
  return cells;
}

/** Every .dbc file of the corpus folder (the folder may not exist): [{ name, text }]. */
function corpusFiles() {
  const dir = path.join(__dirname, '..', 'fixtures', 'corpus');
  let names;
  try { names = fs.readdirSync(dir).filter(function (n) { return /\.dbc$/i.test(n); }).sort(); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    try {
      const buf = fs.readFileSync(path.join(dir, n));
      if (buf.length > 400000) continue;
      out.push({ name: n, text: buf.toString('latin1') });
    } catch (e) { /* unreadable file: skipped */ }
  }
  return out;
}

module.exports = { rng: rng, timed: timed, bigDbc: bigDbc, HOSTILE_NAMES: HOSTILE_NAMES, HOSTILE_WORDS: HOSTILE_WORDS, HOSTILE_TEXTS: HOSTILE_TEXTS, liveMarkdown: liveMarkdown, tableCells: tableCells, corpusFiles: corpusFiles, NS: NS };
