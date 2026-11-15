'use strict';
// Tests of the inventory of several DBC files and its reports.

const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../src/util');
const { inventoryFiles, inventoryMarkdown, inventoryHtml, inventoryCsv } = require('../src/pro/inventory');

const A = [
  'VERSION "1"', '', 'BU_: N1 N2', '',
  'BO_ 256 Engine: 8 N1',
  ' SG_ Speed : 0|16@1+ (0.25,0) [0|8000] "rpm" N2',
  ' SG_ Temp : 16|8@1+ (1,-40) [-40|150] "degC" N2',
  '',
  'BO_ 512 Brake: 8 N2',
  ' SG_ Press : 0|12@1+ (0.1,0) [0|250] "bar" N1',
  ''
].join('\n');

const B = ['VERSION "2"', '', 'BU_: N2 N3', '', 'BO_ 256 Gear: 4 N3', ' SG_ Gear : 0|4@1+ (1,0) [0|7] "" N2', ''].join('\n');

const C = [
  'VERSION "3"', '', 'BU_: N1 N2', '',
  'BO_ 256 Engine: 4 N1',
  ' SG_ Speed : 8|16@1+ (0.5,0) [0|8000] "rpm" N2',
  ' SG_ Extra : 24|8@1+ (1,0) [0|255] "" N2',
  ''
].join('\n');

const D = ['VERSION "4"', '', 'BU_: N1', '', 'BO_ 768 Engine: 8 N1', ' SG_ Speed : 0|16@1+ (0.25,0) [0|8000] "rpm" N1', ''].join('\n');

const TAGS = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'main', 'h1', 'h2', 'h3', 'p', 'ul', 'li', 'table', 'caption', 'thead', 'tbody', 'tr', 'th', 'td']);

function tagsOf(html) {
  const found = new Set();
  for (const m of html.replace(/<style>[\s\S]*?<\/style>/, '').matchAll(/<\/?([A-Za-z][A-Za-z0-9]*)/g)) found.add(m[1].toLowerCase());
  return found;
}

function bigFile(i, changeFactorOfMsg3) {
  const out = ['VERSION "' + i + '"', '', 'BU_: Node' + (i % 7) + ' Shared', ''];
  for (let m = 0; m < 20; m++) {
    out.push('BO_ ' + (256 + m) + ' Msg' + m + ': 8 Shared');
    for (let k = 0; k < 4; k++) out.push(' SG_ Sig' + m + '_' + k + ' : ' + (k * 16) + '|16@1+ (' + (changeFactorOfMsg3 && m === 3 && k === 1 ? '0.5' : '0.1') + ',0) [0|6553.5] "V" Shared');
    out.push('');
  }
  return out.join('\n');
}

test('files: counts, version, size and problem totals of each file', () => {
  const r = inventoryFiles([{ name: 'a.dbc', text: A }, { name: 'sub/b.dbc', text: B }]);
  assert.equal(r.files.length, 2);
  assert.deepEqual(r.files[0], { name: 'a.dbc', version: '1', messages: 2, signals: 3, nodes: 2, errors: 0, warnings: 0, bytes: Buffer.byteLength(A) });
  assert.deepEqual(r.files[1], { name: 'sub/b.dbc', version: '2', messages: 1, signals: 1, nodes: 2, errors: 0, warnings: 0, bytes: Buffer.byteLength(B) });
  assert.equal(r.totals.files, 2);
  assert.equal(r.totals.messages, 3);
  assert.equal(r.totals.signals, 4);
  assert.equal(r.totals.bytes, Buffer.byteLength(A) + Buffer.byteLength(B));
});

test('files: problems of a file are counted but do not stop the inventory', () => {
  const bad = 'VERSION ""\nBU_: N\nBO_ 1 M: 8 N\n SG_ A : 0|8@1+ (1,0) [9|1] "" N\n SG_ B : 4|8@1+ (1,0) [0|1] "" Zed\n';
  const r = inventoryFiles([{ name: 'bad.dbc', text: bad }, { name: 'a.dbc', text: A }]);
  assert.equal(r.files[0].errors, 2);
  assert.equal(r.files[0].warnings, 1);
  assert.equal(r.totals.errors, 2);
  assert.equal(r.totals.warnings, 1);
  assert.equal(r.files[1].errors, 0);
});

test('files: disabled problem codes are not counted', () => {
  const bad = 'VERSION ""\nBU_: N\nBO_ 1 M: 8 N\n SG_ A : 0|8@1+ (1,0) [9|1] "" N\n';
  const r = inventoryFiles([{ name: 'bad.dbc', text: bad }], { disabledCodes: ['DBC-RANGE-INVERTED'] });
  assert.equal(r.files[0].errors, 0);
});

