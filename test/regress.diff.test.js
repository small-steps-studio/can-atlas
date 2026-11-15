'use strict';
// Regression tests for the independent audit of 0.1.0, defect 2: Compare said "No differences."
// for two files whose text differs (blank lines, spacing, line ends, a byte order mark, the way a
// number is written, the order of receivers and value descriptions). It must say "No differences"
// only for two files that are the same, and otherwise name what kind of difference remains.

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/dbc/parse');
const D = require('../src/pro/diff');
const R = require('../src/pro/diffreport');
const samples = require('../src/samples');

const SAMPLE = samples.sampleFor('valid').text;

function swap(text, from, to) {
  assert.ok(text.includes(from), 'the sample holds ' + JSON.stringify(from));
  return text.replace(from, to);
}
function diff(a, b, options) { return D.diffDatabases(P.parseDbc(a), P.parseDbc(b), options); }

// The 14 mutations of the newer file that the audit found to give "No differences."
const MUTATIONS = {
  'blank lines doubled': (t) => t.replace(/\n/g, '\n\n'),
  'trailing spaces': (t) => t.replace(/\n/g, '  \n'),
  'tabs before SG_': (t) => t.replace(/^ SG_/gm, '\tSG_'),
  'CRLF line ends': (t) => t.replace(/\n/g, '\r\n'),
  'a byte order mark': (t) => '﻿' + t,
  '(0.25,0) written (0.250,0)': (t) => swap(t, '(0.25,0)', '(0.250,0)'),
  '-40 written -40.0': (t) => swap(t, '(1,-40) [-40|150]', '(1,-40.0) [-40|150]'),
  '8000 written 8000.0': (t) => swap(t, '[0|8000]', '[0|8000.0]'),
  '1 written 1E0': (t) => swap(t, 'EngineRunning : 44|1@1+ (1,0)', 'EngineRunning : 44|1@1+ (1E0,0)'),
  '[0|8000] written [-0|8000]': (t) => swap(t, '[0|8000]', '[-0|8000]'),
  'BO_ 256 written BO_ 0256': (t) => swap(t, 'BO_ 256 EngineStatus', 'BO_ 0256 EngineStatus'),
  'receivers reordered': (t) => swap(t, '"rpm" Dashboard,Gateway', '"rpm" Gateway,Dashboard'),
  'a receiver repeated': (t) => swap(t, '"rpm" Dashboard,Gateway', '"rpm" Dashboard,Gateway,Gateway'),
  'value-table entries reordered': (t) => swap(t, '7 "Invalid" 3 "Drive" 2 "Neutral" 1 "Reverse" 0 "Park"', '0 "Park" 1 "Reverse" 2 "Neutral" 3 "Drive" 7 "Invalid"')
};

test('two files that hold the same data but are written differently never read "No differences."', () => {
  assert.equal(Object.keys(MUTATIONS).length, 14);
  for (const name of Object.keys(MUTATIONS)) {
    const mutated = MUTATIONS[name](SAMPLE);
    assert.notEqual(mutated, SAMPLE, name);
    const r = diff(SAMPLE, mutated);
    assert.equal(r.summary.total, 0, name + ': the database content is the same');
    assert.equal(r.summary.identical, false, name);
    assert.equal(r.summary.kind, 'formatting', name);
    assert.notEqual(r.summary.text, 'No differences.', name);
    assert.equal(r.summary.text, D.FORMATTING_TEXT, name);
    assert.match(r.summary.text, /^No differences in the database content\. The files differ only in how the same content is written: spacing, blank lines, line ends, the byte order mark, the way numbers are written or the order of list entries\.$/, name);
    // The reports carry the same sentence, never the bare "No differences."
    const md = R.diffMarkdown(r, { oldName: 'a.dbc', newName: 'b.dbc' });
    assert.ok(md.includes(D.FORMATTING_TEXT), name + ' (Markdown)');
    assert.ok(!/No differences\.\n/.test(md.replace(D.FORMATTING_TEXT, '')), name + ' (Markdown)');
    const html = R.diffHtml(r, { oldName: 'a.dbc', newName: 'b.dbc' });
    assert.ok(html.includes('<p>No differences in the database content.'), name + ' (HTML)');
    // The table of a CSV report would be empty; one row says why.
    const csv = R.diffCsv(r, {}).split('\r\n').filter(Boolean);
    assert.equal(csv.length, 2, name + ' (CSV)');
    assert.match(csv[1], /summary/, name + ' (CSV)');
    assert.ok(csv[1].includes('No differences in the database content'), name + ' (CSV)');
  }
});

test('the same text on both sides is the only way to read "No differences."', () => {
  const r = diff(SAMPLE, SAMPLE);
  assert.equal(r.summary.identical, true);
  assert.equal(r.summary.kind, 'identical');
  assert.equal(r.summary.text, 'No differences.');
  assert.equal(R.diffCsv(r, {}).split('\r\n').filter(Boolean).length, 1, 'no row for two identical files');
  // A hand-made database without a fingerprint can never be called identical.
  const a = P.parseDbc(SAMPLE);
  const b = P.parseDbc(SAMPLE);
  delete a.fingerprint;
  delete b.fingerprint;
  assert.equal(D.diffDatabases(a, b).summary.identical, false);
});

