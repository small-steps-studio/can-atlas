'use strict';
// Compare must never say "No differences" when the two files differ. Every corpus file is damaged
// in many small ways (a digit, a letter, a deleted line, a repeated line) with a seeded random sequence;
// the damaged file differs from the original in a character that is not white space, and the
// comparison must then report a change or say that statements it does not compare differ.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../src/dbc/parse');
const D = require('../src/pro/diff');
const R = require('../src/pro/diffreport');
const U = require('../src/util');

const CORPUS = path.join(__dirname, 'fixtures', 'corpus');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function compare(a, b) { return D.diffDatabases(P.parseDbc(a), P.parseDbc(b)); }
function norm(line) { return line.replace(/\s+/g, ' ').trim(); }

test('identical files are reported as identical; files that differ only in white space are not (they hold the same content)', () => {
  let respaced = 0;
  for (const f of fs.readdirSync(CORPUS).filter((n) => /\.dbc$/.test(n))) {
    const text = U.decodeBytes(fs.readFileSync(path.join(CORPUS, f))).text;
    const r = compare(text, text);
    assert.equal(r.summary.identical, true, f);
    assert.equal(r.summary.kind, 'identical', f);
    assert.equal(r.summary.text, 'No differences.', f);
    // (A line break inside a quoted text is part of the text, so files with such a text are left out of this variant.)
    const spaced = text.split('\n').some((l) => (l.split('"').length - 1) % 2 === 1) ? text : text.replace(/\r\n|\r|\n/g, '\r\n\r\n');
    if (spaced === text) continue;
    respaced++;
    const s = compare(text, spaced).summary;
    assert.equal(s.identical, false, f + ' with other white space');
    assert.equal(s.kind, 'formatting', f + ' with other white space');
    assert.equal(s.total, 0, f + ' with other white space');
    assert.equal(s.text, D.FORMATTING_TEXT, f);
  }
  assert.ok(respaced > 30, 'files re-spaced: ' + respaced);
});

test('statements that are read over (environment variables, signal groups, relation attributes, NS_ and BS_) count as differences', () => {
  const base = 'VERSION ""\n\nNS_ :\n\tCM_\n\nBS_:\n\nBU_: A B\n\nBO_ 1 M: 8 A\n SG_ S : 0|8@1+ (1,0) [0|0] "" B\n';
  const extra = [
    'EV_ Speed: 0 [0|100] "km/h" 0 1 DUMMY_NODE_VECTOR0 Vector__XXX;\n',
    'SIG_GROUP_ 1 Group 1 : S;\n',
    'BA_DEF_REL_ BU_SG_REL_ "X" INT 0 5;\n',
    'ENVVAR_DATA_ Speed: 4;\n',
    'SGTYPE_ Type: 8@1+ (1,0) [0|0] "" 0 ;\n',
    'BS_: 500000 : 1,2;\n'
  ];
  for (const e of extra) {
    const r = compare(base, base + e);
    assert.equal(r.summary.identical, false, e);
    assert.notEqual(r.summary.text, 'No differences.', e);
    assert.ok(r.notes.some((n) => /does not compare or that have no effect/.test(n)), e);
    assert.equal(compare(base + e, base + e).summary.identical, true, e + ' (same on both sides)');
  }
  // The text outside any statement counts too.
  assert.equal(compare(base, base + '}\n').summary.identical, false);
  // The report says it.
  const r = compare(base, base + extra[1]);
  assert.match(R.diffMarkdown(r, { oldName: 'a.dbc', newName: 'b.dbc' }), /No differences in the compared statements\./);
  assert.match(R.diffMarkdown(r, { oldName: 'a.dbc', newName: 'b.dbc' }), /SIG_GROUP_/);
});

test('damaged corpus files are never reported as identical to the original (seeded)', () => {
  const rnd = mulberry32(Number(process.env.CAN_ATLAS_FUZZ_SEED) || 20261112);
  let cases = 0;
  let exempt = 0;
  const failures = [];
  for (const f of fs.readdirSync(CORPUS).filter((n) => /\.dbc$/.test(n))) {
    const text = U.decodeBytes(fs.readFileSync(path.join(CORPUS, f))).text;
    if (text.length > 20000) continue;
    const lines = text.split('\n');
    const seen = new Map();
    for (const l of lines) { const k = norm(l); if (k) seen.set(k, (seen.get(k) || 0) + 1); }
    const picks = Math.min(lines.length * 2, 150);
    for (let n = 0; n < picks; n++) {
      const i = Math.floor(rnd() * lines.length);
      const line = lines[i];
      if (!norm(line)) continue;
      const kind = Math.floor(rnd() * 4);
      let damaged = null;
      if (kind === 0) {
        const digits = [];
        for (let k = 0; k < line.length; k++) if (line[k] >= '0' && line[k] <= '9') digits.push(k);
        if (!digits.length) continue;
        const at = digits[Math.floor(rnd() * digits.length)];
        damaged = line.slice(0, at) + String((Number(line[at]) + 1 + Math.floor(rnd() * 8)) % 10) + line.slice(at + 1);
      } else if (kind === 1) {
        const letters = [];
        for (let k = 0; k < line.length; k++) if (/[A-Za-z]/.test(line[k])) letters.push(k);
        if (!letters.length) continue;
        const at = letters[Math.floor(rnd() * letters.length)];
        damaged = line.slice(0, at) + (line[at] === 'q' ? 'z' : 'q') + line.slice(at + 1);
      } else if (kind === 2) {
        damaged = null;
      } else {
        damaged = line + '\n' + line;
      }
      const copy = lines.slice();
      if (kind === 2) copy.splice(i, 1); else copy[i] = damaged;
      const mutant = copy.join('\n');
      const a = lines.map(norm).filter(Boolean).sort().join('\n');
      const b = copy.map(norm).filter(Boolean).sort().join('\n');
      if (a === b) continue;
      // A statement that appears twice in the original (or becomes a repeat) means the same data may be written once or twice.
      const key = norm(line);
      if ((seen.get(key) || 0) > 1 || kind === 3) { exempt++; continue; }
      cases++;
      const r = compare(text, mutant);
      if (r.summary.identical) failures.push(f + ' line ' + (i + 1) + ' kind ' + kind + ': ' + JSON.stringify(line.slice(0, 80)) + ' -> ' + JSON.stringify((damaged || '').slice(0, 80)));
    }
  }
  assert.ok(cases > 1500, 'cases ' + cases);
  assert.deepEqual(failures.slice(0, 15), [], failures.length + ' damaged files were reported as identical (of ' + cases + ')');
  assert.ok(exempt >= 0);
});

test('more than 50,000 different statements that are not compared: the comparison says that only part was compared', () => {
  const lines = [];
  for (let i = 0; i < 60000; i++) lines.push('SIG_GROUP_ ' + i + ' G 1 : S;');
  const text = 'VERSION ""\n\nBU_: A\n' + lines.join('\n') + '\n';
  const r = compare(text, text);
  assert.equal(r.summary.identical, false);
  assert.equal(r.summary.text, 'No differences in the compared statements.');
  assert.match(r.notes.join(' '), /more than 50,000 different statements/);
  // The same statement repeated 200,000 times is one entry and is compared exactly.
  const repeated = 'VERSION ""\nBU_: A\n' + 'SIG_GROUP_ 1 G 1 : S;\n'.repeat(200000);
  const fewer = 'VERSION ""\nBU_: A\n' + 'SIG_GROUP_ 1 G 1 : S;\n'.repeat(199999);
  assert.equal(compare(repeated, repeated).summary.identical, true);
  assert.equal(compare(repeated, fewer).summary.identical, false);
});
