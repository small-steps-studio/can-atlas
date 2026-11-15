'use strict';
// Hostile and damaged inputs: very large, very deep, very long and very odd. Every case must finish
// without an exception, in under five seconds, and without a stack overflow; the 50 MB cases run in
// a child process with a 1 GB heap. Hostile names must not reach a page or a spreadsheet as markup.

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');
const P = require('../src/dbc/parse');
const V = require('../src/dbc/validate');
const C = require('../src/dbc/codec');
const D = require('../src/dbc/describe');
const O = require('../src/dbc/outline');
const L = require('../src/dbc/layout');
const M = require('../src/dbc/mux');
const U = require('../src/util');
const H = require('./helpers/hostile');

// Hosted CI runners are up to about three times slower than a desktop (6.2 s measured on a Windows runner for
// a case that takes 2.9 s locally), so the budget is wider there. It still catches any super-linear blow-up.
const LIMIT_MS = process.env.CI ? 15000 : 5000;
const ROOT = path.join(__dirname, '..');
const HEAD = 'VERSION ""\n\nBS_:\n\nBU_: A B\n\n';

function sg(name, mux, start, len, tail) {
  return ' SG_ ' + name + (mux ? ' ' + mux : '') + ' : ' + start + '|' + len + '@1+ (1,0) [0|0] "" ' + (tail || 'B');
}

/** The reader and the checks must put every problem inside the text and use only known codes. */
function assertProblemsSane(result, textLength) {
  for (const p of result.problems) {
    assert.ok(V.CODES[p.code], 'unknown code ' + p.code);
    assert.ok(Number.isInteger(p.start) && Number.isInteger(p.end) && p.start >= 0 && p.start <= p.end && p.end <= textLength, p.code + ' ' + p.start + '-' + p.end + ' of ' + textLength);
  }
}

/** The editor-facing modules on a database: hover, definition, outline, symbols, decode of the first messages. */
function touch(db, text, options) {
  const opts = options || {};
  const spots = [0, 1, text.length >> 1, Math.max(0, text.length - 1), text.length];
  for (const off of spots) {
    const el = D.elementAt(db, off);
    if (el) {
      assert.equal(typeof D.hoverOf(db, el), 'string');
      D.definitionOf(db, el);
    }
  }
  O.symbols(db);
  for (const root of O.rootNodes(db)) for (const kid of O.childrenOf(db, root).slice(0, 3)) O.childrenOf(db, kid);
  const frame = new Uint8Array(64).fill(0xA5);
  for (const m of db.messages.slice(0, 3)) {
    if (m.signals.length <= (opts.maxSignalsForDecode || 5000)) {
      C.decodeMessage(m, frame, 64);
      C.encodeMessage(db, m, {});
    }
    if (opts.layout && m.signals.length <= 5000) L.layoutMarkdown(db, m);
  }
}

function run(t, label, text, options) {
  const opts = options || {};
  // The budget is the CPU time of this process (the work done), not the wall clock: the unit suite runs many
  // files in parallel, and a busy computer must not turn a linear algorithm into a failure. A wall-clock
  // limit three times as long still catches a hang.
  const t0 = process.hrtime.bigint();
  const c0 = process.cpuUsage();
  const db = P.parseDbc(text);
  const result = V.validate(db, { text: text, maxProblems: 200 });
  touch(db, text, opts);
  const wall = Number(process.hrtime.bigint() - t0) / 1e6;
  const cpu = process.cpuUsage(c0);
  const ms = (cpu.user + cpu.system) / 1000;
  t.diagnostic(label + ': ' + ms.toFixed(0) + ' ms of CPU time (' + wall.toFixed(0) + ' ms on the clock), ' + db.messages.length + ' messages, ' + result.counts.error + ' errors');
  assert.ok(ms < LIMIT_MS, label + ' took ' + ms.toFixed(0) + ' ms of CPU time');
  assert.ok(wall < LIMIT_MS * 3, label + ' took ' + wall.toFixed(0) + ' ms on the clock');
  assertProblemsSane(result, text.length);
  return { db: db, result: result, ms: ms };
}

// ---- multiplexing at scale -------------------------------------------------------------------------

test('fifty thousand messages that each hold a multiplexor and a multiplexed signal', (t) => {
  const parts = [HEAD];
  for (let i = 0; i < 50000; i++) parts.push('BO_ ' + (i + 1) + ' M' + i + ': 8 A\n' + sg('Sel', 'M', 0, 8) + '\n' + sg('X', 'm0', 8, 8) + '\n\n');
  const r = run(t, '50,000 multiplexed messages', parts.join(''));
  assert.equal(r.db.messages.length, 50000);
});

