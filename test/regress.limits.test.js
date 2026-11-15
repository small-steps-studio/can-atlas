'use strict';
// Regression tests for the independent audit of 0.1.0, defect 8: Compare of two databases of 48 MB
// each ran out of memory under a heap of 1 GB (a parsed file takes about twelve times its text).
// Compare, Create DBC Documentation and Export Signals As CSV now refuse files over a tested limit,
// with a message that says what to do; a child process with --max-old-space-size=1024 runs each of
// them at its limit.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cp = require('node:child_process');
const M = require('./helpers/vscode-mock');
const samples = require('../src/samples');
const pkg = require('../package.json');
const { LIMITS } = require('../src/procommands');

const MB = 1048576;
const VALID = 'file:///work/vehicle.dbc';
const OLDER = 'file:///work/vehicle-v1.dbc';
const VALID_TEXT = samples.sampleFor('valid').text;

function start(options) {
  const o = options || {};
  const mock = M.createMock(Object.assign({ active: VALID, folders: [{ uri: M.Uri.parse('file:///work'), name: 'work' }] }, o));
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
// One long line of the given size (cheap to hold; the command must refuse before it reads it).
function big(bytes) { return 'VERSION ""\n' + '\n'.repeat(3) + 'x'.repeat(bytes - 14); }
function warnings(x) { return x.state.warningMessages.map((m) => m.text); }

test('the limits are in the order the measurements gave them', () => {
  assert.equal(LIMITS.compare, 40 * MB);
  assert.equal(LIMITS.documentation, 20 * MB);
  assert.equal(LIMITS.signalTable, 32 * MB);
});

test('Compare refuses a file over the limit and says what to do', async () => {
  const x = start({ files: { [VALID]: big(LIMITS.compare + MB), [OLDER]: VALID_TEXT } });
  try {
    await x.run('canAtlas.compareFiles');
    assert.equal(x.state.trees['canAtlas.diff'].getChildren().length, 0, 'nothing is compared');
    assert.equal(x.state.quickPickLists.length, 0, 'the question for the other file is not even asked');
    const text = warnings(x).find((w) => /Compare reads at most 40 MB/.test(w));
    assert.ok(text, warnings(x).join(' | '));
    assert.match(text, /both files are held in memory at the same time, each about twelve times its size/);
    assert.match(text, /This file alone is 41 MB/);
    assert.match(text, /Split the database into several files, or compare smaller files\./);
  } finally { x.uninstall(); }
});

test('Compare refuses two files that together are over the limit (an open editor, and a file chosen in the dialog)', async () => {
  const half = 22 * MB;
  const open = start({ files: { [VALID]: big(half), [OLDER]: big(half) }, quickPickAnswers: [(i) => /vehicle-v1/.test(i.label)] });
  try {
    await open.run('canAtlas.compareFiles');
    assert.equal(open.state.trees['canAtlas.diff'].getChildren().length, 0);
    assert.match(warnings(open).join(' | '), /This file is 22 MB and the other file is 22 MB\./);
  } finally { open.uninstall(); }
  const chosen = M.Uri.parse('file:///elsewhere/old.dbc');
  const file = start({ files: { [VALID]: big(half) }, dialogAnswers: [[chosen]], quickPickAnswers: [0] });
  try {
    file.state.files.set(chosen.toString(), big(half));
    await file.run('canAtlas.compareFiles');
    assert.equal(file.state.trees['canAtlas.diff'].getChildren().length, 0);
    assert.match(warnings(file).join(' | '), /Compare reads at most 40 MB/);
    assert.match(warnings(file).join(' | '), /the other file is 22 MB/);
  } finally { file.uninstall(); }
});

test('Compare still works for ordinary files and says nothing about limits', async () => {
  const text = VALID_TEXT;
  const x = start({ files: { [VALID]: text, [OLDER]: text.replace('"1.4"', '"1.3"') }, quickPickAnswers: [(i) => /vehicle-v1/.test(i.label)] });
  try {
    await x.run('canAtlas.compareFiles');
    assert.ok(x.state.trees['canAtlas.diff'].getChildren().length > 0);
    assert.deepEqual(warnings(x), []);
  } finally { x.uninstall(); }
});

test('Create DBC Documentation and Export Signals As CSV refuse a file over their limit', async () => {
  const doc = start({ files: { [VALID]: big(LIMITS.documentation + MB) } });
  try {
    await doc.run('canAtlas.createDocumentation');
    assert.equal(doc.state.quickPickLists.length, 0);
    assert.match(warnings(doc).join(' | '), /"Create DBC Documentation" reads DBC files of up to 20 MB, because it builds its result in memory; this file is 21 MB\. Split the database into several files\./);
  } finally { doc.uninstall(); }
  const csv = start({ files: { [VALID]: big(LIMITS.signalTable + MB) } });
  try {
    await csv.run('canAtlas.exportSignalsCsv');
    assert.equal(csv.state.saveOptions.length, 0, 'no file is offered');
    assert.match(warnings(csv).join(' | '), /"Export Signals As CSV" reads DBC files of up to 32 MB.*this file is 33 MB\./);
  } finally { csv.uninstall(); }
  // A file inside the limit still gets its result.
  const ok = start({ files: { [VALID]: VALID_TEXT }, quickPickAnswers: [0], saveAnswers: [M.Uri.parse('file:///work/signals.csv')] });
  try {
    await ok.run('canAtlas.exportSignalsCsv');
    assert.match(ok.state.written.get('file:///work/signals.csv') || '', /EngineSpeed/);
  } finally { ok.uninstall(); }
});

test('under a heap of 1 GB, Compare, Documentation and the signal table work at their limits', { timeout: 240000 }, async (t) => {
  const child = path.join(__dirname, 'helpers', 'limits-child.js');
  const r = cp.spawnSync(process.execPath, ['--max-old-space-size=1024', child], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * MB, timeout: 220000 });
  assert.equal(r.status, 0, 'the child ended with code ' + r.status + ' ' + (r.stderr || '').slice(0, 300));
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  t.diagnostic(JSON.stringify(out));
  assert.ok(out.heapLimitMB >= 1000 && out.heapLimitMB < 1400, 'the child really ran with a heap of about 1 GB: ' + out.heapLimitMB);
  assert.ok(out.scenarios.compare.textMB >= 38 && out.scenarios.compare.textMB <= 40, 'two files of 20 MB: ' + out.scenarios.compare.textMB);
  assert.equal(out.scenarios.compare.total, 1, 'the one cosmetic change (the version)');
  assert.ok(out.scenarios.documentation.messages > 40000);
  assert.ok(out.scenarios.signalTable.messages > 70000);
  for (const name of Object.keys(out.scenarios)) assert.ok(out.scenarios[name].peakHeapMB < 900, name + ' peaked at ' + out.scenarios[name].peakHeapMB + ' MB');
});
