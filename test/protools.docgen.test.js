'use strict';
// Tests of the documentation of a DBC database (Markdown and HTML).

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/dbc/parse');
const { sampleFor } = require('../src/samples');
const { documentationMarkdown, documentationHtml } = require('../src/pro/docgen');

const sampleText = sampleFor('valid').text;
const sample = P.parseDbc(sampleText);

const HOSTILE = [
  'VERSION "<script>alert(1)</script>"',
  '',
  'BU_: Nd Other',
  '',
  'VAL_TABLE_ Tbl 1 "<b>x</b> | y" ;',
  '',
  'BO_ 100 Msg: 8 Nd',
  ' SG_ Sig : 0|8@1+ (1,0) [0|0] "=1+1" Nd',
  ' SG_ Other : 8|8@0- (0.5,-10) [0|0] "|`|" Other',
  '',
  'CM_ "File \\"comment\\" <img src=x onerror=alert(1)> | pipe `tick`";',
  'CM_ BO_ 100 "<script>x</script> | ``` [link](http://example.org/x) **bold** # head";',
  'CM_ SG_ 100 Sig "=cmd|\' /C calc\'!A0 @SUM(1) \u202E rlo";',
  'CM_ BU_ Nd "<iframe src=//example.org></iframe>";',
  'VAL_ 100 Sig 1 "<b>on</b> | off" 0 "a`b" ;',
  ''
].join('\n');

const TAGS = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'main', 'h1', 'h2', 'h3', 'p', 'nav', 'ul', 'li', 'a', 'table', 'caption', 'thead', 'tbody', 'tr', 'th', 'td', 'section']);

function tagsOf(html) {
  const found = new Set();
  for (const m of html.replace(/<style>[\s\S]*?<\/style>/, '').matchAll(/<\/?([A-Za-z][A-Za-z0-9]*)/g)) found.add(m[1].toLowerCase());
  return found;
}

function unescapedPipes(line) { return (line.match(/(?<!\\)\|/g) || []).length; }

function tableBlocks(md) {
  const blocks = [];
  let cur = null;
  for (const line of md.split('\n')) {
    if (line.startsWith('|')) { if (!cur) { cur = []; blocks.push(cur); } cur.push(line); } else cur = null;
  }
  return blocks;
}

function manyMessages(count, signalsPer) {
  const lines = ['VERSION "big"', '', 'BU_: A B', ''];
  for (let i = 0; i < count; i++) {
    lines.push('BO_ ' + (i + 1) + ' Message' + i + ': 8 A');
    for (let k = 0; k < signalsPer; k++) lines.push(' SG_ Sig' + i + '_' + k + ' : ' + (k * 16) + '|16@1+ (0.1,0) [0|6553.5] "V" B');
    lines.push('');
  }
  return lines.join('\n');
}

test('markdown: title, counts and the message index of the sample', () => {
  const md = documentationMarkdown(sample, { name: 'sample-vehicle.dbc' });
  assert.ok(md.startsWith('# DBC documentation: sample\\-vehicle.dbc\n'));
  assert.ok(md.includes('| Messages | 8 |'));
  assert.ok(md.includes('| Signals | 30 |'));
  assert.ok(md.includes('| Nodes | 6 |'));
  assert.ok(md.includes('| [0x100](#msg-s100) | 256 | standard | EngineStatus | 8 | EngineUnit | 10 | 6 |'));
  // 0x18FF50E5 = 24 * 16777216 + 16732389 = 419385573, written as 2566869221 (= 2147483648 + 419385573) in the file.
  assert.ok(md.includes('| [0x18FF50E5](#msg-x18ff50e5) | 419385573 | extended | ChargerStatus | 8 | ChargerUnit | 100 | 4 |'));
  assert.ok(md.includes('<a id="msg-x18ff50e5"></a>'));
});

test('markdown: the signal row of EngineSpeed is exact', () => {
  const md = documentationMarkdown(sample, { name: 'x' });
  assert.ok(md.includes('| A | EngineSpeed | 0\\|16 | Intel \\(little\\-endian\\) | unsigned integer | 0.25 | 0 | 0 | 8000 | rpm | Dashboard, Gateway |  |'));
});

test('markdown: a negative offset and a signed value are written with their sign', () => {
  const md = documentationMarkdown(sample, { name: 'x' });
  assert.ok(md.includes('| B | CoolantTemp | 16\\|8 | Intel \\(little\\-endian\\) | unsigned integer | 1 | -40 | -40 | 150 | degC | Dashboard |  |'));
  assert.ok(md.includes('| D | EngineTorque | 32\\|12 | Intel \\(little\\-endian\\) | signed integer \\(two\'s complement\\) | 0.5 | 0 | -1024 | 1023.5 | Nm | GearUnit |  |'));
});

test('markdown: big-endian signals and float signals', () => {
  const md = documentationMarkdown(sample, { name: 'x' });
  assert.ok(md.includes('| C | VehicleSpeed | 15\\|16 | Motorola \\(big\\-endian\\) | unsigned integer | 0.01 | 0 | 0 | 300 | km/h | Dashboard, BrakeUnit, Gateway |  |'));
  assert.ok(md.includes('AmbientPressure | 0\\|32 | Intel \\(little\\-endian\\) | 32\\-bit IEEE float |'));
});