test('files: empty, binary and non-string text give a row with zeros', () => {
  const r = inventoryFiles([{ name: 'empty.dbc', text: '' }, { name: 'bin.dbc', text: '\u0000\u0001\u0002 not a database' }, { name: 'missing.dbc' }, { name: 'num.dbc', text: 42 }]);
  assert.equal(r.files.length, 4);
  for (const f of r.files) { assert.equal(f.messages, 0); assert.equal(f.signals, 0); }
  assert.deepEqual(r.collisions, []);
});

test('id collision: one frame ID carries two message names in two files', () => {
  const r = inventoryFiles([{ name: 'a.dbc', text: A }, { name: 'b.dbc', text: B }]);
  assert.equal(r.collisions.length, 1);
  const c = r.collisions[0];
  assert.equal(c.kind, 'id');
  assert.equal(c.severity, 'error');
  assert.equal(c.key, '0x100 (standard)');
  assert.equal(c.text, 'The ID 0x100 (standard) is used by different messages: Engine in a.dbc, Gear in b.dbc.');
  assert.deepEqual(c.entries, [{ file: 'a.dbc', message: 'Engine', id: '0x100 (standard)' }, { file: 'b.dbc', message: 'Gear', id: '0x100 (standard)' }]);
  assert.equal(r.totals.collisions.id, 1);
});

test('id collision: the same number as a standard and as an extended frame is not a collision', () => {
  const ext = 'VERSION ""\nBU_: N\nBO_ ' + (0x80000000 + 256) + ' Other: 8 N\n SG_ X : 0|8@1+ (1,0) [0|0] "" N\n';
  const r = inventoryFiles([{ name: 'a.dbc', text: A }, { name: 'e.dbc', text: ext }]);
  assert.deepEqual(r.collisions, []);
});

test('name collision: one message name with different IDs in different files', () => {
  const r = inventoryFiles([{ name: 'a.dbc', text: A }, { name: 'd.dbc', text: D }]);
  assert.equal(r.collisions.length, 1);
  const c = r.collisions[0];
  assert.equal(c.kind, 'name');
  assert.equal(c.severity, 'warning');
  assert.equal(c.key, 'Engine');
  assert.equal(c.text, 'The message name Engine has different IDs: 0x100 (standard) in a.dbc, 0x300 (standard) in d.dbc.');
});

test('layout difference: same ID and name, different length and signals', () => {
  const r = inventoryFiles([{ name: 'a.dbc', text: A }, { name: 'c.dbc', text: C }]);
  assert.equal(r.collisions.length, 1);
  const c = r.collisions[0];
  assert.equal(c.kind, 'signal-layout');
  assert.equal(c.severity, 'warning');
  assert.equal(c.text, 'The message Engine (0x100 (standard)) is defined differently in a.dbc, c.dbc: 4 differences compared with a.dbc.');
  assert.deepEqual(c.differences, [
    { signal: '(data length)', file: 'c.dbc', kind: 'changed', detail: '8 -> 4 bytes' },
    { signal: 'Speed', file: 'c.dbc', kind: 'changed', detail: 'start bit 0 -> 8; factor 0.25 -> 0.5' },
    { signal: 'Temp', file: 'c.dbc', kind: 'missing', detail: 'only in a.dbc' },
    { signal: 'Extra', file: 'c.dbc', kind: 'added', detail: 'only in c.dbc' }
  ]);
  assert.equal(c.moreDifferences, 0);
});

test('layout difference: equal factors written differently are the same', () => {
  const same = A.replace('(0.25,0)', '(0.250,0.0)').replace('[0|8000]', '[0|8000.0]');
  assert.deepEqual(inventoryFiles([{ name: 'a.dbc', text: A }, { name: 'a2.dbc', text: same }]).collisions, []);
});

test('no collision: identical files, the same file twice, and a message that appears once', () => {
  assert.deepEqual(inventoryFiles([{ name: 'a.dbc', text: A }, { name: 'copy.dbc', text: A }]).collisions, []);
  assert.deepEqual(inventoryFiles([{ name: 'a.dbc', text: A }]).collisions, []);
});

test('a duplicate inside one file is not a collision between files', () => {
  const dup = 'VERSION ""\nBU_: N\nBO_ 5 One: 8 N\nBO_ 5 Two: 8 N\nBO_ 6 One: 8 N\n';
  assert.deepEqual(inventoryFiles([{ name: 'dup.dbc', text: dup }]).collisions, []);
});

test('nodes: names defined in several files are listed with their file count', () => {
  const r = inventoryFiles([{ name: 'a.dbc', text: A }, { name: 'b.dbc', text: B }, { name: 'd.dbc', text: D }]);
  assert.deepEqual(r.nodes, [{ name: 'N1', files: 2 }, { name: 'N2', files: 2 }]);
  assert.equal(r.totals.sharedNodes, 2);
});

