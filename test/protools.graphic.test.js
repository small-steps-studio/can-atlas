'use strict';
// Tests of the graphical bit layout page and of the worked examples in docs/bit-layout.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../src/dbc/parse');
const Lay = require('../src/dbc/layout');
const { sampleFor } = require('../src/samples');
const { layoutHtml, styleClasses } = require('../src/pro/graphic');

const NONCE = 'abcdefgh12345678';

function page(text, index, options) {
  const db = P.parseDbc(text);
  return layoutHtml(db, db.messages[index || 0], Object.assign({ nonce: NONCE }, options || {}));
}

function rowLabels(html, byte) {
  const m = new RegExp('<th scope="row">Byte ' + byte + '[^<]*</th>(.*?)</tr>').exec(html);
  assert.ok(m, 'row of byte ' + byte);
  return [...m[1].matchAll(/aria-label="([^"]*)"/g)].map(function (x) { return x[1]; });
}

function rowTexts(html, byte) {
  const m = new RegExp('<th scope="row">Byte ' + byte + '[^<]*</th>(.*?)</tr>').exec(html);
  return [...m[1].matchAll(/<span aria-hidden="true">([^<]*)<\/span>/g)].map(function (x) { return x[1]; });
}

const INTEL = 'VERSION ""\nBU_: N\nBO_ 1 M: 3 N\n SG_ Speed : 4|12@1+ (1,0) [0|0] "" N\n';
const MOTOROLA = 'VERSION ""\nBU_: N\nBO_ 1 M: 3 N\n SG_ Temp : 11|12@0+ (1,0) [0|0] "" N\n';

test('page: complete document with the content security policy tied to the style nonce', () => {
  const html = page(INTEL);
  assert.ok(html.startsWith('<!DOCTYPE html>\n<html lang="en">'));
  assert.ok(html.includes('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'nonce-' + NONCE + '\'">'));
  assert.ok(html.includes('<style nonce="' + NONCE + '">'));
  assert.ok(html.includes('<title>Bit layout of M (0x1)</title>'));
  assert.ok(html.trimEnd().endsWith('</html>'));
});

test('page: no script, no style attribute, no event handler, no address', () => {
  const html = page(sampleFor('valid').text, 3);
  assert.ok(!/<script/i.test(html));
  assert.ok(!/\sstyle\s*=/i.test(html));
  assert.ok(!/\son[a-z]+\s*=/i.test(html));
  assert.ok(!/https?:|\/\/[a-z]/i.test(html));
  assert.ok(!/<(img|iframe|link|object|embed|form|input)\b/i.test(html));
});

test('page: a missing or unusable nonce is replaced by a fresh random one', () => {
  const db = P.parseDbc(INTEL);
  const a = layoutHtml(db, db.messages[0], { nonce: '"><script>alert(1)</script>' });
  const b = layoutHtml(db, db.messages[0], {});
  const na = /style-src 'nonce-([^']+)'/.exec(a)[1];
  const nb = /style-src 'nonce-([^']+)'/.exec(b)[1];
  assert.match(na, /^[A-Za-z0-9+/=]{20,}$/);
  assert.ok(a.includes('<style nonce="' + na + '">'));
  assert.ok(b.includes('<style nonce="' + nb + '">'));
  assert.notEqual(na, nb);
  assert.ok(!a.includes('alert(1)'));
});

test('page: cspSource is accepted and changes nothing, the title option is escaped', () => {
  const db = P.parseDbc(INTEL);
  const a = layoutHtml(db, db.messages[0], { nonce: NONCE, cspSource: 'vscode-webview://abc' });
  assert.equal(a, layoutHtml(db, db.messages[0], { nonce: NONCE }));
  const b = layoutHtml(db, db.messages[0], { nonce: NONCE, title: '<b>"x"</b>' });
  assert.ok(b.includes('<title>&lt;b&gt;&quot;x&quot;&lt;/b&gt;</title>'));
  assert.ok(b.includes('<h1>&lt;b&gt;&quot;x&quot;&lt;/b&gt;</h1>'));
});