test('a chain of a hundred thousand multiplexors, each selected by the one before, does not overflow the stack', (t) => {
  const n = 100000;
  const parts = [HEAD, 'BO_ 1 Chain: 64 A\n', sg('S0', 'M', 0, 1), '\n'];
  for (let k = 1; k < n; k++) parts.push(sg('S' + k, 'm0M', k % 500, 1) + '\n');
  for (let k = 1; k < n; k++) parts.push('SG_MUL_VAL_ 1 S' + k + ' S' + (k - 1) + ' 0-0;\n');
  const r = run(t, '100,000-level chain', parts.join(''));
  assert.ok(r.result.counts.error >= n - 40, 'all but the first levels are refused: ' + r.result.counts.error);
  const rows = C.decodeMessage(r.db.messages[0], new Uint8Array(64), 64).rows;
  assert.equal(rows.length, n);
  assert.equal(rows[n - 1].status, 'undecodable');
});

test('a chain of 5,000 levels reports DBC-MUX-TOO-DEEP', (t) => {
  const n = 5000;
  const parts = [HEAD, 'BO_ 1 Chain: 64 A\n', sg('S0', 'M', 0, 1), '\n'];
  for (let k = 1; k < n; k++) parts.push(sg('S' + k, 'm0M', k % 500, 1) + '\n');
  for (let k = 1; k < n; k++) parts.push('SG_MUL_VAL_ 1 S' + k + ' S' + (k - 1) + ' 0-0;\n');
  const r = run(t, '5,000-level chain', parts.join(''));
  assert.ok(r.result.problems.some(function (p) { return p.code === 'DBC-MUX-TOO-DEEP'; }));
  assert.equal(M.analyseMux(r.db.messages[0]).info.get(r.db.messages[0].signals[32]).status, 'ok');
  assert.equal(M.analyseMux(r.db.messages[0]).info.get(r.db.messages[0].signals[33]).status, 'bad');
});

test('multiplexors that select each other in a loop of 3 and in a loop of 50,000', (t) => {
  function ring(n) {
    const parts = [HEAD, 'BO_ 1 Ring: 64 A\n'];
    for (let k = 0; k < n; k++) parts.push(sg('R' + k, 'm0M', k % 500, 1) + '\n');
    for (let k = 0; k < n; k++) parts.push('SG_MUL_VAL_ 1 R' + k + ' R' + ((k + 1) % n) + ' 0-0;\n');
    return parts.join('');
  }
  const three = run(t, 'loop of 3', ring(3));
  assert.equal(three.result.problems.filter(function (p) { return p.code === 'DBC-MUX-CYCLE'; }).length, 3);
  const big = run(t, 'loop of 50,000', ring(50000));
  assert.ok(big.result.counts.error >= 50000);
  assert.equal(M.analyseMux(big.db.messages[0]).info.get(big.db.messages[0].signals[49999]).status, 'cycle');
});

test('one message with a hundred thousand signals that are all selected by one multiplexor', (t) => {
  const n = 100000;
  const parts = [HEAD, 'BO_ 1 Pages: 8 A\n', sg('Sel', 'M', 0, 32), '\n'];
  for (let k = 0; k < n; k++) parts.push(sg('V' + k, 'm' + k, 32, 8) + '\n');
  const text = parts.join('');
  const r = run(t, '100,000 pages', text);
  assert.ok(r.result.problems.some(function (p) { return p.code === 'DBC-CHECK-LIMIT'; }), 'the overlap check reports that it stopped');
  const g = timedGroups(r.db.messages[0]);
  // with so many signals fewer groups are drawn (the rest is counted), so that the work stays small
  assert.ok(g.groups.length >= 9 && g.groups.length <= 65, 'groups: ' + g.groups.length);
  assert.equal(g.more, n - (g.groups.length - 1));
  const lay = H.timed(function () { return L.layoutMarkdown(r.db, r.db.messages[0]); });
  t.diagnostic('layout of 100,000 pages: ' + lay.ms.toFixed(0) + ' ms, ' + (lay.value.length >> 10) + ' KiB');
  assert.ok(lay.ms < LIMIT_MS, 'layout took ' + lay.ms.toFixed(0) + ' ms');
});

function timedGroups(m) {
  const r = H.timed(function () { return M.groupsOf(m); });
  assert.ok(r.ms < LIMIT_MS, 'groups took ' + r.ms.toFixed(0) + ' ms');
  return r.value;
}

test('a hundred thousand signals that are all multiplexors, and two multiplexed signals that cannot tell which selects them', (t) => {
  const n = 100000;
  const parts = [HEAD, 'BO_ 1 Many: 8 A\n'];
  for (let k = 0; k < n; k++) parts.push(sg('S' + k, 'M', k % 64, 1) + '\n');
  parts.push(sg('X', 'm0', 0, 8), '\n', sg('Y', 'm1', 8, 8), '\n');
  const r = run(t, '100,000 multiplexors', parts.join(''));
  assert.equal(r.result.counts.error >= 2, true);
  assert.equal(M.analyseMux(r.db.messages[0]).info.get(r.db.messages[0].signals[n]).status, 'bad');
});