test('collisions are ordered: ID first, then names, then layouts', () => {
  const r = inventoryFiles([{ name: 'a.dbc', text: A }, { name: 'b.dbc', text: B }, { name: 'c.dbc', text: C }, { name: 'd.dbc', text: D }]);
  assert.deepEqual(r.collisions.map((c) => c.kind), ['id', 'name', 'signal-layout']);
  const only = inventoryFiles([{ name: 'a.dbc', text: A }, { name: 'c.dbc', text: C }, { name: 'd.dbc', text: D }]);
  assert.deepEqual(only.collisions.map((c) => c.kind), ['name', 'signal-layout']);
});

test('the number of collisions kept can be limited; the totals still count all', () => {
  const files = [];
  for (let i = 0; i < 30; i++) files.push({ name: 'f' + i + '.dbc', text: 'VERSION ""\nBU_: N\nBO_ ' + (i + 1) + ' Name' + (i % 2) + ': 8 N\nBO_ ' + (i + 1) + ' Same' + i + ': 8 N\n' });
  const mixed = inventoryFiles([{ name: 'x.dbc', text: files.map((f) => f.text).join('') }].concat(files.map((f, i) => ({ name: 'y' + i + '.dbc', text: 'VERSION ""\nBU_: N\nBO_ ' + (i + 1) + ' Other' + i + ': 8 N\n' }))), { maxCollisions: 5 });
  assert.ok(mixed.collisions.length <= 5);
  assert.equal(mixed.cut, true);
  assert.ok(mixed.totals.collisions.id > 5);
});

test('markdown: summary, file table, collisions and shared nodes', () => {
  const r = inventoryFiles([{ name: 'a.dbc', text: A }, { name: 'b.dbc', text: B }, { name: 'c.dbc', text: C }]);
  const md = inventoryMarkdown(r, { name: 'my folder' });
  assert.ok(md.startsWith('# DBC inventory: my folder\n'));
  assert.ok(md.includes('3 files, 4 messages, 6 signals. In the files: 0 errors and 0 warnings. Between the files: 2 collisions \\(1 ID, 0 name, 1 layout\\).'));
  assert.ok(md.includes('| a.dbc | 1 | 2 | 3 | 2 | 0 | 0 | ' + Buffer.byteLength(A) + ' |'));
  assert.ok(md.includes('### ID collisions (error)'));
  assert.ok(md.includes('- The ID 0x100 \\(standard\\) is used by different messages: Engine in a.dbc, Gear in b.dbc, Engine in c.dbc.'));
  assert.ok(md.includes('### Layout differences (warning)'));
  assert.ok(md.includes('  - Temp \\(c.dbc\\): missing, only in a.dbc'));
  assert.ok(!/\n\n\n/.test(md));
  assert.ok(md.includes('| N2 | 3 |'));
});

test('markdown: a clean inventory says so', () => {
  const md = inventoryMarkdown(inventoryFiles([{ name: 'a.dbc', text: A }]), {});
  assert.ok(md.includes('# DBC inventory: workspace'));
  assert.ok(md.includes('No ID, name or layout collision between the files.'));
  assert.ok(md.includes('No node name is defined in more than one file.'));
});

test('html: complete document, strict policy, no script, hostile names escaped', () => {
  const evil = '<img src=x onerror=alert(1)>"\'.dbc';
  const r = inventoryFiles([{ name: evil, text: A.replace('VERSION "1"', 'VERSION "<script>alert(1)</script>"') }, { name: 'b.dbc', text: B }]);
  const html = inventoryHtml(r, { name: '"><script>x</script>' });
  assert.ok(html.startsWith('<!DOCTYPE html>\n<html lang="en">'));
  assert.ok(html.includes('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'));
  assert.ok(!/<script/i.test(html));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;.dbc'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('<title>DBC inventory: &quot;&gt;&lt;script&gt;x&lt;/script&gt;</title>'));
  for (const t of tagsOf(html)) assert.ok(TAGS.has(t), t);
  assert.ok(!/\son[a-z]+\s*=/i.test(html.replace(/&lt;[^&]*&gt;/g, '')));
  assert.ok(html.includes('<th scope="col">Warnings</th>'));
  assert.ok(html.includes('<li>The ID 0x100 (standard) is used by different messages: Engine in &lt;img'));
});