test('intel example: start bit 4, 12 bits, runs from byte 0 bit 4 up to byte 1 bit 7', () => {
  const html = page(INTEL);
  assert.deepEqual(rowLabels(html, 0), ['byte 0 bit 7: signal Speed', 'byte 0 bit 6: signal Speed', 'byte 0 bit 5: signal Speed', 'byte 0 bit 4: signal Speed, least significant bit',
    'byte 0 bit 3: unused', 'byte 0 bit 2: unused', 'byte 0 bit 1: unused', 'byte 0 bit 0: unused']);
  assert.deepEqual(rowTexts(html, 0), ['A', 'A', 'A', 'A ▼', '·', '·', '·', '·']);
  assert.deepEqual(rowTexts(html, 1), ['A ▲', 'A', 'A', 'A', 'A', 'A', 'A', 'A']);
  assert.equal(rowLabels(html, 1)[0], 'byte 1 bit 7: signal Speed, most significant bit');
  assert.deepEqual(rowTexts(html, 2), ['·', '·', '·', '·', '·', '·', '·', '·']);
  assert.ok(html.includes('<td class="cell k0 b0" aria-label="byte 1 bit 7: signal Speed, most significant bit"><span aria-hidden="true">A ▲</span></td>'));
  assert.ok(html.includes('<td class="cell empty" aria-label="byte 0 bit 3: unused"><span aria-hidden="true">·</span></td>'));
});

test('motorola example: start bit 11 is the most significant bit and the signal ends at byte 2 bit 0', () => {
  const html = page(MOTOROLA);
  assert.deepEqual(rowTexts(html, 0), ['·', '·', '·', '·', '·', '·', '·', '·']);
  assert.deepEqual(rowTexts(html, 1), ['·', '·', '·', '·', 'A ▲', 'A', 'A', 'A']);
  assert.deepEqual(rowTexts(html, 2), ['A', 'A', 'A', 'A', 'A', 'A', 'A', 'A ▼']);
  assert.equal(rowLabels(html, 1)[4], 'byte 1 bit 3: signal Temp, most significant bit');
  assert.equal(rowLabels(html, 2)[7], 'byte 2 bit 0: signal Temp, least significant bit');
  assert.equal(rowLabels(html, 1)[3], 'byte 1 bit 4: unused');
});

test('overlap: a shared bit has the thick border class, both keys, the text ! and a legend line', () => {
  const html = page('VERSION ""\nBU_: N\nBO_ 1 M: 2 N\n SG_ First : 0|8@1+ (1,0) [0|0] "" N\n SG_ Second : 4|8@1+ (1,0) [0|0] "" N\n');
  // First uses bits 0 to 7, Second bits 4 to 11: bits 7 to 4 of byte 0 are shared, Second continues in byte 1 bits 3 to 0.
  assert.deepEqual(rowTexts(html, 0), ['A+B !', 'A+B !', 'A+B !', 'A+B !', 'A', 'A', 'A', 'A ▼']);
  assert.deepEqual(rowTexts(html, 1), ['·', '·', '·', '·', 'B ▲', 'B', 'B', 'B']);
  assert.ok(html.includes('<td class="cell ov" aria-label="byte 0 bit 7: signals First and Second overlap">'));
  assert.ok(html.includes('4 bits used by more than one signal'));
  assert.ok(html.includes('<li>byte 0 bit 4: A (First), B (Second)</li>'));
  assert.ok(html.includes('<li>byte 0 bit 7: A (First), B (Second)</li>'));
  assert.ok(html.includes('td.cell.ov { border: 4px solid #e53935;'));
});