test('the fingerprint of the bytes of a saved file decides, so a byte order mark that the editor hides still counts', () => {
  const plain = Buffer.from(SAMPLE, 'utf8');
  const withBom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), plain]);
  const text = P.parseDbc(SAMPLE);
  const options = (x, y) => ({ oldFingerprint: P.sourceFingerprint(x), newFingerprint: P.sourceFingerprint(y) });
  assert.equal(D.diffDatabases(text, text, options(plain, plain)).summary.identical, true);
  const r = D.diffDatabases(text, text, options(plain, withBom));
  assert.equal(r.summary.identical, false);
  assert.equal(r.summary.kind, 'formatting');
  // A text fingerprint is never equal to a byte fingerprint.
  assert.notEqual(P.sourceFingerprint(SAMPLE), P.sourceFingerprint(plain));
  assert.equal(P.sourceFingerprint(SAMPLE), P.sourceFingerprint(SAMPLE));
  assert.notEqual(P.sourceFingerprint(SAMPLE), P.sourceFingerprint(SAMPLE + ' '));
});

test('a difference in a statement that is read over keeps its own wording, and a real change keeps the counts', () => {
  const extra = diff(SAMPLE, SAMPLE + 'SIG_GROUP_ 256 Group 1 : EngineSpeed;\n');
  assert.equal(extra.summary.kind, 'statements');
  assert.equal(extra.summary.text, 'No differences in the compared statements.');
  const changed = diff(SAMPLE, swap(SAMPLE, '(0.25,0) [0|8000]', '(0.5,0) [0|8000]'));
  assert.equal(changed.summary.kind, 'changes');
  assert.match(changed.summary.text, /^1 difference: 1 breaking, 0 non-breaking, 0 cosmetic\.$/);
  assert.equal(changed.summary.identical, false);
});

// ---- the command: the bytes of a saved file decide ------------------------------------------------

const path = require('node:path');
const M = require('./helpers/vscode-mock');
const pkg = require('../package.json');

function startCompare(files, answers) {
  const mock = M.createMock({ files: files, active: 'file:///work/new.dbc', folders: [{ uri: M.Uri.parse('file:///work'), name: 'work' }], quickPickAnswers: answers || [(i) => /old/.test(i.label)] });
  const uninstall = M.install(mock.vscode);
  const srcDir = path.join(__dirname, '..', 'src');
  for (const k of Object.keys(require.cache)) if (k.startsWith(srcDir)) delete require.cache[k];
  const ext = require('../src/extension');
  const context = M.makeContext(pkg);
  const t = Date.now() - 86400000;
  context.globalMap.set('trial.startedAt', t);
  context.globalMap.set('trial.lastSeenAt', t);
  ext.activate(context);
  return { state: mock.state, uninstall: uninstall, run: (id, ...a) => mock.vscode.commands.executeCommand(id, ...a) };
}

test('Compare: a byte order mark that the editor does not show still prevents "No differences"', async () => {
  const x = startCompare({ 'file:///work/new.dbc': SAMPLE, 'file:///work/old.dbc': SAMPLE });
  try {
    // The older file on disk starts with a byte order mark; the open editor shows the same text without it.
    x.state.files.set('file:///work/old.dbc', '﻿' + SAMPLE);
    await x.run('canAtlas.compareFiles');
    const tree = x.state.trees['canAtlas.diff'];
    const item = tree.getTreeItem(tree.getChildren()[0]);
    assert.equal(item.label, 'No content differences');
    assert.match(x.state.infoMessages.find((m) => /compared with/.test(m.text)).text, /No differences in the database content\. The files differ only in how the same content is written: spacing, blank lines, line ends, the byte order mark/);
  } finally { x.uninstall(); }
});

test('Compare: other line ends on disk, with the same text in the editor, are not "No differences" either; the same bytes are', async () => {
  const crlf = startCompare({ 'file:///work/new.dbc': SAMPLE, 'file:///work/old.dbc': SAMPLE });
  try {
    crlf.state.files.set('file:///work/old.dbc', SAMPLE.replace(/\n/g, '\r\n'));
    await crlf.run('canAtlas.compareFiles');
    const tree = crlf.state.trees['canAtlas.diff'];
    assert.equal(tree.getTreeItem(tree.getChildren()[0]).label, 'No content differences');
  } finally { crlf.uninstall(); }
  const same = startCompare({ 'file:///work/new.dbc': SAMPLE, 'file:///work/old.dbc': SAMPLE });
  try {
    await same.run('canAtlas.compareFiles');
    const tree = same.state.trees['canAtlas.diff'];
    assert.equal(tree.getTreeItem(tree.getChildren()[0]).label, 'No differences');
    assert.match(same.state.infoMessages.find((m) => /compared with/.test(m.text)).text, /: No differences\.$/);
  } finally { same.uninstall(); }
});
