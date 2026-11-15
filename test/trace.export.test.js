'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseDbc } = require('../src/dbc/parse');
const U = require('../src/util');
const X = require('../src/trace/export');
const V = require('../src/trace/view');
const { decodeTrace } = require('../src/trace/run');
const H = require('./helpers/trace-util');

const HOSTILE_DBC = [
  'VERSION ""', '', 'NS_ :', '', 'BS_:', '', 'BU_: N', '',
  'BO_ 100 =cmd+1: 8 N',
  ' SG_ -2+3 : 0|8@1+ (1,0) [0|0] "=1+1" N',
  ' SG_ <i>b</i> : 8|8@1+ (1,0) [0|0] "<script>alert(1)</script>" N',
  ' SG_ plain : 16|8@1- (1,0) [0|0] "" N',
  '',
  'VAL_ 100 plain -1 "+cmd|x" 0 "@a,b" 1 "line \\"quoted\\"" ;',
  ''
].join('\n');
const HOSTILE_TRACE = '(1.0) can0 064#010200\n(2.0) "can,1" 064#010201\n(3.0) can2 064#0102FF\n(4.0) can0 064#0102FF\n';

async function hostileResult(options) {
  return decodeTrace({ kind: 'text', text: HOSTILE_TRACE }, parseDbc(HOSTILE_DBC), options || {});
}

async function sampleResult() {
  return decodeTrace({ kind: 'file', path: H.fixturePath('sample-valid.candump.log') }, H.loadSampleDb(), {});
}

const FORMULA = /^[=+\-@\t\r]/;

test('CSV export: header, one line per row, exact decimals, round trip through a CSV reader', async () => {
  const res = await sampleResult();
  const csv = X.rowsToString(res.rows, 'csv');
  const parsed = U.parseCsv(csv);
  assert.equal(parsed.error, '');
  assert.deepEqual(parsed.rows[0], X.COLUMNS);
  assert.equal(parsed.rows.length, 1 + res.rows.length);
  for (let i = 0; i < res.rows.length; i++) {
    const rec = X.recordOf(res.rows[i]);
    assert.deepEqual(parsed.rows[i + 1].map(U.unneutralise), X.COLUMNS.map((c) => rec[c]), 'row ' + i);
  }
  assert.ok(csv.includes('18446744073709551.615'), 'the 64-bit value keeps every digit');
  assert.ok(csv.endsWith('\r\n'));
  const first = parsed.rows[1];
  assert.deepEqual(first, ['1762944000.000000', 'can0', 'EngineStatus', '0x100', 'EngineSpeed', '8000', '2000', 'rpm', '']);
});

test('JSON export: one valid array, an element per row, valid also when empty', async () => {
  const res = await sampleResult();
  const json = X.rowsToString(res.rows, 'json');
  assert.deepEqual(JSON.parse(json), res.rows.map(X.recordOf));
  assert.deepEqual(JSON.parse(X.rowsToString([], 'json')), []);
  assert.equal(X.rowsToString([], 'json'), '[]\n');
  const one = X.rowsToString(res.rows.slice(0, 1), 'json');
  assert.deepEqual(JSON.parse(one), [X.recordOf(res.rows[0])]);
  const csvEmpty = X.rowsToString([], 'csv');
  assert.equal(U.parseCsv(csvEmpty).rows.length, 1);
});