test('markdown: value descriptions of EngineRunning', () => {
  const md = documentationMarkdown(sample, { name: 'x' });
  assert.ok(md.includes('| EngineRunning | 1 | Running |'));
  assert.ok(md.includes('| EngineRunning | 0 | Stopped |'));
});

test('markdown: multiplexed signals state their condition', () => {
  const md = documentationMarkdown(sample, { name: 'x' });
  assert.ok(md.includes('| PageIndex | 0\\|8 |'));
  assert.ok(/\| TripDistance \| 8\\\|24 [^\n]*present when PageIndex = 0 \|/.test(md));
  assert.ok(/\| AverageSpeed \| 8\\\|16 [^\n]*present when PageIndex = 1 \|/.test(md));
  assert.ok(md.includes('| PageIndex | 0\\|8 | Intel'));
});

test('markdown: node table counts what each node sends and receives', () => {
  const md = documentationMarkdown(sample, { name: 'x' });
  // Gateway sends AmbientSensor (768), GatewayHeartbeat (2032) and, through BO_TX_BU_, TripComputer (512).
  const sends = new Map();
  const receives = new Map();
  for (const m of sample.messages) {
    const set = new Set(m.transmitters);
    set.add(m.sender);
    for (const n of set) sends.set(n, (sends.get(n) || 0) + 1);
    for (const s of m.signals) for (const n of new Set(s.receivers)) receives.set(n, (receives.get(n) || 0) + 1);
  }
  assert.equal(sends.get('Gateway'), 3);
  for (const n of ['EngineUnit', 'GearUnit', 'BrakeUnit', 'Dashboard', 'Gateway', 'ChargerUnit']) {
    assert.ok(md.includes('| ' + n + ' | ' + (sends.get(n) || 0) + ' | ' + (receives.get(n) || 0) + ' |'), n);
  }
  assert.ok(md.includes('| Gateway | 3 | 19 | Connects the powertrain bus with the body bus. |'));
});

test('markdown: bit layout of a message with a known layout', () => {
  const db = P.parseDbc('VERSION ""\nBU_: N\nBO_ 1 M: 3 N\n SG_ Speed : 4|12@1+ (1,0) [0|0] "" N\n');
  const md = documentationMarkdown(db, { name: 'x' });
  assert.ok(md.includes('| 0 | A | A | A | A ▼ | · | · | · | · |'));
  assert.ok(md.includes('| 1 | A ▲ | A | A | A | A | A | A | A |'));
  assert.ok(md.includes('| 2 | · | · | · | · | · | · | · | · |'));
});

test('markdown: a multiplexed message shows one layout per combination', () => {
  const md = documentationMarkdown(sample, { name: 'x' });
  assert.ok(md.includes('PageIndex = 0'));
  assert.ok(md.includes('PageIndex = 2'));
  assert.ok(md.includes('Signals present in every frame'));
});

test('markdown: value tables, attribute definitions and database attributes', () => {
  const md = documentationMarkdown(sample, { name: 'x' });
  assert.ok(md.includes('### GearPosition'));
  assert.ok(md.includes('| 7 | Invalid |'));
  assert.ok(md.includes('| BO\\_ | GenMsgCycleTime | INT | 0 to 65535 | 0 |'));
  assert.ok(md.includes('| BO\\_ | VFrameFormat | ENUM | StandardCAN, ExtendedCAN, reserved, J1939PG | "StandardCAN" |'));
  assert.ok(md.includes('| BusType | "CAN" |'));
});

test('markdown: the same database gives the same text', () => {
  assert.equal(documentationMarkdown(sample, { name: 'a' }), documentationMarkdown(P.parseDbc(sampleText), { name: 'a' }));
});

test('markdown: an empty database says so', () => {
  const md = documentationMarkdown(P.parseDbc(''), { name: 'empty.dbc' });
  assert.ok(md.includes('The file defines no messages.'));
  assert.ok(md.includes('The file lists no nodes.'));
  assert.ok(md.includes('The file defines no value tables.'));
  assert.ok(md.includes('The file defines no attributes.'));
});

test('markdown: hostile text is escaped and every table row keeps its cell count', () => {
  const md = documentationMarkdown(P.parseDbc(HOSTILE), { name: '<script>x</script>|`.dbc' });
  assert.ok(!/<script/i.test(md.replace(/\\</g, '')));
  const bare = md.replace(/\\</g, '');
  assert.ok(!bare.includes('<img'));
  assert.ok(!bare.includes('<iframe'));
  assert.ok(!md.includes('[link]('), 'a live link would start with [link](');
  assert.ok(md.includes('\\[link\\]\\(http://example.org/x\\)'));
  assert.ok(md.includes('\\*\\*bold\\*\\*'));
  for (const block of tableBlocks(md)) {
    const n = unescapedPipes(block[0]);
    for (const line of block) assert.equal(unescapedPipes(line), n, line);
  }
  // The only raw HTML in the text is the anchor made from the ID.
  const raw = md.replace(/\\</g, '\u0000').match(/<[^>\n]*>/g) || [];
  assert.ok(raw.length >= 1);
  for (const t of raw) assert.ok(/^<a id="msg-[a-z0-9-]+">$/.test(t) || t === '</a>', t);
});

