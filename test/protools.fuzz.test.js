'use strict';
// Seeded damage to the sample files: the four Pro tools must never throw and never write live markup.

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/dbc/parse');
const U = require('../src/util');
const { sampleFor } = require('../src/samples');
const { documentationMarkdown, documentationHtml } = require('../src/pro/docgen');
const { signalsToCsv, csvToDbc, COLUMNS } = require('../src/pro/csvdbc');
const { inventoryFiles, inventoryHtml, inventoryMarkdown, inventoryCsv } = require('../src/pro/inventory');
const { layoutHtml } = require('../src/pro/graphic');

function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NASTY = ['<script>', '"', '\\', '|', '`', '=', '@', '‮', '\u0000', '\r', '\n', ';', ',', '-', '[', ']', '(', ')', '99999999999999999999', '*', '#', '<img src=x onerror=1>', 'BO_ 1 X: 8 N\n', ' SG_ '];

function damage(text, seed) {
  const r = rng(seed);
  let s = text;
  const n = 1 + Math.floor(r() * 6);
  for (let i = 0; i < n; i++) {
    const at = Math.floor(r() * s.length);
    const kind = Math.floor(r() * 5);
    if (kind === 0) s = s.slice(0, at) + s.slice(at + 1 + Math.floor(r() * 40));
    else if (kind === 1) s = s.slice(0, at) + NASTY[Math.floor(r() * NASTY.length)] + s.slice(at);
    else if (kind === 2) s = s.slice(0, at);
    else if (kind === 3) { const len = 1 + Math.floor(r() * 200); s = s.slice(0, at) + s.slice(at, at + len) + s.slice(at); }
    else s = s.slice(0, at) + String.fromCharCode(33 + Math.floor(r() * 90)) + s.slice(at + 1);
  }
  return s;
}

const TAGS = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'main', 'h1', 'h2', 'h3', 'p', 'nav', 'ul', 'li', 'a', 'table', 'caption', 'thead', 'tbody', 'tr', 'th', 'td', 'section', 'span']);

function assertSafeHtml(html, label) {
  assert.equal(typeof html, 'string', label);
  assert.ok(!/<script/i.test(html), label + ': script');
  assert.ok(!/<(img|iframe|object|embed|link|form|input|svg|math)\b/i.test(html), label + ': element');
  for (const m of html.replace(/<style[^>]*>[\s\S]*?<\/style>/, '').matchAll(/<\/?([A-Za-z][A-Za-z0-9]*)/g)) assert.ok(TAGS.has(m[1].toLowerCase()), label + ': tag ' + m[1]);
  assert.ok(!/\son[a-z]+\s*=/i.test(html.replace(/&lt;[^&]*&gt;/g, '')), label + ': handler');
}

test('fuzz: 300 damaged copies of the sample go through documentation, CSV, layout and inventory without an error', () => {
  const base = sampleFor('valid').text;
  const problems = sampleFor('problems').text;
  let withMessages = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const text = damage(seed % 3 === 0 ? problems : base, seed * 104729);
    const db = P.parseDbc(text);
    const md = documentationMarkdown(db, { name: 'f' + seed + '.dbc' });
    assert.equal(typeof md, 'string');
    assert.ok(!/<script/i.test(md.replace(/\\</g, '')), 'markdown ' + seed);
    assertSafeHtml(documentationHtml(db, { name: 'f' + seed + '.dbc' }), 'documentation ' + seed);
    const csv = signalsToCsv(db);
    for (const row of U.parseCsv(csv).rows) assert.equal(row.length, COLUMNS.length, 'csv cells ' + seed);
    const back = csvToDbc(csv);
    assert.equal(typeof back.dbc, 'string');
    for (const p of back.problems) assert.ok(Number.isInteger(p.line) && p.line >= 1 && typeof p.message === 'string', 'problem shape ' + seed);
    if (back.dbc) assert.deepEqual(P.parseDbc(back.dbc).problems.filter((p) => p.severity === 'error'), [], 'the DBC written from rows of seed ' + seed + ' reads back without a syntax error');
    for (const m of db.messages) {
      assertSafeHtml(layoutHtml(db, m, { nonce: 'abcdefgh12345678' }), 'layout ' + seed);
      withMessages++;
    }
    const inv = inventoryFiles([{ name: 'a' + seed + '.dbc', text: text }, { name: 'b.dbc', text: base }]);
    assertSafeHtml(inventoryHtml(inv, { name: 'x' }), 'inventory ' + seed);
    assert.equal(typeof inventoryMarkdown(inv, {}), 'string');
    for (const row of U.parseCsv(inventoryCsv(inv, {})).rows) assert.equal(row.length, 8);
    for (const row of U.parseCsv(inventoryCsv(inv, {}, { table: 'collisions' })).rows) assert.equal(row.length, 9);
  }
  assert.ok(withMessages > 1000, withMessages + ' message pages');
});