test('CSV export neutralises cells a spreadsheet could run, keeps plain numbers, and the setting can turn it off', async () => {
  const res = await hostileResult();
  assert.equal(res.rows.length, 12);
  const csv = X.rowsToString(res.rows, 'csv');
  const cells = U.parseCsv(csv).rows;
  assert.equal(cells.length, 13);
  for (const row of cells.slice(1)) for (const cell of row) {
    assert.ok(!FORMULA.test(cell) || U.PLAIN_NUMBER.test(cell) && /^-?\d+(\.\d+)?$/.test(cell), 'cell starts like a formula: ' + JSON.stringify(cell));
  }
  assert.ok(cells.slice(1).some((r) => r[2] === '\'=cmd+1'));
  assert.ok(cells.slice(1).some((r) => r[4] === '\'-2+3'));
  assert.ok(cells.slice(1).some((r) => r[7] === '\'=1+1'));
  assert.ok(cells.slice(1).some((r) => r[8] === '\'+cmd|x'));
  assert.ok(cells.slice(1).some((r) => r[8] === '\'@a,b'));
  assert.ok(cells.slice(1).some((r) => r[1] === '"can,1"'), 'an interface name with a comma and quotes is quoted correctly');
  assert.ok(cells.slice(1).some((r) => r[8] === 'line "quoted"'));
  assert.ok(cells.slice(1).some((r) => r[5] === '-1' && r[6] === '-1'), 'plain negative numbers stay numbers');
  // Removing the one apostrophe gives the original text back.
  for (let i = 0; i < res.rows.length; i++) assert.deepEqual(cells[i + 1].map(U.unneutralise), X.COLUMNS.map((c) => X.recordOf(res.rows[i])[c]));
  // With the setting off the cells are the exact values.
  const plain = U.parseCsv(X.rowsToString(res.rows, 'csv', { neutralise: false })).rows;
  assert.ok(plain.slice(1).some((r) => r[2] === '=cmd+1'));
  assert.ok(plain.slice(1).some((r) => r[8] === '+cmd|x'));
});

test('JSON export keeps hostile text as plain data', async () => {
  const res = await hostileResult();
  const back = JSON.parse(X.rowsToString(res.rows, 'json'));
  assert.deepEqual(back, res.rows.map(X.recordOf));
  assert.ok(back.some((r) => r.unit === '<script>alert(1)</script>'));
});

test('streaming writers produce the same text as the one-piece helper, in any piece size', async () => {
  const res = await sampleResult();
  for (const format of ['csv', 'json']) {
    const pieces = [];
    const w = format === 'csv' ? X.createCsvWriter((s) => pieces.push(s)) : X.createJsonWriter((s) => pieces.push(s));
    w.begin();
    for (const r of res.rows) w.row(r);
    w.end();
    assert.equal(pieces.join(''), X.rowsToString(res.rows, format));
  }
});

