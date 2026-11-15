'use strict';
// Tests of the comparison reports (Markdown, HTML, CSV) with hostile text from the files.

const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../src/dbc/parse');
const X = require('../src/pro/diff');
const R = require('../src/pro/diffreport');
const U = require('../src/util');

const UNITS = [
  '<script>alert1</script>', '<img src=x onerror=alert1>', "=cmd|' /C calc'!A0", '-1+2', '@SUM1', '+1', '\tTAB', ']]>', '|pipe|', '`tick`',
  'a‏b', '[x](http://evil.example)', '![i](http://evil.example/a.png)', 'javascript:alert1', 'www.evil.example', 'user@evil.example', '*bold* _it_ ~~s~~', '#heading', '&amp; &lt;', 'a,b', '- item'
];
const NAMES = ['<script>alert1</script>', '=cmd', '-1+2', '+1x', '<img/src=x/onerror=alert1>', 'www.evil.example', 'a.b/c'];

function hostilePair() {
  const head = 'VERSION "1"\n\nBU_: A\n\n';
  const oldLines = [head];
  const newLines = [head.replace('VERSION "1"', 'VERSION "<b>2</b>"')];
  const comments = [];
  UNITS.forEach(function (u, i) {
    oldLines.push('BO_ ' + (100 + i) + ' M' + i + ': 8 A\n SG_ S' + i + ' : 0|8@1+ (1,0) [0|0] "x" A\n\n');
    newLines.push('BO_ ' + (100 + i) + ' M' + i + ': 8 A\n SG_ S' + i + ' : 0|8@1+ (1,0) [0|0] "' + u + '" A\n\n');
    comments.push('CM_ BO_ ' + (100 + i) + ' "' + u + '";\n');
  });
  NAMES.forEach(function (n, i) {
    const id = 500 + i;
    oldLines.push('BO_ ' + id + ' Old' + i + ': 8 A\n SG_ Sig' + i + ' : 0|8@1+ (1,0) [0|0] "" A\n\n');
    newLines.push('BO_ ' + id + ' ' + n + ': 8 A\n SG_ ' + n + 'x : 0|8@1+ (1,0) [0|0] "" A\n\n');
  });
  return { oldText: oldLines.join(''), newText: newLines.join('') + comments.join('') };
}

function hostileResult() {
  const pair = hostilePair();
  return X.diffDatabases(P.parseDbc(pair.oldText), P.parseDbc(pair.newText));
}

const META = { oldName: '<script>old.dbc</script>', newName: '"=new|`.dbc' };

test('the hostile comparison has the changes the test relies on', function () {
  const r = hostileResult();
  const codes = new Set(r.changes.map(function (c) { return c.code; }));
  for (const code of ['DIFF-VERSION-CHANGED', 'DIFF-SIGNAL-UNIT-CHANGED', 'DIFF-MESSAGE-COMMENT-CHANGED', 'DIFF-MESSAGE-RENAMED', 'DIFF-SIGNAL-RENAMED']) assert.ok(codes.has(code), code);
  assert.ok(r.changes.length >= UNITS.length * 2 + NAMES.length * 2);
});

// ---- Markdown -------------------------------------------------------------------------------------

function unescapedPipes(line) {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '|') n++;
  }
  return n;
}

test('Markdown: every table row keeps its three cells and no markup stays live', function () {
  const md = R.diffMarkdown(hostileResult(), META);
  const rows = md.split('\n').filter(function (l) { return l.startsWith('| '); });
  assert.ok(rows.length > 50);
  for (const row of rows) assert.equal(unescapedPipes(row), 4, row);
  const body = md.split('\n').filter(function (l) { return !l.startsWith('* Old:') && !l.startsWith('* New:'); }).join('\n');
  assert.ok(!/(^|[^\\])</.test(body), 'an unescaped < is left');
  assert.ok(!/(^|[^\\])\]\(/.test(md), 'a link is left');
  assert.ok(!/(^|[^\\])!\[/.test(md), 'an image is left');
  assert.ok(!md.includes('://'), 'an address is left intact');
  assert.ok(!/www\./i.test(md), 'a www address is left intact');
  assert.ok(!/[a-z]@[a-z]/i.test(md), 'an e-mail address is left intact');
  assert.ok(!md.includes('‏'), 'a text direction mark is left');
  assert.ok(md.includes('\\[U\\+200F\\]'), 'the text direction mark is shown');
  assert.ok(!md.includes('\t'), 'a tab is left');
  assert.ok(!md.includes('\r'), 'a carriage return is left');
  assert.ok(md.startsWith('# DBC comparison\n'));
});

test('Markdown: the names of the files cannot close their code span', function () {
  const md = R.diffMarkdown(hostileResult(), { oldName: 'a`b``c', newName: '`' });
  const lines = md.split('\n');
  assert.ok(lines.some(function (l) { return l.startsWith('* Old: ```'); }));
});

test('Markdown: an empty comparison says so', function () {
  const p = P.parseDbc('VERSION ""\n');
  const md = R.diffMarkdown(X.diffDatabases(p, p), {});
  assert.match(md, /No differences\./);
  assert.ok(!md.includes('| Code |'));
});

// ---- HTML -----------------------------------------------------------------------------------------

const ALLOWED_TAGS = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'main', 'h1', 'h2', 'p', 'br', 'code', 'section', 'table', 'caption', 'thead', 'tbody', 'tr', 'th', 'td', 'span']);