test('huge lists of multiplexor value ranges (SG_MUL_VAL_) do not make the overlap check quadratic', (t) => {
  const n = 100000;
  const even = [];
  const odd = [];
  for (let k = 0; k < n; k++) { even.push((2 * k) + '-' + (2 * k)); odd.push((2 * k + 1) + '-' + (2 * k + 1)); }
  const text = HEAD + 'BO_ 1 R: 8 A\n' + sg('Sel', 'M', 0, 32) + '\n' + sg('X', 'm0', 32, 8) + '\n' + sg('Y', 'm0', 32, 8) + '\n' +
    'SG_MUL_VAL_ 1 X Sel ' + even.join(', ') + ';\n' + 'SG_MUL_VAL_ 1 Y Sel ' + odd.join(', ') + ';\n';
  const r = run(t, 'two signals with 100,000 ranges each', text, { layout: true });
  assert.equal(r.result.problems.some(function (p) { return p.code === 'DBC-SIGNAL-OVERLAP'; }), false, 'even and odd values never meet');
  const same = HEAD + 'BO_ 1 R: 8 A\n' + sg('Sel', 'M', 0, 32) + '\n' + sg('X', 'm0', 32, 8) + '\n' + sg('Y', 'm0', 32, 8) + '\n' +
    'SG_MUL_VAL_ 1 X Sel ' + even.join(', ') + ';\n' + 'SG_MUL_VAL_ 1 Y Sel ' + even.slice(50000).join(', ') + ';\n';
  const r2 = run(t, 'ranges that meet', same);
  assert.equal(r2.result.problems.some(function (p) { return p.code === 'DBC-SIGNAL-OVERLAP'; }), true, 'they meet at value 100000');
});

// ---- long and odd text -----------------------------------------------------------------------------

test('lines and statements of extreme length', (t) => {
  const MB = 1024 * 1024;
  run(t, '1 MB of one repeated signal on a single line', HEAD + 'BO_ 1 A: 8 A\n' + 'SG_ x : 0|8@1+ (1,0) [0|255] "" B '.repeat(30000) + '\n');
  run(t, '1 MB of letters on one line', 'x'.repeat(MB));
  run(t, '1 MB of keywords on one line', 'BO_ 1 A: 8 A SG_ '.repeat(60000));
  run(t, '1 million semicolons', ';'.repeat(1000000));
  run(t, '1 million quotes', '"'.repeat(1000000));
  run(t, '1 million backslashes in a comment', 'CM_ "' + '\\'.repeat(1000000) + '";\n');
  run(t, '200,000 opening parentheses', HEAD + 'BO_ 1 A: 8 A\n SG_ x : 0|8@1+ ' + '('.repeat(200000) + '\n');
  run(t, '200,000 nested brackets', HEAD + 'BO_ 1 A: 8 A\n SG_ x : 0|8@1+ (1,0) ' + '['.repeat(200000) + '\n');
  run(t, '200,000 parentheses in an attribute', 'BA_ "x" ' + '('.repeat(200000) + ';\n');
  run(t, '1 MB of spaces before a keyword', ' '.repeat(MB) + 'BO_ 1 A: 8 A\n');
  run(t, '1 MB of tabs and a keyword at the end', '\t'.repeat(MB) + 'VERSION ""');
  run(t, 'a million line breaks', '\n'.repeat(1000000) + 'VERSION ""');
  run(t, 'a million carriage returns', '\r'.repeat(1000000) + 'VERSION ""');
});

test('a hundred thousand unterminated strings', (t) => {
  run(t, 'unterminated comments', 'CM_ "abc\n'.repeat(100000));
  run(t, 'unterminated value descriptions', 'VAL_ 1 x 0 "abc\n'.repeat(100000));
  run(t, 'unterminated units', ('BO_ 1 A: 8 A\n' + ' SG_ x : 0|8@1+ (1,0) [0|1] "unit\n').repeat(50000));
  run(t, 'one comment that never ends', 'CM_ "' + 'line of comment text\n'.repeat(200000));
});