test('a one-bit signal shows both marks and says it is the only bit', () => {
  const html = page('VERSION ""\nBU_: N\nBO_ 1 M: 1 N\n SG_ Flag : 3|1@1+ (1,0) [0|1] "" N\n');
  assert.deepEqual(rowTexts(html, 0), ['·', '·', '·', '·', 'A ▲▼', '·', '·', '·']);
  assert.equal(rowLabels(html, 0)[4], 'byte 0 bit 3: signal Flag, the only bit');
});

test('a 64-byte message has 64 rows', () => {
  const html = page('VERSION ""\nBU_: N\nBO_ 1 Big: 64 N\n SG_ First : 0|8@1+ (1,0) [0|0] "" N\n SG_ Last : 504|8@1+ (1,0) [0|0] "" N\n');
  assert.equal((html.match(/<th scope="row">Byte \d+/g) || []).length, 64);
  assert.equal(rowLabels(html, 63)[0], 'byte 63 bit 7: signal Last, most significant bit');
  assert.equal(rowLabels(html, 0)[7], 'byte 0 bit 0: signal First, least significant bit');
});

test('a multiplexed message gets one grid per combination, with stable keys', () => {
  const html = page(sampleFor('valid').text, 3);
  const captions = [...html.matchAll(/<caption>([^<]*)<\/caption>/g)].map(function (m) { return m[1]; });
  assert.ok(captions.includes('Signals present in every frame'));
  assert.ok(captions.includes('PageIndex = 0'));
  assert.ok(captions.includes('PageIndex = 1'));
  assert.ok(captions.includes('PageIndex = 2'));
  assert.ok(captions.includes('Signals of TripComputer'));
  // PageIndex is signal A in every grid; TripDistance (m0) is B and sits at bits 8 to 31 of the page-0 grid.
  assert.equal((html.match(/signal PageIndex, most significant bit/g) || []).length >= 4, true);
  assert.ok(html.includes('<span class="swatch k1 b1">B</span></th><td>TripDistance</td>'));
  assert.ok(html.includes('<td>present when PageIndex = 0</td>'));
});

test('colours and border styles: 48 signals get 48 different combinations, the first 12 differ by colour', () => {
  const seen = new Set();
  for (let i = 0; i < 48; i++) seen.add(styleClasses(i));
  assert.equal(seen.size, 48);
  assert.equal(styleClasses(0), 'k0 b0');
  assert.equal(styleClasses(12).split(' ')[0], 'k0');
  assert.notEqual(styleClasses(12), styleClasses(0));
  const colours = new Set();
  const borders = new Set();
  for (let i = 0; i < 12; i++) { colours.add(styleClasses(i).split(' ')[0]); borders.add(styleClasses(i).split(' ')[1]); }
  assert.equal(colours.size, 12);
  assert.equal(borders.size, 4);
});

test('styles: editor colour variables with fallbacks, forced-colors rules, dark and light', () => {
  const html = page(INTEL);
  assert.ok(html.includes('color-scheme: light dark'));
  assert.ok(html.includes('var(--vscode-editor-background, Canvas)'));
  assert.ok(html.includes('var(--vscode-foreground, CanvasText)'));
  assert.ok(html.includes('@media (forced-colors: active)'));
  assert.ok(html.includes('border-color: Highlight'));
  for (let i = 0; i < 12; i++) assert.ok(html.includes('.k' + i + ' { background-color: hsl('), 'colour ' + i);
  for (const b of ['solid', 'dashed', 'dotted', 'double']) assert.ok(html.includes('border-style: ' + b + ';'), b);
});

test('tables: captions, column and row headers, a legend', () => {
  const html = page(INTEL);
  assert.ok(html.includes('<caption>Layout of M</caption>'));
  assert.ok(html.includes('<th scope="col">Bit 7</th>'));
  assert.ok(html.includes('<th scope="row">Byte 0</th>'));
  assert.ok(html.includes('<th scope="col">Start|length</th>'));
  assert.ok(html.includes('<th scope="row"><span class="swatch k0 b0">A</span></th><td>Speed</td><td>4|12</td><td>Intel (little-endian)</td><td>unsigned integer</td><td>raw × 1 + 0</td><td></td><td></td></tr>'));
  assert.ok(html.includes('▲ marks the most significant bit'));
  assert.ok(html.includes('· is an unused bit'));
});