test('fuzz: damaged CSV tables never throw and always give consistent counts', () => {
  const csv = signalsToCsv(P.parseDbc(sampleFor('valid').text));
  for (let seed = 1; seed <= 300; seed++) {
    const r = csvToDbc(damage(csv, seed * 7919));
    assert.equal(typeof r.dbc, 'string');
    assert.ok(r.messages >= 0 && r.signals >= 0);
    if (!r.dbc) { assert.equal(r.messages, 0); assert.equal(r.signals, 0); continue; }
    const db = P.parseDbc(r.dbc);
    assert.equal(db.messages.length, r.messages, 'seed ' + seed);
    assert.equal(db.messages.reduce((n, m) => n + m.signals.length, 0), r.signals, 'seed ' + seed);
  }
});

test('hostile input does not stall: a 3 MB comment, 100,000 value descriptions and a 1 MB cell', () => {
  const big = 'x'.repeat(3 * 1024 * 1024);
  const values = [];
  for (let i = 0; i < 100000; i++) values.push(i + ' "v' + i + '"');
  const text = 'VERSION ""\nBU_: N\nBO_ 1 M: 8 N\n SG_ S : 0|8@1+ (1,0) [0|0] "" N\nCM_ SG_ 1 S "' + big + '";\nVAL_ 1 S ' + values.join(' ') + ' ;\n';
  const t = Date.now();
  const db = P.parseDbc(text);
  const md = documentationMarkdown(db, { name: 'big' });
  const html = documentationHtml(db, { name: 'big' });
  const csv = signalsToCsv(db);
  const back = csvToDbc(csv);
  const page = layoutHtml(db, db.messages[0], { nonce: 'abcdefgh12345678' });
  const ms = Date.now() - t;
  assert.ok(md.length > 3 * 1024 * 1024 && html.length > 3 * 1024 * 1024 && page.length > 0);
  assert.equal(back.signals, 1);
  assert.ok(ms < 5000, ms + ' ms');
  const cell = csvToDbc('message_id,message,signal,start_bit,length,comment\r\n0x1,M,S,0,8,"' + 'y'.repeat(1024 * 1024) + '"\r\n');
  assert.equal(cell.signals, 1);
});

test('hostile input does not stall: very long and deeply repeated structures in a CSV table', () => {
  const rows = ['message_id,message,signal,start_bit,length,values'];
  for (let i = 0; i < 2000; i++) rows.push('0x1,M,S' + i + ',0,1,"' + new Array(50).fill('1=a').join(';') + '"');
  const t = Date.now();
  const r = csvToDbc(rows.join('\r\n'));
  assert.ok(Date.now() - t < 5000);
  assert.equal(r.signals, 0, 'every row repeats the raw value 1 and is refused');
  assert.equal(r.problems.length, 2000);
  const ok = csvToDbc(rows.map((l, i) => i === 0 ? l : l.replace(/"[^"]*"$/, '"1=a"')).join('\r\n'));
  assert.equal(ok.signals, 2000);
});