test('html: a complete document with language, strict policy and no script', () => {
  const html = documentationHtml(sample, { name: 'sample-vehicle.dbc' });
  assert.ok(html.startsWith('<!DOCTYPE html>\n<html lang="en">'));
  assert.ok(html.includes('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'));
  assert.ok(!/<script/i.test(html));
  assert.ok(!/\son[a-z]+\s*=/i.test(html));
  assert.ok(!/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(html.replace(/<style>[\s\S]*?<\/style>/, '')), 'no external address');
  for (const t of tagsOf(html)) assert.ok(TAGS.has(t), t);
  assert.ok(html.includes('<title>DBC documentation: sample-vehicle.dbc</title>'));
});

test('html: every link points at an id that exists, ids are unique', () => {
  const html = documentationHtml(sample, { name: 'x' });
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 14);
  for (const h of hrefs) assert.ok(ids.includes(h), h);
  assert.ok(ids.includes('msg-s100'));
  assert.ok(ids.includes('msg-x18ff50e5'));
});

test('html: tables have captions and column headers; the signal row of EngineSpeed is exact', () => {
  const html = documentationHtml(sample, { name: 'x' });
  assert.ok(html.includes('<caption>Signals of EngineStatus</caption>'));
  assert.ok(html.includes('<th scope="col">Factor</th>'));
  assert.ok(html.includes('<tr><td>A</td><td>EngineSpeed</td><td>0|16</td><td>Intel (little-endian)</td><td>unsigned integer</td><td>0.25</td><td>0</td><td>0</td><td>8000</td><td>rpm</td><td>Dashboard, Gateway</td><td></td></tr>'));
  assert.ok(html.includes('<th scope="row">0</th>'));
});

test('html: hostile text is escaped, no unexpected tag or attribute appears', () => {
  const html = documentationHtml(P.parseDbc(HOSTILE), { name: '"><script>alert(1)</script>' });
  assert.ok(!/<script/i.test(html));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<iframe'));
  assert.ok(!html.includes('<b>on</b>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('<title>DBC documentation: &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>'));
  for (const t of tagsOf(html)) assert.ok(TAGS.has(t), t);
  assert.ok(!/\son[a-z]+\s*=/i.test(html.replace(/&lt;[^&]*&gt;/g, '')));
  assert.ok(!/javascript:/i.test(html));
});

test('anchors come from the ID and stay unique when an ID is used twice', () => {
  const db = P.parseDbc('VERSION ""\nBU_: N\nBO_ 5 One: 8 N\nBO_ 5 Two: 8 N\nBO_ 2147483653 Three: 8 N\n');
  const html = documentationHtml(db, { name: 'x' });
  const ids = [...html.matchAll(/\sid="(msg-[^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.includes('msg-s5'));
  assert.ok(ids.includes('msg-x5'));
});

test('bit layout can be switched off and is left out for very large databases', () => {
  const small = documentationMarkdown(sample, { name: 'x', bitLayout: false });
  assert.ok(!small.includes('**Bit layout**'));
  assert.ok(documentationMarkdown(sample, { name: 'x' }).includes('**Bit layout**'));
  const big = P.parseDbc(manyMessages(2001, 1));
  assert.ok(!documentationMarkdown(big, { name: 'big' }).includes('**Bit layout**'));
  assert.ok(documentationMarkdown(big, { name: 'big', bitLayout: true }).includes('**Bit layout**'));
});

test('10,000 messages are documented in under 5 seconds each way', () => {
  const db = P.parseDbc(manyMessages(10000, 3));
  let t = Date.now();
  const md = documentationMarkdown(db, { name: 'big.dbc' });
  const mdMs = Date.now() - t;
  t = Date.now();
  const html = documentationHtml(db, { name: 'big.dbc' });
  const htmlMs = Date.now() - t;
  assert.ok(md.includes('| Messages | 10000 |'));
  assert.ok(html.includes('id="msg-s2710"'));
  assert.ok(mdMs < 5000, 'markdown took ' + mdMs + ' ms');
  assert.ok(htmlMs < 5000, 'html took ' + htmlMs + ' ms');
});

test('a message without signals and a signal without a message do not break the document', () => {
  const db = P.parseDbc('VERSION ""\nBU_: N\nBO_ 1 Empty: 8 N\nBO_ 3221225472 VECTOR__INDEPENDENT_SIG_MSG: 0 Vector__XXX\n SG_ Loose : 0|8@1+ (1,0) [0|0] "" N\n');
  const md = documentationMarkdown(db, { name: 'x' });
  assert.ok(md.includes('The message has no signals.'));
  assert.ok(md.includes('| Signals without a message | 1 |'));
  const html = documentationHtml(db, { name: 'x' });
  assert.ok(html.includes('<p>The message has no signals.</p>'));
});