test('hostile names, units and comments are escaped', () => {
  const text = 'VERSION ""\nBU_: N\nBO_ 1 <img_src=x_onerror=alert1>: 2 N\n SG_ <b>bold</b> : 0|8@1+ (1,0) [0|0] "\\"><script>alert(1)</script>" N\nCM_ BO_ 1 "<script>x</script>";\n';
  const html = page(text);
  assert.ok(!/<script/i.test(html));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<b>bold'));
  assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt;'));
  assert.ok(html.includes('&lt;img_src=x_onerror=alert1&gt;'));
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!/\son[a-z]+\s*=/i.test(html.replace(/&lt;[^&]*&gt;/g, '')));
  for (const m of html.matchAll(/aria-label="([^"]*)"/g)) assert.ok(!/[<>"]/.test(m[1]));
});

test('a signal beyond the data length adds a row marked as beyond it', () => {
  const html = page('VERSION ""\nBU_: N\nBO_ 1 M: 2 N\n SG_ Wide : 8|16@1+ (1,0) [0|0] "" N\n');
  assert.ok(html.includes('<th scope="row">Byte 2 (beyond the data length)</th>'));
  assert.ok(html.includes('<th scope="row">Byte 1</th>'));
  assert.ok(!html.includes('<th scope="row">Byte 1 (beyond'));
});

test('signals that cannot be drawn are listed with the reason', () => {
  const html = page('VERSION ""\nBU_: N\nBO_ 1 M: 8 N\n SG_ Good : 0|8@1+ (1,0) [0|0] "" N\n SG_ Far : 600|8@1+ (1,0) [0|0] "" N\n SG_ Wrong : 0|70@1+ (1,0) [0|0] "" N\n');
  assert.ok(html.includes('<td>not drawn: outside the 64 bytes of the largest frame</td>'));
  assert.ok(html.includes('<td>not drawn: start bit or length is not valid</td>'));
  assert.equal((html.match(/signal Good/g) || []).length > 0, true);
});

test('a message without signals still gives a page', () => {
  const html = page('VERSION ""\nBU_: N\nBO_ 1 Empty: 4 N\n');
  assert.ok(html.includes('The message has no signals.'));
  assert.equal((html.match(/<th scope="row">Byte \d/g) || []).length, 4);
});

test('a message with more than 1,000 signals lists the first 1,000 and says how many are left', () => {
  const lines = ['VERSION ""', 'BU_: N', 'BO_ 1 Many: 64 N'];
  for (let i = 0; i < 1200; i++) lines.push(' SG_ S' + i + ' : ' + (i % 512) + '|1@1+ (1,0) [0|1] "" N');
  const t = Date.now();
  const html = page(lines.join('\n') + '\n');
  assert.ok(Date.now() - t < 5000);
  assert.ok(html.includes('and 200 more signals.'));
  assert.equal((html.match(/<span class="swatch /g) || []).length, 1000);
});

test('docs/bit-layout.md: the two worked examples are the tables the product draws', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'bit-layout.md'), 'utf8');
  // Spaces around the pipes do not matter: the product writes "| 0| A |", the document "| 0 | A |".
  const norm = function (line) { return line.replace(/\s*\|\s*/g, '|').trim(); };
  const docLines = new Set(doc.split('\n').map(norm));
  for (const text of [INTEL, MOTOROLA]) {
    const db = P.parseDbc(text);
    const md = Lay.layoutMarkdown(db, db.messages[0]);
    const grid = md.split('\n').filter(function (l) { return /^\| (Byte|---: |[0-9]\|? )/.test(l); });
    assert.equal(grid.length, 5);
    for (const line of grid) assert.ok(docLines.has(norm(line)), line);
  }
});