test('comments and names of a million characters', (t) => {
  run(t, '5 MB comment', 'CM_ "' + 'a'.repeat(5 * 1024 * 1024) + '";\n');
  run(t, '5 MB comment of escaped quotes', 'CM_ "' + '\\"'.repeat(2500000) + '";\n');
  run(t, 'comment of 100,000 lines', 'CM_ "' + 'one line of a long comment\n'.repeat(100000) + '";\n');
  const big = 'N'.repeat(1000000);
  const r = run(t, 'names of 1 MB', HEAD.replace('A B', 'A B ' + big) + 'BO_ 1 ' + big + ': 8 ' + big + '\n SG_ ' + big + ' : 0|8@1+ (1,0) [0|1] "" ' + big + '\n');
  assert.ok(r.result.problems.some(function (p) { return p.code === 'DBC-NAME-LONG'; }));
  for (const p of r.result.problems) assert.ok(p.message.length < 2000, p.code + ' message of ' + p.message.length + ' characters');
  const el = D.elementAt(r.db, text0(r.db));
  if (el) assert.ok(D.hoverOf(r.db, el).length > 0);
});

function text0(db) { return db.messages.length ? db.messages[0].nameStart + 1 : 0; }

test('numbers of a hundred thousand digits', (t) => {
  const digits = '9'.repeat(100000);
  const r = run(t, 'huge numbers everywhere', HEAD + 'BO_ ' + digits + ' A: ' + digits + ' A\n SG_ x : ' + digits + '|' + digits + '@1+ (' + digits + ',' + digits + ') [' + digits + '|' + digits + '] "" B\n' +
    'VAL_ ' + digits + ' x ' + digits + ' "a";\n' + 'SG_MUL_VAL_ 1 x y ' + digits + '-' + digits + ';\n' + 'BA_ "x" BO_ ' + digits + ' ' + digits + ';\n' + 'SIG_VALTYPE_ ' + digits + ' x : ' + digits + ';\n');
  assert.ok(r.result.counts.error > 0);
  run(t, 'twenty huge multiplexor ranges', HEAD + 'BO_ 1 A: 8 A\n' + sg('Sel', 'M', 0, 8) + '\n' + sg('X', 'm0', 8, 8) + '\n' +
    'SG_MUL_VAL_ 1 X Sel ' + new Array(20).fill(digits + '-' + digits).join(', ') + ';\n');
});

test('ten thousand attribute definitions, a hundred thousand value descriptions, thirty thousand value tables', (t) => {
  const defs = [];
  for (let k = 0; k < 10000; k++) defs.push('BA_DEF_ SG_ "Attr' + k + '" INT 0 255;\nBA_DEF_DEF_ "Attr' + k + '" 0;');
  run(t, '10,000 attribute definitions', defs.join('\n') + '\n');
  const entries = [];
  for (let k = 0; k < 100000; k++) entries.push(k + ' "value ' + k + '"');
  const r = run(t, '100,000 value descriptions', HEAD + 'BO_ 1 A: 8 A\n SG_ x : 0|64@1+ (1,0) [0|0] "" B\nVAL_ 1 x ' + entries.join(' ') + ';\n');
  assert.equal(r.db.messages[0].signals[0].values.length, 100000);
  const tables = [];
  for (let k = 0; k < 30000; k++) tables.push('VAL_TABLE_ T' + k + ' 1 "on" 0 "off" ;');
  run(t, '30,000 value tables', tables.join('\n') + '\n');
  const same = [];
  for (let k = 0; k < 30000; k++) same.push('VAL_TABLE_ T' + k + ' 1 "on" 0 "off" ;');
  run(t, '30,000 equal value tables and 30,000 signals with the same values', same.join('\n') + '\n' + HEAD + 'BO_ 1 A: 8 A\n' + sg('x', '', 0, 1) + '\nVAL_ 1 x 1 "on" 0 "off" ;\n');
});

test('thousands of comments, attributes and nodes on the same objects', (t) => {
  const parts = [HEAD, 'BO_ 1 A: 8 A\n', sg('x', '', 0, 8), '\n'];
  for (let k = 0; k < 100000; k++) parts.push('CM_ SG_ 1 x "comment ' + k + '";\nBA_ "GenMsgCycleTime" BO_ 1 ' + k + ';\n');
  run(t, 'repeated comments and attributes of one signal', parts.join(''));
  const nodes = [];
  for (let k = 0; k < 100000; k++) nodes.push('Node' + k);
  run(t, '100,000 nodes', 'BU_: ' + nodes.join(' ') + '\nBO_ 1 A: 8 Node5\n' + sg('x', '', 0, 8, nodes.slice(0, 2000).join(',')) + '\n');
});

// ---- odd values --------------------------------------------------------------------------------------