test('csv: the file table is exact and every cell count is stable', () => {
  const r = inventoryFiles([{ name: 'a.dbc', text: A }, { name: 'we,ird "name".dbc', text: B }]);
  const csv = inventoryCsv(r, {});
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'file,version,messages,signals,nodes,errors,warnings,bytes');
  assert.equal(lines[1], 'a.dbc,1,2,3,2,0,0,' + Buffer.byteLength(A));
  assert.equal(lines[2], '"we,ird ""name"".dbc",2,1,1,2,0,0,' + Buffer.byteLength(B));
  for (const row of U.parseCsv(csv).rows) assert.equal(row.length, 8);
});

test('csv: the collision table lists entries and differences', () => {
  const r = inventoryFiles([{ name: 'a.dbc', text: A }, { name: 'b.dbc', text: B }, { name: 'c.dbc', text: C }]);
  const csv = inventoryCsv(r, {}, { table: 'collisions' });
  const lines = csv.split('\r\n').filter(Boolean);
  assert.equal(lines[0], 'kind,severity,key,file,message,id,signal,change,detail');
  assert.equal(lines[1], 'id,error,0x100 (standard),a.dbc,Engine,0x100 (standard),,,');
  assert.ok(lines.includes('signal-layout,warning,0x100 (standard) Engine,c.dbc,,,Temp,missing,only in a.dbc'));
  assert.ok(lines.includes('signal-layout,warning,0x100 (standard) Engine,c.dbc,,,Speed,changed,start bit 0 -> 8; factor 0.25 -> 0.5'));
  assert.ok(lines.includes('signal-layout,warning,0x100 (standard) Engine,a.dbc,Engine,0x100 (standard),,,'));
  for (const row of U.parseCsv(csv).rows) assert.equal(row.length, 9);
});

test('csv: file names that look like formulas are neutralised, with an opt-out', () => {
  const r = inventoryFiles([{ name: '=cmd|\' /C calc\'!A0.dbc', text: A }, { name: '+1-2.dbc', text: B }, { name: '@SUM(1).dbc', text: D }, { name: '-5.dbc', text: C }]);
  const rows = U.parseCsv(inventoryCsv(r, {})).rows;
  assert.equal(rows[1][0], '\'=cmd|\' /C calc\'!A0.dbc');
  assert.equal(rows[2][0], '\'+1-2.dbc');
  assert.equal(rows[3][0], '\'@SUM(1).dbc');
  assert.equal(rows[4][0], '\'-5.dbc');
  for (const row of rows.slice(1)) for (const cell of row) assert.ok(!/^[=+\-@\t\r]/.test(cell) || /^-?\d+(\.\d+)?$/.test(cell), cell);
  const raw = U.parseCsv(inventoryCsv(r, {}, { neutralise: false })).rows;
  assert.equal(raw[1][0], '=cmd|\' /C calc\'!A0.dbc');
  const collisions = U.parseCsv(inventoryCsv(r, {}, { table: 'collisions' })).rows;
  for (const row of collisions.slice(1)) for (const cell of row) assert.ok(!/^[=+\-@\t\r]/.test(cell) || /^-?\d+(\.\d+)?$/.test(cell), cell);
});

test('1,000 files of 20 messages are read in under 5 seconds; one changed factor is the only collision', () => {
  const files = [];
  for (let i = 0; i < 1000; i++) files.push({ name: 'ecu/' + i + '.dbc', text: bigFile(i, i === 777) });
  const t = Date.now();
  const r = inventoryFiles(files);
  const ms = Date.now() - t;
  assert.ok(ms < 5000, ms + ' ms');
  assert.equal(r.totals.files, 1000);
  assert.equal(r.totals.messages, 20000);
  assert.equal(r.totals.signals, 80000);
  assert.equal(r.collisions.length, 1);
  assert.equal(r.collisions[0].kind, 'signal-layout');
  assert.deepEqual(r.collisions[0].differences, [{ signal: 'Sig3_1', file: 'ecu/777.dbc', kind: 'changed', detail: 'factor 0.1 -> 0.5' }]);
  const t2 = Date.now();
  const md = inventoryMarkdown(r, { name: 'big' });
  const html = inventoryHtml(r, { name: 'big' });
  const csv = inventoryCsv(r, { name: 'big' });
  assert.ok(Date.now() - t2 < 5000);
  assert.ok(md.includes('and 0 more files') === false);
  assert.ok(html.length > 0 && csv.length > 0);
});

test('reports shorten very long file lists and say so', () => {
  const files = [];
  for (let i = 0; i < 30; i++) files.push({ name: 'f' + i + '.dbc', text: 'VERSION ""\nBU_: N\nBO_ ' + (i + 1) + ' M' + i + ': 8 N\n' });
  const r = inventoryFiles(files);
  const md = inventoryMarkdown(r, {}, { maxRows: 10 });
  assert.ok(md.includes('and 20 more files.'));
  assert.ok(inventoryHtml(r, {}, { maxRows: 10 }).includes('and 20 more files.'));
});