test('HTML: only the tags of the page itself are live, none with a script or an address', function () {
  const html = R.diffHtml(hostileResult(), META);
  const tags = html.match(/<[^>]*>/g) || [];
  assert.ok(tags.length > 200);
  for (const t of tags) {
    const name = /^<\/?([A-Za-z0-9]+)/.exec(t);
    if (t.startsWith('<!DOCTYPE')) continue;
    assert.ok(name && ALLOWED_TAGS.has(name[1].toLowerCase()), 'unexpected tag ' + t);
    assert.ok(!/\son[a-z]+\s*=/i.test(t), 'event handler in ' + t);
    assert.ok(!/\s(src|href|action|formaction|data|srcset|style)\s*=/i.test(t), 'address or style attribute in ' + t);
  }
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('&lt;script&gt;alert1&lt;/script&gt;'));
  assert.ok(!html.includes('‏'));
  assert.ok(html.includes('[U+200F]'));
});

test('HTML: language, content security policy, table headers and a class in words', function () {
  const html = R.diffHtml(hostileResult(), META);
  assert.ok(html.startsWith('<!DOCTYPE html>\n<html lang="en">'));
  assert.ok(html.includes('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'));
  assert.ok(html.includes('<meta charset="utf-8">'));
  const ths = html.match(/<th[ >][^>]*>?/g) || [];
  assert.ok(ths.length >= 4);
  for (const th of ths) assert.ok(/scope="col"/.test(th), th);
  assert.ok(/<span class="badge breaking">BREAKING<\/span>/.test(html));
  assert.ok(/<span class="badge cosmetic">COSMETIC<\/span>/.test(html));
  assert.ok(!/https?:\/\//.test(html.replace(/&lt;[^]*?&gt;/g, '').replace(/http:\/\/evil\.example[^<]*/g, '')), 'a live address');
});

test('HTML: each class has its own heading, badge and colour class', function () {
  const a = 'VERSION "1"\n\nBU_: A\n\nBO_ 1 M: 8 A\n SG_ S : 0|8@1+ (1,0) [0|0] "" A\n';
  const b = 'VERSION "2"\n\nBU_: A B\n\nBO_ 1 M: 8 A\n SG_ S : 0|8@1+ (2,0) [0|0] "" A\n';
  const html = R.diffHtml(X.diffDatabases(P.parseDbc(a), P.parseDbc(b)), {});
  assert.ok(/<h2>Breaking changes \(1\)<\/h2>/.test(html));
  assert.ok(/<h2>Non-breaking changes \(1\)<\/h2>/.test(html));
  assert.ok(/<h2>Cosmetic changes \(1\)<\/h2>/.test(html));
  assert.ok(/<span class="badge breaking">BREAKING<\/span>/.test(html));
  assert.ok(/<span class="badge nonbreaking">NON-BREAKING<\/span>/.test(html));
  assert.ok(/<span class="badge cosmetic">COSMETIC<\/span>/.test(html));
  const md = R.diffMarkdown(X.diffDatabases(P.parseDbc(a), P.parseDbc(b)), {});
  assert.ok(md.indexOf('## Breaking changes (1)') < md.indexOf('## Non-breaking changes (1)') && md.indexOf('## Non-breaking changes (1)') < md.indexOf('## Cosmetic changes (1)'));
});

test('HTML: the names of the files are escaped in the title block', function () {
  const html = R.diffHtml(hostileResult(), META);
  assert.ok(html.includes('<code>&lt;script&gt;old.dbc&lt;/script&gt;</code>'));
  assert.ok(html.includes('<code>&quot;=new|`.dbc</code>'));
});

// ---- CSV ------------------------------------------------------------------------------------------

const PLAIN = /^-?\d+(\.\d+)?$/;

test('CSV: every row has ten cells after an RFC 4180 parse and no cell can run as a formula', function () {
  const csv = R.diffCsv(hostileResult(), META);
  const parsed = U.parseCsv(csv);
  assert.equal(parsed.error, '');
  assert.deepEqual(parsed.rows[0], R.CSV_HEADER);
  assert.ok(parsed.rows.length > 50);
  for (const row of parsed.rows) {
    assert.equal(row.length, 10, row.join('|'));
    for (const cell of row) assert.ok(!/^[=+\-@\t\r]/.test(cell) || PLAIN.test(cell), 'formula start in ' + JSON.stringify(cell));
  }
  assert.ok(csv.endsWith('\r\n'));
});

test('CSV: the values that start like a formula get exactly one apostrophe in front', function () {
  const parsed = U.parseCsv(R.diffCsv(hostileResult(), META));
  const cells = new Set();
  for (const row of parsed.rows) for (const cell of row) cells.add(cell);
  assert.ok(cells.has('\'=cmd|\' /C calc\'!A0'));
  assert.ok(cells.has('\'-1+2'));
  assert.ok(cells.has('\'@SUM1'));
  assert.ok(cells.has('\'+1'));
  assert.ok(cells.has('\'\tTAB'));
});

test('CSV: with neutralising turned off the values are exact and the table still parses', function () {
  const csv = R.diffCsv(hostileResult(), META, { neutralise: false });
  const parsed = U.parseCsv(csv);
  assert.equal(parsed.error, '');
  for (const row of parsed.rows) assert.equal(row.length, 10);
  const cells = new Set();
  for (const row of parsed.rows) for (const cell of row) cells.add(cell);
  assert.ok(cells.has('=cmd|\' /C calc\'!A0'));
  assert.ok(cells.has('-1+2'));
  assert.ok(cells.has('a,b'));
});

test('CSV: commas, quotes and line breaks inside values survive', function () {
  const a = 'VERSION ""\n\nBU_: A\n\nBO_ 1 M: 8 A\n SG_ S : 0|8@1+ (1,0) [0|0] "x" A\n';
  const b = a.replace('"x"', '"a, \\"q\\" b"') + 'CM_ BO_ 1 "line one\nline two, with comma";\n';
  const r = X.diffDatabases(P.parseDbc(a), P.parseDbc(b));
  const parsed = U.parseCsv(R.diffCsv(r, {}));
  assert.equal(parsed.error, '');
  assert.equal(parsed.rows.length, 3);
  for (const row of parsed.rows) assert.equal(row.length, 10);
  const all = parsed.rows.map(function (row) { return row.join('\n'); }).join('\n');
  assert.ok(all.includes('a, "q" b'));
  assert.ok(all.includes('line one\nline two, with comma'));
});

test('CSV: an empty comparison is the header row only', function () {
  const p = P.parseDbc('VERSION ""\n');
  const csv = R.diffCsv(X.diffDatabases(p, p), {});
  assert.equal(csv.split('\r\n').filter(Boolean).length, 1);
});

// ---- helpers and size -----------------------------------------------------------------------------

test('hidden characters are shown, ordinary text is kept', function () {
  assert.equal(R.visible('a‏b‮c'), 'a[U+200F]b[U+202E]c');
  assert.equal(R.visible('x\ty\r\nz'), 'x[U+0009]y[U+000D][U+000A]z');
  assert.equal(R.visible('Grüße ☃ 速度'), 'Grüße ☃ 速度');
  assert.equal(R.visible(null), '');
});

test('reports of a comparison with 10,000 added messages are written in under 5 seconds', function () {
  const lines = ['VERSION ""', '', 'BU_: A', ''];
  for (let i = 0; i < 10000; i++) lines.push('BO_ ' + (1000 + i) + ' Msg' + i + ': 8 A', ' SG_ V' + i + ' : 0|8@1+ (1,0) [0|0] "" A', '');
  const result = X.diffDatabases(P.parseDbc('VERSION ""\n\nBU_: A\n'), P.parseDbc(lines.join('\n')));
  assert.equal(result.changes.length, 10000);
  const t0 = Date.now();
  const md = R.diffMarkdown(result, {});
  const html = R.diffHtml(result, {});
  const csv = R.diffCsv(result, {});
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, 'took ' + ms + ' ms');
  assert.ok(md.length > 100000 && html.length > 100000 && csv.length > 100000);
});