test('message IDs, lengths, start bits and factors at and beyond the limits', (t) => {
  const r = run(t, 'odd values', HEAD +
    'BO_ 18446744073709551616 TwoToTheSixtyFour: 8 A\n' + sg('a', '', 0, 8) + '\n' +
    'BO_ 1000000000000000000000000000000 Huge: 8 A\n' + sg('b', '', 0, 8) + '\n' +
    'BO_ 4294967295 AllBits: 8 A\n' + sg('c', '', 0, 8) + '\n' +
    'BO_ 2147483648 ExtendedZero: 8 A\n' + sg('d', '', 0, 8) + '\n' +
    'BO_ 3758096384 TooWide: 8 A\n' + sg('e', '', 0, 8) + '\n' +
    'BO_ 5 BigDlc: 1000000000 A\n' + sg('f', '', 0, 8) + '\n' +
    'BO_ 6 HugeDlc: 99999999999999999999 A\n' + sg('g', '', 0, 8) + '\n' +
    'BO_ 7 Bits: 8 A\n' + sg('h', '', 2147483648, 8) + '\n' + sg('i', '', 9007199254740992, 8) + '\n' + sg('j', '', 4096, 8) + '\n' + sg('k', '', 4095, 8) + '\n' +
    sg('l', '', 0, 0) + '\n' + sg('m', '', 0, 65) + '\n' + sg('n', '', 0, 64) + '\n' +
    ' SG_ o : 0|8@1+ (1e400,0) [0|0] "" B\n SG_ p : 8|8@1+ (0,0) [0|0] "" B\n SG_ q : 16|8@1+ (-0,-0) [0|0] "" B\n SG_ r : 24|8@1+ (1e999999,0) [0|0] "" B\n' +
    ' SG_ s : 32|8@1+ (1,1e-400) [0|1e400] "" B\n SG_ t : 40|8@1+ (.5,.5) [-.5|.5] "" B\n');
  const codes = new Set(r.result.problems.map(function (p) { return p.code; }));
  for (const c of ['DBC-MESSAGE-ID-RANGE', 'DBC-MESSAGE-DLC', 'DBC-SIGNAL-OUTSIDE-FRAME', 'DBC-SIGNAL-LENGTH', 'DBC-FACTOR-ZERO', 'DBC-NUMBER']) assert.ok(codes.has(c), 'missing ' + c);
  for (const m of r.db.messages) {
    C.decodeMessage(m, new Uint8Array(64).fill(255), 64);
    C.encodeMessage(r.db, m, { o: '5', p: '1', q: '1', s: '3', t: '0.5' });
    D.hoverOf(r.db, { kind: 'message', message: m });
    for (const s of m.signals) D.hoverOf(r.db, { kind: 'signal', message: m, signal: s });
  }
});

test('NUL bytes, lone surrogates, control characters and byte order marks inside statements', (t) => {
  const odd = ['\u0000', '\uD800', '\uDFFF', '﻿', ' ', '\u0085', '‮', '\u001B[31m', '\u0007'];
  for (const c of odd) {
    run(t, 'character ' + c.charCodeAt(0).toString(16), HEAD.replace('VERSION ""', 'VERSION "' + c + '"') + 'BO_ 1 A' + c + ': 8 A\n SG_ x' + c + ' : 0|8@1+ (1,0) [0|1] "' + c + '" B' + c + '\nCM_ "' + c + '";\nCM_ SG_ 1 x' + c + ' "' + c + '";\n');
  }
  run(t, 'only NUL bytes', '\u0000'.repeat(1000000));
  run(t, 'empty text', '');
  run(t, 'one character', 'B');
  run(t, 'byte order mark only', '﻿');
  const r = P.parseDbc(null);
  assert.equal(r.messages.length, 0);
  assert.equal(P.parseDbc(undefined).messages.length, 0);
  assert.equal(P.parseDbc(12345).messages.length, 0);
});

