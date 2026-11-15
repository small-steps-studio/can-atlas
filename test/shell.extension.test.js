'use strict';
// The extension inside a stand-in editor: activation, providers, free commands, the Pro gate and
// the trial, the Pro commands and the licence commands.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const M = require('./helpers/vscode-mock');
const samples = require('../src/samples');
const pkg = require('../package.json');
const { codesOf } = require('./helpers/load');

const VALID = 'file:///work/vehicle.dbc';
const OLDER = 'file:///work/vehicle-v1.dbc';
const BROKEN = 'file:///work/broken.dbc';
const TRACE = 'file:///work/trace.log';
const NOTES = 'file:///work/notes.md';

const VALID_TEXT = samples.sampleFor('valid').text;
// The older version: another factor (breaking), a signal that is not there yet (the new file adds it) and another comment.
const OLDER_TEXT = VALID_TEXT.replace('(0.25,0) [0|8000]', '(0.5,0) [0|8000]')
  .replace(/ SG_ StatusCounter : 60\|4@1\+ \(1,0\) \[0\|15\] "" Gateway\n/, '')
  .replace('"Crankshaft speed."', '"Crank speed."');

function start(options) {
  const o = options || {};
  const mock = M.createMock(Object.assign({
    files: { [VALID]: VALID_TEXT, [OLDER]: OLDER_TEXT, [BROKEN]: samples.sampleFor('problems').text, [TRACE]: samples.sampleFor('trace').text, [NOTES]: '# notes' },
    active: VALID, folders: [{ uri: M.Uri.parse('file:///work'), name: 'work' }]
  }, o));
  const uninstall = M.install(mock.vscode);
  const srcDir = path.join(__dirname, '..', 'src');
  for (const k of Object.keys(require.cache)) if (k.startsWith(srcDir)) delete require.cache[k];
  const ext = require('../src/extension');
  const context = M.makeContext(pkg, o.extensionMode);
  if (o.trialDaysAgo !== undefined) {
    const t = Date.now() - o.trialDaysAgo * 86400000;
    context.globalMap.set('trial.startedAt', t);
    context.globalMap.set('trial.lastSeenAt', t);
  }
  ext.activate(context);
  return { mock: mock, state: mock.state, context: context, uninstall: uninstall, run: (id, ...a) => mock.vscode.commands.executeCommand(id, ...a) };
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function doc(x, uri) { return x.state.documents.find((d) => d.uri.toString() === uri); }
function lastOpened(x) { return x.state.openedDocs[x.state.openedDocs.length - 1]; }

// The documents of the stand-in editor: .dbc is DBC, everything else plain text.
function dbcDoc(x) { return doc(x, VALID); }

test('activation registers every command of the manifest and nothing else', async () => {
  const x = start();
  try {
    const declared = pkg.contributes.commands.map((c) => c.command).sort();
    assert.deepEqual(Array.from(x.state.commands.keys()).sort(), declared);
    assert.ok(x.state.providers.hover && x.state.providers.symbols && x.state.providers.folding && x.state.providers.definition && x.state.providers.references);
    assert.ok(x.state.trees['canAtlas.outline'] && x.state.trees['canAtlas.diff']);
  } finally { x.uninstall(); }
});

test('problems appear with codes and links; the valid sample has none', async () => {
  const x = start();
  try {
    await wait(700);
    assert.deepEqual(x.state.diagnostics.get(VALID), []);
    const diags = x.state.diagnostics.get(BROKEN);
    assert.deepEqual(diags.map((d) => d.code.value).sort(), ['DBC-MESSAGE-ID-DUPLICATE', 'DBC-MESSAGE-EXTENDED-FLAG', 'DBC-RANGE-INVERTED', 'DBC-RECEIVER-UNKNOWN', 'DBC-SIGNAL-OUTSIDE-FRAME', 'DBC-SIGNAL-OVERLAP'].sort());
    assert.match(diags[0].code.target.toString(), /^https:\/\/github\.com\/small-steps-studio\/can-atlas\/blob\/HEAD\/docs\/problems\.md#dbc-/);
    assert.ok(diags.every((d) => d.source === 'CAN Atlas'));
    assert.equal(x.state.diagnostics.get(TRACE), undefined, 'a trace file is not checked as a DBC file');
  } finally { x.uninstall(); }
});

test('hover, symbols, folding, definition, references and the outline tree', async () => {
  const x = start();
  try {
    const d = dbcDoc(x);
    const text = d.getText();
    const speed = text.indexOf(' SG_ EngineSpeed') + 6;
    const hover = await x.state.providers.hover.provideHover(d, d.positionAt(speed + 2));
    assert.match(hover.contents.value, /EngineSpeed/);
    assert.match(hover.contents.value, /little\\-endian/);
    assert.match(hover.contents.value, /0\.25/);
    assert.equal(hover.contents.isTrusted, false);
    assert.equal(hover.contents.supportHtml, false);
    const symbols = x.state.providers.symbols.provideDocumentSymbols(d);
    assert.ok(symbols.length >= 3);
    const folds = x.state.providers.folding.provideFoldingRanges(d);
    assert.ok(folds.length >= 6 && folds.every((f) => f.end > f.start));
    // The comment line "CM_ SG_ 256 EngineSpeed" refers to the signal: go to its definition and find both places.
    const ref = text.indexOf('CM_ SG_ 256 EngineSpeed') + 'CM_ SG_ 256 '.length + 2;
    const def = x.state.providers.definition.provideDefinition(d, d.positionAt(ref));
    assert.equal(def.range.start.line, d.positionAt(speed).line);
    const refs = x.state.providers.references.provideReferences(d, d.positionAt(speed));
    assert.equal(refs.length, 2);
    await wait(500);
    const tree = x.state.trees['canAtlas.outline'];
    const roots = tree.getChildren();
    assert.ok(roots.length >= 2);
    const item = tree.getTreeItem(roots[0]);
    assert.ok(item.label);
    const first = tree.getChildren(roots[0])[0];
    const kid = tree.getTreeItem(first);
    assert.equal(kid.command.command, 'canAtlas.revealOffset');
    assert.equal(kid.command.arguments[0], VALID);
    await x.run('canAtlas.revealOffset', VALID, text.indexOf('BO_ 288 GearStatus'));
    assert.equal(x.state.activeTextEditor.selection.start.line, d.positionAt(text.indexOf('BO_ 288 GearStatus')).line);
  } finally { x.uninstall(); }
});

test('status bar: messages, signals and problems', async () => {
  const x = start();
  try {
    await wait(700);
    const item = x.state.statusItems.find((i) => /message/.test(i.text));
    assert.ok(item && item.visible);
    assert.match(item.text, /8 messages · 30 signals$/);
    await x.run('canAtlas.checkFile');
    assert.match(x.state.infoMessages.pop().text, /0 errors, 0 warnings and 0 notes; 8 messages, 30 signals\. These are structural checks of the database; they do not replace a test on the bus\./);
  } finally { x.uninstall(); }
});

test('Check Current File and the status bar honour the size limit; a large file is checked on demand', async () => {
  const x = start({ config: { 'canAtlas.maxFileSizeMB': 0.1 }, files: { [VALID]: VALID_TEXT + ('CM_ "' + 'x'.repeat(200) + '";\n').repeat(700) } });
  try {
    await wait(700);
    assert.equal(x.state.diagnostics.get(VALID), undefined, 'not checked automatically');
    assert.deepEqual(x.state.providers.symbols.provideDocumentSymbols(dbcDoc(x)), []);
    await x.run('canAtlas.checkFile');
    assert.match(x.state.infoMessages.pop().text, /errors, \d+ warnings/);
    assert.ok(x.state.diagnostics.get(VALID), 'the on-demand check shows its problems');
  } finally { x.uninstall(); }
});

test('Decode Frame writes the hand-computed values; wrong input is explained', async () => {
  const x = start({ inputAnswers: ['100#401F72FA8E01103C'] });
  try {
    await x.run('canAtlas.decodeFrame');
    const out = lastOpened(x);
    assert.equal(out.uri.toString(), 'untitled:decoded-frame.md');
    const text = out.getText().replace(/\s+/g, ' ');
    // 0x1F40 = 8000 raw, times 0.25 = 2000 rpm; byte 2 = 0x72 = 114, minus 40 = 74 degC.
    assert.match(text, /EngineSpeed \| 8000 \| 2000 \| rpm/);
    assert.match(text, /CoolantTemp \| 114 \| 74 \| degC/);
  } finally { x.uninstall(); }
  // A negative value: EngineTorque is 12 bits signed at bit 32; 0xFF3 is -13, times 0.5 is -6.5. Plain numbers are written as they are.
  const neg = start({ inputAnswers: ['100#00000000F30F0000'] });
  try {
    await neg.run('canAtlas.decodeFrame');
    assert.match(lastOpened(neg).getText().replace(/ +/g, ' '), /\| EngineTorque \| -13 \| -6\.5 \| Nm \|/);
  } finally { neg.uninstall(); }
  const y = start({ inputAnswers: ['ZZZ#00'] });
  try {
    await y.run('canAtlas.decodeFrame');
    assert.match(y.state.warningMessages[0].text, /not a hexadecimal number/);
    assert.equal(y.state.openedDocs.length, 0);
  } finally { y.uninstall(); }
  const z = start({ inputAnswers: ['7AA#00'] });
  try {
    await z.run('canAtlas.decodeFrame');
    assert.match(z.state.warningMessages[0].text, /no message with the ID 7AA/);
  } finally { z.uninstall(); }
});

test('Encode Signals writes the frame and offers to copy it', async () => {
  const x = start({ inputAnswers: ['EngineSpeed=3000; CoolantTemp=90'], quickPickAnswers: [(i) => /EngineStatus/.test(i.label)], buttonAnswers: ['Copy Frame'] });
  try {
    x.state.activeTextEditor.selection = new x.mock.vscode.Selection(0, 0, 0, 0);
    await x.run('canAtlas.encodeSignals');
    const out = lastOpened(x);
    assert.equal(out.uri.toString(), 'untitled:encoded-frame.md');
    // 3000 / 0.25 = 12000 = 0x2EE0, little-endian E0 2E; (90 + 40) = 130 = 0x82.
    assert.match(out.getText(), /100#E02E820000000000/);
    assert.equal(x.state.clipboard, '100#E02E820000000000');
  } finally { x.uninstall(); }
});

test('Show Bit Layout and Go To Message', async () => {
  const x = start({ quickPickAnswers: [(i) => /GearStatus/.test(i.label), (i) => /GearStatus/.test(i.label)] });
  try {
    await x.run('canAtlas.showBitLayout');
    const out = lastOpened(x);
    assert.equal(out.uri.toString(), 'untitled:bit-layout-GearStatus.md');
    assert.match(out.getText(), /Bit layout of GearStatus/);
    await x.mock.vscode.window.showTextDocument(dbcDoc(x));
    await x.run('canAtlas.goToMessage');
    const text = dbcDoc(x).getText();
    assert.equal(x.state.activeTextEditor.selection.start.line, dbcDoc(x).positionAt(text.indexOf('GearStatus')).line);
  } finally { x.uninstall(); }
});

test('samples open as invented DBC and trace files', async () => {
  const x = start();
  try {
    await x.run('canAtlas.openSampleProblems');
    let opened = lastOpened(x);
    assert.equal(opened.uri.toString(), 'untitled:sample-with-problems.dbc');
    assert.equal(opened.languageId, 'dbc');
    assert.equal(codesOf(opened.getText()).errors.length, 4);
    await x.run('canAtlas.openSample');
    opened = lastOpened(x);
    assert.equal(opened.uri.toString(), 'untitled:sample-vehicle.dbc');
    assert.deepEqual(codesOf(opened.getText()), { errors: [], warnings: [], notes: [] });
    await x.run('canAtlas.openSampleTrace');
    assert.equal(lastOpened(x).uri.toString(), 'untitled:sample-trace.log');
    await x.run('canAtlas.openSample');
    assert.equal(lastOpened(x).uri.toString(), 'untitled:sample-vehicle-2.dbc', 'a second sample gets its own name');
  } finally { x.uninstall(); }
});

test('commands on a file that is not a DBC file explain what they need and start no trial', async () => {
  const x = start({ active: NOTES });
  try {
    x.state.documents.find((d) => d.uri.toString() === NOTES).languageId = 'markdown';
    await x.run('canAtlas.decodeFrame');
    await x.run('canAtlas.checkFile');
    await x.run('canAtlas.compareFiles');
    await x.run('canAtlas.decodeTrace');
    assert.equal(x.state.warningMessages.length, 4);
    assert.match(x.state.warningMessages[0].text, /needs a DBC file in the active editor/);
    assert.ok(!x.context.globalMap.has('trial.startedAt'), 'no trial is started for a command that could not run');
  } finally { x.uninstall(); }
});

test('the first Pro command starts the trial; Compare lists breaking, non-breaking and cosmetic changes', async () => {
  const x = start({ quickPickAnswers: [(i) => /vehicle-v1/.test(i.label)] });
  try {
    await x.run('canAtlas.compareFiles');
    assert.match(x.state.infoMessages[0].text, /free 14-day trial of CAN Atlas Pro has started/);
    assert.ok(x.context.globalMap.has('trial.startedAt'));
    const tree = x.state.trees['canAtlas.diff'];
    const classes = tree.getChildren();
    const labels = classes.map((c) => tree.getTreeItem(c).label);
    assert.deepEqual(labels.map((l) => l.replace(/ \(\d+\)/, '')), ['BREAKING', 'NON-BREAKING', 'COSMETIC']);
    const breaking = tree.getChildren(classes[0]);
    assert.ok(breaking.length >= 1);
    assert.match(tree.getTreeItem(breaking[0]).tooltip, /^BREAKING: /);
    const note = x.state.infoMessages.find((m) => /compared with vehicle-v1\.dbc/.test(m.text));
    assert.ok(note, 'the summary names both files');
    await x.run('canAtlas.revealChange', 0);
    assert.ok(x.state.executed.some((e) => e.id === 'canAtlas.revealOffset'));
    await x.run('canAtlas.clearComparison');
    assert.deepEqual(tree.getChildren().map((c) => c.kind), []);
  } finally { x.uninstall(); }
});

test('Compare says "No differences" only for two files that describe the same database', async () => {
  const same = start({ trialDaysAgo: 1, files: { [VALID]: VALID_TEXT, [OLDER]: VALID_TEXT.replace(/\n/g, '\r\n') + '\n\n' }, quickPickAnswers: [(i) => /vehicle-v1/.test(i.label)] });
  try {
    await same.run('canAtlas.compareFiles');
    const tree = same.state.trees['canAtlas.diff'];
    const top = tree.getChildren();
    // The same content with other line ends and blank lines is not the same file: "No content differences", never "No differences".
    assert.equal(tree.getTreeItem(top[0]).label, 'No content differences');
    assert.match(tree.getTreeItem(top[0]).description, /only in how the content is written/);
    assert.match(same.state.infoMessages.find((m) => /compared with/.test(m.text)).text, /No differences in the database content\. The files differ only in how the same content is written/);
  } finally { same.uninstall(); }
  // Two files that are the same byte for byte: "No differences".
  const twin = start({ trialDaysAgo: 1, files: { [VALID]: VALID_TEXT, [OLDER]: VALID_TEXT }, quickPickAnswers: [(i) => /vehicle-v1/.test(i.label)] });
  try {
    await twin.run('canAtlas.compareFiles');
    const tree = twin.state.trees['canAtlas.diff'];
    assert.equal(tree.getTreeItem(tree.getChildren()[0]).label, 'No differences');
  } finally { twin.uninstall(); }
  // Two files that differ only in a statement that is read over (a signal group): not "No differences".
  const hidden = start({ trialDaysAgo: 1, files: { [VALID]: VALID_TEXT, [OLDER]: VALID_TEXT + 'SIG_GROUP_ 256 Group 1 : EngineSpeed;\n' }, quickPickAnswers: [(i) => /vehicle-v1/.test(i.label)] });
  try {
    await hidden.run('canAtlas.compareFiles');
    const tree = hidden.state.trees['canAtlas.diff'];
    const item = tree.getTreeItem(tree.getChildren()[0]);
    assert.equal(item.label, 'No differences in the compared statements');
    assert.match(item.description, /other statements differ/);
    assert.match(hidden.state.infoMessages.find((m) => /compared with/.test(m.text)).text, /No differences in the compared statements\. The files also differ in 1 statement that CAN Atlas does not compare or that have no effect on the database \(SIG_GROUP_\): 1 only in the older file, 0 only in the newer file\./);
  } finally { hidden.uninstall(); }
  const different = start({ trialDaysAgo: 1, files: { [VALID]: VALID_TEXT, [OLDER]: VALID_TEXT.replace('VERSION "1.4"', 'VERSION "1.3"') }, quickPickAnswers: [(i) => /vehicle-v1/.test(i.label)] });
  try {
    await different.run('canAtlas.compareFiles');
    const tree = different.state.trees['canAtlas.diff'];
    assert.notEqual(tree.getTreeItem(tree.getChildren()[0]).label, 'No differences');
  } finally { different.uninstall(); }
});

test('Export Comparison Report asks for a format and writes where the user chose', async () => {
  const target = M.Uri.parse('file:///work/report.md');
  const x = start({ trialDaysAgo: 1, quickPickAnswers: [(i) => /vehicle-v1/.test(i.label), 0], saveAnswers: [target] });
  try {
    await x.run('canAtlas.compareFiles');
    await x.run('canAtlas.exportComparison');
    const md = x.state.written.get('file:///work/report.md');
    assert.match(md, /^# DBC comparison/);
    assert.match(md, /## Breaking changes \(1\)/);
    assert.match(md, /vehicle-v1\.dbc/);
  } finally { x.uninstall(); }
  const y = start({ trialDaysAgo: 1 });
  try {
    await y.run('canAtlas.exportComparison');
    assert.match(y.state.warningMessages[0].text, /no comparison to export/);
    assert.equal(y.state.written.size, 0);
  } finally { y.uninstall(); }
});

test('Show Graphical Bit Layout opens a page without scripts and with a strict content security policy', async () => {
  const x = start({ trialDaysAgo: 1, quickPickAnswers: [(i) => /GearStatus/.test(i.label)] });
  try {
    await x.run('canAtlas.showBitLayoutGraphic');
    const panel = x.state.panels[0];
    assert.equal(panel.options.enableScripts, false);
    assert.deepEqual(panel.options.localResourceRoots, []);
    assert.match(panel.webview.html, /Content-Security-Policy" content="default-src 'none'; style-src 'nonce-[0-9a-f]{32}'"/);
    assert.ok(!/<script/i.test(panel.webview.html));
    assert.match(panel.webview.html, /GearStatus/);
  } finally { x.uninstall(); }
});

test('Decode Trace With This DBC decodes an open trace, filters it and exports it', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'can atlas ü☃ '));
  const csvPath = path.join(folder, 'decoded.csv');
  const x = start({ trialDaysAgo: 1, quickPickAnswers: [(i) => /trace\.log/.test(i.label)], saveAnswers: [M.Uri.file(csvPath)] });
  try {
    await x.run('canAtlas.decodeTrace');
    const panel = x.state.panels[0];
    assert.equal(panel.options.enableScripts, true);
    assert.deepEqual(panel.options.localResourceRoots, []);
    const m = /Content-Security-Policy" content="default-src 'none'; style-src 'nonce-([^']+)'; script-src 'nonce-([^']+)'"/.exec(panel.webview.html);
    assert.ok(m && m[1] === m[2], 'styles and the one script run by nonce only');
    assert.equal((panel.webview.html.match(/<script/g) || []).length, 1);
    const expectedFrames = samples.TRACE_FRAMES.length;
    assert.match(x.state.infoMessages.pop().text, new RegExp('^CAN Atlas: ' + expectedFrames + ' frames read, '));
    assert.match(panel.webview.html, /EngineStatus/);
    // A filter from the page re-renders it; a wrong time is explained and nothing is decoded again.
    const before = x.state.progressTitles.length;
    await panel.send({ type: 'filter', filter: { text: '', message: 'GearStatus', from: '', to: '', channel: '' } });
    assert.ok(x.state.progressTitles.length > before);
    assert.match(panel.webview.html, /GearSelected/);
    const afterGood = x.state.progressTitles.length;
    await panel.send({ type: 'filter', filter: { from: 'abc' } });
    assert.equal(x.state.progressTitles.length, afterGood);
    assert.match(panel.webview.html, /not a number of seconds/);
    // Messages that are not from the page's two kinds are ignored.
    await panel.send({ type: 'other' });
    await panel.send(null);
    await panel.send({ type: 'export', format: 'exe' });
    assert.equal(x.state.written.size, 0);
    assert.equal(fs.existsSync(csvPath), false);
    await panel.send({ type: 'export', format: 'csv' });
    // The file is written straight to disk (in blocks), so a trace of any size keeps memory flat.
    const csv = fs.readFileSync(csvPath, 'utf8');
    assert.match(csv, /^time,channel,message,id,signal,raw,physical,unit,description\r\n/);
    // The export follows the filter that is on the page (GearStatus only). Frame 120#20093D4B:
    // GearSelected 2 (Neutral), speed 0x093D = 2365 raw = 23.65 km/h, GearboxTemp 0x4B = 75 raw = 35 degC.
    assert.match(csv, /\r\n1762944000\.002000,can0,GearStatus,0x120,GearSelected,2,2,,Neutral\r\n/);
    assert.match(csv, /\r\n1762944000\.002000,can0,GearStatus,0x120,VehicleSpeed,2365,23\.65,km\/h,\r\n/);
    assert.match(csv, /\r\n1762944000\.002000,can0,GearStatus,0x120,GearboxTemp,75,35,degC,\r\n/);
    assert.ok(!/EngineStatus/.test(csv));
  } finally { x.uninstall(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test('Decode Trace explains a file it cannot read', async () => {
  const x = start({ trialDaysAgo: 1, files: { [VALID]: VALID_TEXT, [TRACE]: 'this is not a trace\njust text\n' }, quickPickAnswers: [(i) => /trace\.log/.test(i.label)] });
  try {
    await x.run('canAtlas.decodeTrace');
    assert.equal(x.state.panels.length, 0);
    assert.match(x.state.warningMessages[0].text, /No frames could be read from trace\.log/);
    assert.match(x.state.warningMessages[0].text, /candump -L/);
  } finally { x.uninstall(); }
});

test('Decode Trace offers the three layouts when the automatic detection finds no frame, and uses the one chosen', async () => {
  // 150 note lines in front of a candump log: the detection looks at the first 100 lines only.
  const text = 'note line\n'.repeat(150) + samples.sampleFor('trace').text;
  const x = start({ trialDaysAgo: 1, files: { [VALID]: VALID_TEXT, [TRACE]: text }, quickPickAnswers: [(i) => /trace\.log/.test(i.label), (i) => i.format === 'candump'] });
  try {
    await x.run('canAtlas.decodeTrace');
    const offered = x.state.quickPickLists[1];
    assert.deepEqual(offered.items.map((i) => i.format), ['candump', 'csv', 'asc']);
    assert.match(offered.options.placeHolder, /^No frames could be read from trace\.log with the automatic layout detection/);
    assert.equal(x.state.panels.length, 1);
    assert.match(x.state.infoMessages.pop().text, new RegExp('^CAN Atlas: ' + samples.TRACE_FRAMES.length + ' frames read'));
    assert.equal(x.state.warningMessages.length, 0);
  } finally { x.uninstall(); }
});

test('Export Decoded Trace: statistics are saved as Markdown, HTML and CSV', async () => {
  const x = start({ trialDaysAgo: 1, quickPickAnswers: [(i) => /trace\.log/.test(i.label), (i) => i.id === 'stats-md'], saveAnswers: [M.Uri.parse('file:///work/stats.md')] });
  try {
    await x.run('canAtlas.exportTrace');
    const md = x.state.written.get('file:///work/stats.md');
    assert.match(md, /EngineSpeed/);
    assert.match(md, /Frequency|frequency/);
  } finally { x.uninstall(); }
  const y = start({ trialDaysAgo: 1, quickPickAnswers: [(i) => /trace\.log/.test(i.label), (i) => i.id === 'stats-signals'], saveAnswers: [M.Uri.parse('file:///work/stats.csv')] });
  try {
    await y.run('canAtlas.exportTrace');
    assert.match(y.state.written.get('file:///work/stats.csv'), /^Message,ID,Signal,Unit,Values,Minimum,Maximum,Mean/);
  } finally { y.uninstall(); }
});

test('Create DBC Documentation writes Markdown into an editor and HTML into a chosen file', async () => {
  const x = start({ trialDaysAgo: 1, quickPickAnswers: [0] });
  try {
    await x.run('canAtlas.createDocumentation');
    const md = lastOpened(x);
    assert.equal(md.uri.toString(), 'untitled:vehicle-documentation.md');
    assert.match(md.getText(), /EngineStatus/);
  } finally { x.uninstall(); }
  const y = start({ trialDaysAgo: 1, quickPickAnswers: [1], saveAnswers: [M.Uri.parse('file:///work/doc.html')] });
  try {
    await y.run('canAtlas.createDocumentation');
    const html = y.state.written.get('file:///work/doc.html');
    assert.match(html, /^<!DOCTYPE html>/);
    assert.ok(!/<script/i.test(html));
  } finally { y.uninstall(); }
});

test('Export Signals As CSV and Create DBC From Signal CSV make a round trip', async () => {
  const x = start({ trialDaysAgo: 1, saveAnswers: [M.Uri.parse('file:///work/vehicle-signals.csv')] });
  let csv;
  try {
    await x.run('canAtlas.exportSignalsCsv');
    csv = x.state.written.get('file:///work/vehicle-signals.csv');
    assert.match(csv, /^message_id,extended,message,dlc,/);
    assert.equal(csv.split('\r\n').filter(Boolean).length - 1, 30, 'one row per signal');
  } finally { x.uninstall(); }
  const y = start({ trialDaysAgo: 1, files: { 'file:///work/in.csv': csv }, dialogAnswers: [[M.Uri.parse('file:///work/in.csv')]] });
  try {
    await y.run('canAtlas.importSignalsCsv');
    const made = lastOpened(y);
    assert.equal(made.uri.toString(), 'untitled:in.dbc');
    assert.equal(made.languageId, 'dbc');
    assert.match(y.state.infoMessages.pop().text, /created a DBC file with \d+ messages and 30 signals/);
    assert.deepEqual(codesOf(made.getText()).errors, []);
  } finally { y.uninstall(); }
});

test('Create DBC From Signal CSV explains a table without messages', async () => {
  const x = start({ trialDaysAgo: 1, files: { 'file:///work/bad.csv': 'nothing,useful\n1,2\n' }, dialogAnswers: [[M.Uri.parse('file:///work/bad.csv')]] });
  try {
    await x.run('canAtlas.importSignalsCsv');
    assert.match(x.state.warningMessages[0].text, /No message could be created from the table/);
    assert.equal(x.state.openedDocs.length, 0);
  } finally { x.uninstall(); }
});

test('Create Workspace DBC Inventory reads the DBC files of the folder and reports collisions', async () => {
  const x = start({ trialDaysAgo: 1, active: undefined, quickPickAnswers: [0] });
  try {
    await x.run('canAtlas.inventory');
    assert.ok(x.state.findFilesCalls.length === 1);
    assert.equal(x.state.findFilesCalls[0].pattern.pattern, '**/*.dbc');
    const report = lastOpened(x);
    assert.equal(report.uri.toString(), 'untitled:dbc-inventory.md');
    assert.match(report.getText(), /vehicle\.dbc/);
    // The same IDs in vehicle.dbc and vehicle-v1.dbc are collisions between files.
    assert.match(x.state.quickPickLists[0].options.placeHolder, /[1-9]\d* collisions found/);
  } finally { x.uninstall(); }
});

test('every Pro command is gated: after the trial none of them opens or writes anything', async () => {
  const x = start({ trialDaysAgo: 30, quickPickAnswers: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], dialogAnswers: [[M.Uri.parse('file:///work/in.csv')]], saveAnswers: [M.Uri.parse('file:///work/x.out')] });
  try {
    const pro = pkg.contributes.commands.filter((c) => /\(Pro\)$/.test(c.title)).map((c) => c.command);
    assert.equal(pro.length, 9);
    for (const id of pro) await x.run(id);
    assert.equal(x.state.infoMessages.filter((m) => /is a Pro feature of CAN Atlas/.test(m.text)).length, 9);
    assert.equal(x.state.openedDocs.length, 0);
    assert.equal(x.state.written.size, 0);
    assert.equal(x.state.panels.length, 0);
    assert.equal(x.state.findFilesCalls.length, 0);
  } finally { x.uninstall(); }
});

test('after the trial a Pro command shows the Pro notice with the two ways forward', async () => {
  const x = start({ trialDaysAgo: 20 });
  try {
    await x.run('canAtlas.createDocumentation');
    const msg = x.state.infoMessages[0];
    assert.match(msg.text, /Create DBC Documentation is a Pro feature of CAN Atlas\. Your 14-day trial ended/);
    assert.deepEqual(msg.buttons, ['Buy Pro', 'Enter Licence Key']);
  } finally { x.uninstall(); }
});

test('Buy Pro: Business asks for the number of users and opens the checkout with that quantity', async () => {
  const config = require('../src/licence/config');
  const x = start({ quickPickAnswers: [1], inputAnswers: ['7'] });
  try {
    await x.run('canAtlas.buyPro');
    assert.deepEqual(x.state.opened, [config.buyUrlFor('live', 'business', 7)]);
    assert.match(x.state.opened[0], /\?quantity=7$/);
  } finally { x.uninstall(); }
  const y = start({ quickPickAnswers: [0] });
  try {
    await y.run('canAtlas.buyPro');
    assert.deepEqual(y.state.opened, [config.buyUrlFor('live', 'personal', 1)]);
    assert.match(y.state.opened[0], /\?quantity=1$/);
  } finally { y.uninstall(); }
  for (const bad of ['0', '101', '1.5', '-1', '1e2', '', 'abc']) {
    const z = start({ quickPickAnswers: [1], inputAnswers: [bad] });
    try {
      await z.run('canAtlas.buyPro');
      assert.deepEqual(z.state.opened, [], 'input ' + JSON.stringify(bad));
    } finally { z.uninstall(); }
  }
});

test('no way to the test licence server: not an installed copy, not a development host, not a variable or a setting', async () => {
  const config = require('../src/licence/config');
  const saved = process.env.CAN_ATLAS_LICENCE_MODE;
  process.env.CAN_ATLAS_LICENCE_MODE = 'test';
  try {
    for (const mode of [1, 2, 3]) {
      const x = start({ quickPickAnswers: [0], extensionMode: mode, config: { 'canAtlas.licenceMode': 'test' } });
      try {
        await x.run('canAtlas.buyPro');
        assert.deepEqual(x.state.opened, [config.buyUrlFor('live', 'personal', 1)], 'extension mode ' + mode + ' stays on the live checkout');
        assert.ok(x.state.opened[0].startsWith('https://checkout.dodopayments.com/buy/'));
      } finally { x.uninstall(); }
    }
  } finally {
    if (saved === undefined) delete process.env.CAN_ATLAS_LICENCE_MODE; else process.env.CAN_ATLAS_LICENCE_MODE = saved;
  }
});

test('Report A Problem copies no file names, values or keys and makes no licence request', async () => {
  const x = start({ config: { 'canAtlas.workspace.include': 'secret-folder/**/*.dbc' } });
  const realFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => { requests++; throw new Error('offline'); };
  try {
    await x.context.secrets.store('licence.key.live', 'SECRET-KEY-1234');
    x.context.globalMap.set('licence.instanceId.live', 'lki_1');
    x.context.globalMap.set('licence.productId.live', require('../src/licence/config').products.live.personal);
    await x.run('canAtlas.reportProblem');
    const block = x.state.clipboard;
    assert.match(block, /^CAN Atlas 0\.1\.0/);
    assert.match(block, /workspace\.include = customised/);
    assert.match(block, /Licence: Pro key stored \(personal\), next check due, licence server: live/);
    for (const bad of ['vehicle', 'EngineStatus', 'Gateway', 'SECRET', '1234', '/work/', 'secret-folder']) assert.ok(!block.includes(bad), bad);
    assert.equal(requests, 0);
    assert.deepEqual(x.state.opened, ['https://github.com/small-steps-studio/can-atlas/issues']);
  } finally { global.fetch = realFetch; x.uninstall(); }
});

test('Enter Licence Key asks for the key in a masked input; without network nothing is stored', async () => {
  const x = start({ inputAnswers: ['ABC-DEF'] });
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('offline'); };
  try {
    await x.run('canAtlas.enterKey');
    assert.equal(x.state.inputOptions[0].password, true);
    assert.match(x.state.errorMessages[0].text, /could not be reached/);
    assert.equal(x.context.secretsMap.size, 0);
  } finally { global.fetch = realFetch; x.uninstall(); }
});

test('Remove Licence without a key says so and asks nothing', async () => {
  const x = start();
  try {
    await x.run('canAtlas.removeLicence');
    assert.match(x.state.infoMessages[0].text, /No licence key is stored/);
    assert.equal(x.state.warningMessages.length, 0);
  } finally { x.uninstall(); }
});

test('Show Licence Status names the trial and the way to buy', async () => {
  const x = start({ trialDaysAgo: 2 });
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('offline'); };
  try {
    await x.run('canAtlas.licenceStatus');
    assert.match(x.state.infoMessages[0].text, /trial/i);
    assert.deepEqual(x.state.infoMessages[0].buttons, ['Buy Pro', 'Enter Licence Key', 'Lost your key?']);
  } finally { global.fetch = realFetch; x.uninstall(); }
});

test('Show Documentation opens the public page; the walkthrough command asks the editor to open it', async () => {
  const x = start();
  try {
    await x.run('canAtlas.showDocumentation');
    assert.deepEqual(x.state.opened, ['https://github.com/small-steps-studio/can-atlas#readme']);
    await x.run('canAtlas.openWalkthrough');
    const call = x.state.executed.find((e) => e.id === 'workbench.action.openWalkthrough');
    assert.equal(call.args[0], 'SmallStepsStudio.can-atlas#canAtlas.gettingStarted');
    // The id the command opens is the id of the walkthrough in the manifest.
    assert.ok(pkg.contributes.walkthroughs.some((w) => 'SmallStepsStudio.' + pkg.name + '#' + w.id === call.args[0]));
  } finally { x.uninstall(); }
});

test('a failure inside a command shows a plain message, never a stack trace', async () => {
  const x = start({ trialDaysAgo: 1, files: { [VALID]: VALID_TEXT }, dialogAnswers: [[M.Uri.parse('file:///work/missing.csv')]] });
  try {
    await x.run('canAtlas.importSignalsCsv');
    const msg = x.state.errorMessages[0].text;
    assert.match(msg, /^CAN Atlas: /);
    assert.match(msg, /Report A Problem/);
    assert.ok(!/\bat \w+.*\(.*:\d+:\d+\)/.test(msg), 'no stack trace');
  } finally { x.uninstall(); }
});

test('a setting change is picked up without a restart', async () => {
  const x = start();
  try {
    await wait(600);
    assert.deepEqual(x.state.diagnostics.get(BROKEN).length > 0, true);
    x.state.config['canAtlas.problems.disabledCodes'] = ['DBC-SIGNAL-OVERLAP', 'DBC-RECEIVER-UNKNOWN', 'DBC-MESSAGE-ID-DUPLICATE', 'DBC-RANGE-INVERTED', 'DBC-SIGNAL-OUTSIDE-FRAME', 'DBC-MESSAGE-EXTENDED-FLAG'];
    x.state.emit('config', { affectsConfiguration: (s) => s === 'canAtlas' });
    await wait(700);
    assert.deepEqual(x.state.diagnostics.get(BROKEN), []);
  } finally { x.uninstall(); }
});