test('exporting while decoding: the sink streams every row to a file without keeping the rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can atlas export ü '));
  try {
    const target = path.join(dir, 'out ☃.csv');
    const fd = fs.openSync(target, 'w');
    const w = X.createCsvWriter((s) => fs.writeSync(fd, s));
    w.begin();
    const res = await decodeTrace({ kind: 'file', path: H.fixturePath('sample-valid.candump.log') }, H.loadSampleDb(), { maxRows: 0, sink: (r) => w.row(r) });
    w.end();
    fs.closeSync(fd);
    assert.equal(res.rows.length, 0);
    assert.equal(res.totalMatching, 49);
    const parsed = U.parseCsv(fs.readFileSync(target, 'utf8'));
    assert.equal(parsed.rows.length, 50);
    assert.equal(parsed.rows[49][6], '18446744073709551.615');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('statistics reports: Markdown and HTML escape every value, CSV neutralises, all three hold the figures', async () => {
  const res = await hostileResult();
  const meta = { fileName: '<b>trace</b>.log', dbcName: '=evil.dbc', format: res.format, counters: res.counters };
  const md = X.statsMarkdown(res.stats, meta);
  assert.ok(md.startsWith('# Trace statistics\n'));
  assert.ok(!md.includes('<b>'));
  assert.ok(!md.includes('<script>'));
  assert.ok(md.includes('&lt;') || md.includes('\\<'));
  assert.match(md, /\| Message \| ID \| Frames/);
  const html = X.statsHtml(res.stats, meta);
  assert.ok(html.includes('Content-Security-Policy'));
  assert.ok(!/<script/i.test(html));
  assert.ok(!html.includes('<b>trace</b>'));
  assert.ok(html.includes('&lt;b&gt;trace&lt;/b&gt;.log'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!/\son[a-z]+\s*=/i.test(html));
  const mcsv = U.parseCsv(X.statsCsv(res.stats, 'messages')).rows;
  assert.equal(mcsv[0][0], 'Message');
  assert.equal(mcsv[1][0], '\'=cmd+1');
  const scsv = U.parseCsv(X.statsCsv(res.stats, 'signals')).rows;
  assert.ok(scsv.some((r) => r[2] === '\'-2+3'));
  assert.ok(scsv.some((r) => r[3] === '\'=1+1'));
  assert.equal(U.parseCsv(X.statsCsv(res.stats, 'signals', { neutralise: false })).rows[1][2], '-2+3');
  const sample = await sampleResult();
  const smd = X.statsMarkdown(sample.stats, null);
  assert.ok(smd.includes('2006.666667'));
  assert.ok(smd.includes('9264364801463019.255'));
  assert.ok(smd.includes('1 of 2 intervals deviate by more than 50 percent'));
});

// ---- the view ---------------------------------------------------------------------------------
const NONCE = 'dGVzdC1ub25jZS0xMjM0NTY3OA';

test('the view is a complete page with a strict content security policy and one fixed script', async () => {
  const res = await hostileResult();
  const html = V.renderTraceView({ title: 'Trace <1>', summary: res, stats: res.stats, rows: res.rows, filter: { text: '"><img src=x onerror=alert(1)>' }, totalMatching: res.totalMatching, nonce: NONCE, channel: 'can0' });
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<html lang="en">'));
  assert.ok(html.includes('default-src \'none\'; style-src \'nonce-' + NONCE + '\'; script-src \'nonce-' + NONCE + '\''));
  assert.equal((html.match(/<script/g) || []).length, 1, 'only the page script');
  const inner = html.slice(html.indexOf('<script nonce="' + NONCE + '">') + ('<script nonce="' + NONCE + '">').length, html.indexOf('</script>'));
  assert.equal(inner, V.SCRIPT);
  assert.ok(!inner.includes('alert') && !inner.includes('=cmd') && !inner.includes('can0'), 'no value of the data is in the script');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<i>b</i>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!/\son[a-z]+\s*=/i.test(html.replace(V.SCRIPT, '').replace(/="[^"]*"/g, '=""')), 'no inline event handler attribute');
  assert.ok(!/javascript:/i.test(html));
  assert.ok(html.includes('<title>Trace &lt;1&gt;</title>'));
  assert.ok(html.includes('<th scope="col"'));
  assert.ok(html.includes('id="rows"'));
  assert.ok(html.includes('Showing all 12 matching rows.'));
});

test('the view works without scripting: every table and the filter form are plain HTML', async () => {
  const res = await sampleResult();
  const html = V.renderTraceView({ title: 'Decoded trace', summary: res, stats: res.stats, rows: res.rows, totalMatching: res.totalMatching, nonce: NONCE });
  const body = html.replace(/<script[\s\S]*<\/script>/, '');
  assert.equal((body.match(/<table/g) || []).length, 4);
  assert.ok(body.includes('<section id="signals"'));
  assert.ok(body.includes('<section id="statistics"'));
  assert.ok(body.includes('<section id="messages"'));
  assert.ok(body.includes('<a href="#signals">'));
  assert.ok(body.includes('<noscript>'));
  assert.ok(body.includes('2006.666667'));
  assert.ok(body.includes('18446744073709551.615'));
  assert.ok(body.includes('1 of 2 intervals deviate by more than 50 percent'));
  assert.ok(body.includes('0x5A5'), 'the unknown identifier is listed');
  assert.ok(!/<section[^>]* hidden/.test(body), 'nothing is hidden before the script runs');
  assert.ok(html.includes('data-export="csv"') && html.includes('data-export="json"'));
  assert.ok(V.SCRIPT.includes('type:"filter"') && V.SCRIPT.includes('type:"export"'));
});

test('the view says honestly how many rows it shows', async () => {
  const res = await decodeTrace({ kind: 'file', path: H.fixturePath('sample-valid.candump.log') }, H.loadSampleDb(), { maxRows: 5 });
  const html = V.renderTraceView({ title: 'T', summary: res, rows: res.rows, truncated: res.truncated, totalMatching: res.totalMatching, nonce: NONCE });
  assert.ok(html.includes('Showing the first 5 of 49 matching rows.'));
  const limited = V.renderTraceView({ title: 'T', summary: res, rows: res.rows, truncated: res.truncated, totalMatching: res.totalMatching, nonce: NONCE, displayLimit: 2 });
  assert.ok(limited.includes('Showing the first 2 of 49 matching rows.'));
  assert.equal((limited.match(/<tr><td class="num">/g) || []).length, 2);
  const empty = V.renderTraceView({ title: 'T', summary: {}, rows: [], totalMatching: 0, nonce: NONCE });
  assert.ok(empty.includes('Showing all 0 matching rows.'));
  const warn = V.renderTraceView({ title: 'T', summary: { warnings: ['<b>x</b>'] }, rows: [], nonce: NONCE, errors: ['The "from" time is not a number of seconds.'] });
  assert.ok(warn.includes('&lt;b&gt;x&lt;/b&gt;') && warn.includes('The &quot;from&quot; time'));
});

test('the view refuses a nonce that is too short or holds unsafe characters', () => {
  for (const nonce of ['', 'abc', 'a b c d e f g h', 'abcdefgh"onload=', "abcdefgh'", '<script>']) assert.throws(() => V.renderTraceView({ nonce: nonce }), TypeError, nonce);
  assert.throws(() => V.renderTraceView({}), TypeError);
  assert.doesNotThrow(() => V.renderTraceView({ nonce: 'abcdefgh' }));
});

test('the filter form strings become options for the decoder', () => {
  const f = V.normaliseViewFilter({ text: ' speed ', message: 'EngineStatus, GearStatus ,,', from: '1762944000.01', to: '1762944000.5', channel: ' can0 ' });
  assert.deepEqual(f.filter, { text: 'speed', messages: ['EngineStatus', 'GearStatus'], fromUs: 1762944000010000, toUs: 1762944000500000 });
  assert.equal(f.channel, 'can0');
  assert.deepEqual(f.errors, []);
  const empty = V.normaliseViewFilter({});
  assert.deepEqual(empty.filter, { text: '', messages: [] });
  assert.equal(empty.channel, null);
  assert.deepEqual(V.normaliseViewFilter({ from: 'x', to: '1' }).errors, ['The "from" time is not a number of seconds.']);
  assert.deepEqual(V.normaliseViewFilter({ from: '5', to: '1' }).errors, ['The "from" time is after the "to" time.']);
  assert.deepEqual(V.normaliseViewFilter(null).filter, { text: '', messages: [] });
  assert.equal(V.normaliseViewFilter({ text: 'x'.repeat(1000) }).filter.text.length, 200);
});

test('a filter taken from the form decodes the same rows as the same filter written by hand', async () => {
  const f = V.normaliseViewFilter({ text: 'speed', from: '1762944000.0', to: '1762944000.02', channel: 'can0' });
  const viaForm = await decodeTrace({ kind: 'file', path: H.fixturePath('sample-valid.candump.log') }, H.loadSampleDb(), { filter: f.filter, channel: f.channel });
  assert.deepEqual(viaForm.rows.map((r) => r.signalName), ['EngineSpeed', 'VehicleSpeed', 'WheelSpeedLeft', 'WheelSpeedRight', 'EngineSpeed', 'VehicleSpeed']);
});