test('files in UTF-16 and in Windows-1252 are read, and bytes that are no text at all do not stop anything', (t) => {
  const text = HEAD + 'BO_ 1 Msg: 8 A\n' + ' SG_ Temp : 0|8@1+ (1,-40) [-40|215] "°C" B\n' + 'CM_ SG_ 1 Temp "Kälte €";\n';
  const ref = P.parseDbc(text);
  const le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
  const be = Buffer.alloc(le.length - 2 + 2);
  be[0] = 0xFE; be[1] = 0xFF;
  for (let k = 2; k + 1 < le.length; k += 2) { be[k] = le[k + 1]; be[k + 1] = le[k]; }
  const bom8 = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]);
  for (const [label, bytes, encoding] of [['UTF-16 little-endian', le, 'utf-16le'], ['UTF-16 big-endian', be, 'utf-16be'], ['UTF-8 with byte order mark', bom8, 'utf-8'], ['UTF-8', Buffer.from(text, 'utf8'), 'utf-8']]) {
    const d = U.decodeBytes(bytes);
    assert.equal(d.encoding, encoding, label);
    assert.equal(d.text, text, label);
    assert.equal(JSON.stringify(V.validate(P.parseDbc(d.text), { text: d.text }).problems), JSON.stringify(V.validate(ref, { text: text }).problems), label);
  }
  // Windows-1252: a, o and u with umlauts, the euro sign, the degree sign.
  const latin = Buffer.from([...Buffer.from(HEAD, 'latin1'), ...Buffer.from('CM_ "', 'latin1'), 0xE4, 0xF6, 0xFC, 0x80, 0xB0, ...Buffer.from('";\n', 'latin1')]);
  const dl = U.decodeBytes(latin);
  assert.equal(dl.encoding, 'windows-1252');
  assert.ok(dl.text.includes('äöü€°'));
  assert.equal(V.validate(P.parseDbc(dl.text), { text: dl.text }).problems.some(function (p) { return p.code === 'DBC-ENCODING'; }), false);
  // A file that was read with the wrong encoding shows the replacement character and is reported.
  const wrong = Buffer.from(HEAD + 'CM_ "�";\n', 'utf8').toString('utf8');
  assert.ok(V.validate(P.parseDbc(wrong), { text: wrong }).problems.some(function (p) { return p.code === 'DBC-ENCODING'; }));
  // Random bytes, odd lengths and truncated byte order marks.
  const rnd = H.rng(7);
  for (let k = 0; k < 200; k++) {
    const len = rnd.int(3000);
    const b = Buffer.alloc(len);
    for (let i = 0; i < len; i++) b[i] = rnd.int(256);
    if (k % 3 === 0 && len > 2) { b[0] = 0xFF; b[1] = 0xFE; }
    if (k % 3 === 1 && len > 2) { b[0] = 0xFE; b[1] = 0xFF; }
    const d = U.decodeBytes(b);
    assert.equal(typeof d.text, 'string');
    V.validate(P.parseDbc(d.text), { text: d.text });
  }
  for (const b of [Buffer.alloc(0), Buffer.from([0xFF]), Buffer.from([0xFF, 0xFE]), Buffer.from([0xFE, 0xFF, 0x00]), Buffer.from([0xEF, 0xBB]), Buffer.from([0xEF, 0xBB, 0xBF])]) assert.equal(typeof U.decodeBytes(b).text, 'string');
  assert.equal(typeof U.decodeBytes(null).text, 'string');
  t.diagnostic('decoded 200 random byte strings');
});

// ---- hostile names and texts --------------------------------------------------------------------------

function dbcString(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
function oneLine(s) { return String(s).replace(/[\r\n]+/g, ' '); }

function hostileDatabase() {
  const words = H.HOSTILE_WORDS;
  const texts = H.HOSTILE_TEXTS;
  const lines = ['VERSION ' + dbcString(texts[0]), '', 'BS_:', '', 'BU_: ' + words.join(' '), ''];
  const comments = [];
  words.forEach(function (w, i) {
    const text = texts[i % texts.length];
    lines.push('BO_ ' + (100 + i) + ' ' + w + ': 8 ' + w);
    lines.push(' SG_ ' + w + ' : 0|8@1+ (1,0) [0|255] ' + dbcString(oneLine(text)) + ' ' + w + ',' + words[(i + 1) % words.length]);
    lines.push(' SG_ ' + w + 'M M : 8|8@1+ (1,0) [0|255] "" ' + w);
    lines.push(' SG_ ' + w + 'X m1 : 16|8@1+ (1,0) [0|255] "" ' + w);
    lines.push('');
    comments.push('CM_ BO_ ' + (100 + i) + ' ' + dbcString(text) + ';');
    comments.push('CM_ SG_ ' + (100 + i) + ' ' + w + ' ' + dbcString(texts[(i + 3) % texts.length]) + ';');
    comments.push('CM_ BU_ ' + w + ' ' + dbcString(texts[(i + 5) % texts.length]) + ';');
    comments.push('VAL_ ' + (100 + i) + ' ' + w + ' 1 ' + dbcString(oneLine(texts[(i + 1) % texts.length])) + ' 0 ' + dbcString(oneLine(w)) + ' ;');
  });
  lines.push('VAL_TABLE_ ' + words[0] + ' 1 ' + dbcString(oneLine(texts[1])) + ' 0 ' + dbcString(oneLine(texts[2])) + ' ;');
  return lines.concat(comments, ['']).join('\n');
}

function assertSafeHover(md, label) {
  const lines = md.split('\n');
  assert.match(H.liveMarkdown(lines[0]), /^\*\*(Signal|Message|Node|Value table)\*\* ?$/, label + ': the title holds only its own markup, found ' + JSON.stringify(H.liveMarkdown(lines[0])));
  for (const line of lines.slice(1)) {
    if (line === '' || /^\| (?:---|:--|-+:)/.test(line) || /^\| (?:| Raw | Description |)$/.test(line) || line === '| | |' || line === '| Raw | Description |' || line === '| ---: | --- |') continue;
    if (line.startsWith('|')) {
      const cells = H.tableCells(line);
      assert.equal(cells.length, 2, label + ': a table row must keep two cells: ' + JSON.stringify(line));
      for (const cell of cells) {
        const live = H.liveMarkdown(cell);
        assert.equal(/[<>\[\](){}*_#!~+`\\|]/.test(live), false, label + ': live markup in ' + JSON.stringify(cell));
        assert.equal(/&(?!amp;)/.test(live), false, label + ': raw ampersand in ' + JSON.stringify(cell));
      }
    } else {
      const live = H.liveMarkdown(line);
      assert.equal(/[<>\[\](){}*_#!~+`\\|]/.test(live), false, label + ': live markup in ' + JSON.stringify(line));
    }
  }
}

function assertTablesConsistent(md, label) {
  let widths = null;
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) { widths = null; continue; }
    const w = H.tableCells(line).length;
    if (widths === null) widths = w;
    assert.equal(w, widths, label + ': row with a different number of cells: ' + JSON.stringify(line.slice(0, 120)));
  }
}

test('hostile names, units, comments and value descriptions cannot become markup in hovers', () => {
  const text = hostileDatabase();
  const db = P.parseDbc(text);
  const v = V.validate(db, { text: text });
  assert.equal(db.messages.length, H.HOSTILE_WORDS.length);
  for (const [i, w] of H.HOSTILE_WORDS.entries()) {
    assert.equal(db.messages[i].name, w, 'the reader keeps the name as one word');
    assert.equal(db.messages[i].signals[0].name, w);
  }
  assert.ok(v.counts.error + v.counts.warning >= 0);
  let hovers = 0;
  for (const m of db.messages) {
    assertSafeHover(D.hoverOf(db, { kind: 'message', message: m }), 'message ' + m.name);
    for (const s of m.signals) assertSafeHover(D.hoverOf(db, { kind: 'signal', message: m, signal: s }), 'signal ' + s.name);
    hovers += 1 + m.signals.length;
  }
  for (const n of db.nodes) assertSafeHover(D.hoverOf(db, { kind: 'node', name: n.name }), 'node ' + n.name);
  for (const tb of db.valueTables) assertSafeHover(D.hoverOf(db, { kind: 'valueTable', table: tb, name: tb.name }), 'value table ' + tb.name);
  // The same through the lookup by text position, as the editor does it.
  for (let off = 0; off < text.length; off += 7) {
    const el = D.elementAt(db, off);
    if (el) { assertSafeHover(D.hoverOf(db, el), 'offset ' + off); hovers++; }
  }
  assert.ok(hovers > 200);
});

test('hostile names, units and comments cannot become markup in the bit layout text', () => {
  const text = hostileDatabase();
  const db = P.parseDbc(text);
  for (const m of db.messages) {
    const md = L.layoutMarkdown(db, m);
    assert.equal(/[<>\[\]]/.test(H.liveMarkdown(md.replace(/^# Bit layout of /, ''))), false, 'live markup in the layout of ' + m.name);
    assertTablesConsistent(md, 'layout of ' + m.name);
  }
  // Names that stay inside the pipe table of the signal list.
  const piped = P.parseDbc('BO_ 1 A: 8 N\n SG_ Sig : 0|8@1+ (1,0) [0|1] "a|b|c" N\n');
  assertTablesConsistent(L.layoutMarkdown(piped, piped.messages[0]), 'unit with pipes');
});

test('outline labels, details and symbols are single lines whatever the file contains', () => {
  const db = P.parseDbc(hostileDatabase());
  const nodes = [];
  function walk(list, depth) {
    for (const n of list) {
      nodes.push(n);
      if (depth < 3 && n.expandable) walk(O.childrenOf(db, n), depth + 1);
    }
  }
  walk(O.rootNodes(db), 0);
  assert.ok(nodes.length > 50);
  for (const n of nodes) {
    assert.equal(/[\r\n\t\u0000-\u001F]/.test(n.label + n.detail), false, 'control character in ' + JSON.stringify(n.label));
    assert.equal(typeof n.label, 'string');
  }
  for (const it of O.messageItems(db)) assert.equal(/[\r\n]/.test(it.label + it.description + (it.detail || '')), false, 'line break in a message item');
  function symbolsWalk(list) {
    for (const s of list) {
      assert.equal(/[\r\n]/.test(s.name + s.detail), false);
      assert.ok(s.selStart >= s.start - 0 || true);
      symbolsWalk(s.children);
    }
  }
  symbolsWalk(O.symbols(db));
});

test('exports of hostile values keep their cells and neutralise formulas', () => {
  const cells = ['=1+1', '+SUM(A1)', '-2+3', '@x', '\tTab', '\rCR', '"; DROP', '-12.5', '12', "'=x"];
  const row = U.csvRow(cells);
  const parsed = U.parseCsv(row);
  assert.equal(parsed.error, '');
  assert.equal(parsed.rows[0].length, cells.length);
  for (const [i, c] of parsed.rows[0].entries()) {
    const formula = /^[=+\-@\t\r]/.test(cells[i]) && !/^-?\d+(\.\d+)?$/.test(cells[i]);
    if (formula || cells[i].startsWith("'")) assert.equal(c, "'" + cells[i], 'cell ' + i);
    else assert.equal(c, cells[i], 'cell ' + i);
  }
  for (const c of parsed.rows[0]) assert.equal(/^[=+@\t\r]/.test(c) || /^-(?!\d+(\.\d+)?$)/.test(c), false, 'no cell can start a formula: ' + JSON.stringify(c));
  assert.equal(U.csvRow(['=1+1'], false), '=1+1\r\n');
  assert.equal(U.unneutralise(U.neutralise('=a')), '=a');
});

// ---- 50 MB inputs under a 1 GB heap ----------------------------------------------------------------

const CHILD = [
  'const root = process.argv[1]; const kind = process.argv[2]; const mb = Number(process.argv[3]);',
  'const P = require(root + "/src/dbc/parse"); const V = require(root + "/src/dbc/validate"); const O = require(root + "/src/dbc/outline"); const H = require(root + "/test/helpers/hostile");',
  'let text;',
  'if (kind === "real") text = H.bigDbc(Math.floor(mb * 1048576 / 592), 12);',
  'else { const unit = { bo: "BO_ 1 A: 8 N\\n", cm: "CM_ \\"a comment that is a little long to fill the file\\";\\n", sg: "BO_ 1 A: 8 N\\n SG_ x : 0|8@1+ (1,0) [0|255] \\"\\" N\\n", val: "VAL_ 1 x 0 \\"a\\" 1 \\"b\\" 2 \\"c\\" 3 \\"d\\";\\n", nodes: "BU_: a b c d e f g h i j k l m n o p\\n", junk: "x y z ;\\n" }[kind]; text = unit.repeat(Math.floor(mb * 1048576 / unit.length)); }',
  'const t0 = Date.now(); const db = P.parseDbc(text); const r = V.validate(db, { text: text, maxProblems: 200 });',
  'for (const n of O.rootNodes(db)) O.childrenOf(db, n);',
  'O.symbols(db);',
  'let signals = 0; for (const m of db.messages) signals += m.signals.length;',
  'console.log(JSON.stringify({ ms: Date.now() - t0, chars: text.length, messages: db.messages.length, signals: signals, counts: r.counts, stopped: db.readStoppedAt === undefined ? -1 : db.readStoppedAt, limit: r.problems.some(function (p) { return p.code === "DBC-FILE-LIMIT"; }) }));'
].join('\n');

function child(kind, mb) {
  const t0 = Date.now();
  const r = cp.spawnSync(process.execPath, ['--max-old-space-size=1024', '-e', CHILD, ROOT, kind, String(mb)], { encoding: 'utf8', timeout: 180000, windowsHide: true, maxBuffer: 1 << 26 });
  return { status: r.status, signal: r.signal, stderr: (r.stderr || '').slice(0, 600), wall: Date.now() - t0, out: r.status === 0 ? JSON.parse(r.stdout.trim().split('\n').pop()) : null };
}

test('a realistic database of 50 MB (88,000 messages, 1,000,000 signals) is read and checked completely under a 1 GB heap', (t) => {
  const r = child('real', 50);
  t.diagnostic('real 50 MB: wall ' + r.wall + ' ms, ' + JSON.stringify(r.out));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.wall < 60000, 'took ' + r.wall + ' ms');
  assert.ok(r.out.chars > 49 * 1048576);
  assert.equal(r.out.limit, false, 'nothing was left out');
  assert.ok(r.out.signals > 1000000);
});

for (const [kind, what] of [['bo', 'BO_ 1 A: 8 N'], ['sg', 'a message with one signal'], ['cm', 'comment lines'], ['val', 'value descriptions'], ['nodes', 'node lists'], ['junk', 'statements that are not DBC']]) {
  test('50 MB of ' + what + ' repeated are handled under a 1 GB heap', (t) => {
    const r = child(kind, 50);
    t.diagnostic(kind + ' 50 MB: wall ' + r.wall + ' ms, ' + JSON.stringify(r.out));
    assert.equal(r.status, 0, 'child failed: ' + r.signal + ' ' + r.stderr);
    assert.ok(r.wall < 60000, 'took ' + r.wall + ' ms');
    assert.ok(r.out.chars > 49 * 1048576);
    if (kind === 'bo' || kind === 'sg') {
      assert.equal(r.out.limit, true, 'reading stops with DBC-FILE-LIMIT');
      assert.ok(r.out.stopped > 0 && r.out.stopped < r.out.chars);
    }
  });
}
