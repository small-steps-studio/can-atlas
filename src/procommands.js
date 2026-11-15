'use strict';
// Pro commands: compare two DBC files, graphical bit layout, trace decode and export,
// documentation, signal lists as CSV and back, workspace inventory. Every command checks the
// licence or the trial first (requirePro) and writes files only after the user chose where.

const nodeFs = require('node:fs');
const crypto = require('node:crypto');
const P = require('./dbc/parse');
const O = require('./dbc/outline');
const U = require('./util');

// The Pro modules are loaded when first used, which keeps start-up light.
function loadPro(name) {
  switch (name) {
    case 'diff': return require('./pro/diff');
    case 'diffreport': return require('./pro/diffreport');
    case 'graphic': return require('./pro/graphic');
    case 'docgen': return require('./pro/docgen');
    case 'csvdbc': return require('./pro/csvdbc');
    case 'inventory': return require('./pro/inventory');
    case 'run': return require('./trace/run');
    case 'export': return require('./trace/export');
    case 'view': return require('./trace/view');
    default: throw new Error('unknown module ' + name);
  }
}

const MAX_DBC_BYTES = 48 * 1024 * 1024;
// A parsed file takes about twelve times its text in memory, and Compare holds two of them at once; the documentation and the
// signal table are built in memory as one text of two to five times the size of the database. These limits keep every command
// under a heap of 1 GB (test/regress.limits.test.js runs each of them at its limit under that heap).
const MAX_COMPARE_BYTES = 40 * 1024 * 1024;
const MAX_DOCUMENTATION_BYTES = 20 * 1024 * 1024;
const MAX_SIGNAL_TABLE_BYTES = 32 * 1024 * 1024;
const MAX_VIRTUAL_TRACE_BYTES = 64 * 1024 * 1024;
const MAX_INVENTORY_BYTES = 400 * 1024 * 1024;
const VIEW_DISPLAY_LIMIT = 20000;
const MAX_TREE_ITEMS = 2000;
const CLASS_ICON = { 'BREAKING': 'error', 'NON-BREAKING': 'pass', 'COSMETIC': 'info' };
const TRACE_LAYOUTS = [
  { label: 'candump -L log', description: '(timestamp) interface ID#DATA', format: 'candump' },
  { label: 'CSV with the columns time, id and data', description: 'comma, semicolon or tab separated', format: 'csv' },
  { label: 'Vector-style ASCII log', description: 'time channel ID Rx d length bytes', format: 'asc' }
];
const TRACE_FILTERS = { 'Trace files': ['log', 'asc', 'csv', 'txt', 'trc', 'candump'], 'All files': ['*'] };

function registerProCommands(app) {
  const vscode = app.vscode;
  const ui = app.ui;
  const before = ui.disposables.length;
  const reg = ui.reg;
  const info = ui.info;
  const warn = ui.warn;
  const NAME = ui.NAME;
  const requirePro = ui.requirePro;

  function neutralise() { return app.getSettings().neutraliseFormulas; }
  function nonce() { return crypto.randomBytes(16).toString('hex'); }
  function nameOf(document) { return ui.baseName(document.uri) + '.dbc'; }

  async function readBytes(uri, limit) {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat && typeof stat.size === 'number' && stat.size > limit) throw new Error('The file is larger than ' + Math.round(limit / 1048576) + ' MB, which is more than this command reads.');
    return vscode.workspace.fs.readFile(uri);
  }
  // The text of a DBC file and the fingerprint of its bytes (see Compare).
  async function readDbcFile(uri, limit) {
    const bytes = await readBytes(uri, limit || MAX_DBC_BYTES);
    return { text: U.decodeBytes(bytes).text, fingerprint: P.sourceFingerprint(bytes) };
  }
  // The fingerprint of the exact content of an open document for Compare: the bytes of the saved file when the editor has no
  // unsaved changes (so a byte order mark or other line ends count as differences), otherwise the text in the editor.
  async function documentFingerprint(doc) {
    if (doc.uri.scheme !== 'untitled' && !doc.isDirty) {
      try { return P.sourceFingerprint(await readBytes(doc.uri, MAX_DBC_BYTES)); } catch (e) { /* the text is used */ }
    }
    return P.sourceFingerprint(doc.getText());
  }
  // Refuses (with a message that says what to do) a file over the limit of a command that builds a large text in memory.
  function tooLargeForCommand(document, limit, command) {
    const length = app.lengthOf(document);
    if (length <= limit) return false;
    warn(NAME + ': "' + command + '" reads DBC files of up to ' + megabytes(limit) + ' MB, because it builds its result in memory; this file is ' + megabytes(length) + ' MB. Split the database into several files.');
    return true;
  }
  function megabytes(n) { return String(n < 10485760 ? Math.round(n / 104857.6) / 10 : Math.round(n / 1048576)); }

  async function saveText(defaultName, filters, content) {
    const folders = vscode.workspace.workspaceFolders;
    const defaultUri = folders && folders.length ? vscode.Uri.joinPath(folders[0].uri, defaultName) : undefined;
    const uri = await vscode.window.showSaveDialog({ defaultUri: defaultUri, filters: filters, saveLabel: 'Save', title: NAME + ': save ' + defaultName });
    if (!uri) return null;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    info(NAME + ': saved ' + uri.path.slice(uri.path.lastIndexOf('/') + 1) + '.', 'Open').then(function (pick) {
      if (pick === 'Open') vscode.commands.executeCommand('vscode.open', uri);
    }, function () { /* closed */ });
    return uri;
  }

  async function pickMessage(editor, db, placeHolder) {
    const here = require('./dbc/describe').messageAt(db, editor.document.offsetAt(editor.selection.active));
    if (here) return here;
    const items = O.messageItems(db);
    if (!items.length) { warn('This file has no messages.'); return null; }
    const pick = await vscode.window.showQuickPick(items.slice(0, 20000), { placeHolder: placeHolder, matchOnDescription: true, matchOnDetail: true });
    return pick ? pick.message : null;
  }

  // ---- compare two DBC files ---------------------------------------------------------------------
  const diffEmitter = new vscode.EventEmitter();
  let diffState = null;
  const diffProvider = {
    onDidChangeTreeData: diffEmitter.event,
    getChildren: function (n) {
      if (!diffState) return [];
      if (!n) {
        const out = [];
        for (const cls of ['BREAKING', 'NON-BREAKING', 'COSMETIC']) {
          const items = [];
          diffState.result.changes.forEach(function (c, i) { if (c.class === cls) items.push({ kind: 'change', change: c, index: i }); });
          if (items.length) out.push({ kind: 'class', cls: cls, items: items });
        }
        if (!out.length) out.push({ kind: 'none', sameKind: diffState.result.summary.kind || (diffState.result.summary.identical === false ? 'statements' : 'identical') });
        return out;
      }
      if (n.kind === 'class') {
        const shown = n.items.slice(0, MAX_TREE_ITEMS);
        if (n.items.length > MAX_TREE_ITEMS) shown.push({ kind: 'more', count: n.items.length - MAX_TREE_ITEMS });
        return shown;
      }
      return [];
    },
    getTreeItem: function (n) {
      if (n.kind === 'none') {
        const labels = {
          identical: ['No differences', 'the two files are the same'],
          formatting: ['No content differences', 'the files differ only in how the content is written (spacing, line ends, number spelling, order of list entries)'],
          statements: ['No differences in the compared statements', 'other statements differ; see the message']
        };
        const l = labels[n.sameKind] || labels.statements;
        const i = new vscode.TreeItem(l[0], vscode.TreeItemCollapsibleState.None);
        i.description = l[1];
        i.iconPath = new vscode.ThemeIcon('pass');
        return i;
      }
      if (n.kind === 'more') { const i = new vscode.TreeItem('and ' + n.count + ' more', vscode.TreeItemCollapsibleState.None); i.description = 'export the report to see all of them'; return i; }
      if (n.kind === 'class') {
        const item = new vscode.TreeItem(n.cls + ' (' + n.items.length + ')', n.cls === 'BREAKING' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon(CLASS_ICON[n.cls]);
        item.contextValue = 'canAtlas.diffClass';
        return item;
      }
      const c = n.change;
      const item = new vscode.TreeItem(c.text, vscode.TreeItemCollapsibleState.None);
      item.description = [c.message, c.signal].filter(Boolean).join(' / ');
      item.tooltip = c.class + ': ' + c.text;
      item.iconPath = new vscode.ThemeIcon(CLASS_ICON[c.class] || 'circle-outline');
      item.command = { command: 'canAtlas.revealChange', title: 'Reveal', arguments: [n.index] };
      return item;
    }
  };
  ui.disposables.push(vscode.window.createTreeView('canAtlas.diff', { treeDataProvider: diffProvider, showCollapseAll: true }), diffEmitter);

  async function chooseOtherDbc(editor, limit) {
    const items = [];
    for (const d of vscode.workspace.textDocuments) {
      if (d === editor.document || !app.isDbcDocument(d) || (d.uri.scheme !== 'file' && d.uri.scheme !== 'untitled')) continue;
      items.push({ label: '$(file) ' + ui.baseName(d.uri) + '.dbc', description: 'open editor', doc: d });
      if (items.length >= 10) break;
    }
    items.push({ label: '$(folder-opened) Choose a file...', browse: true });
    const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { placeHolder: 'The DBC file to compare with (the older version)' });
    if (!pick) return null;
    if (pick.doc) {
      const length = app.lengthOf(pick.doc);
      if (length > limit) return { tooLarge: length };
      return { uri: pick.doc.uri, text: pick.doc.getText(), name: ui.baseName(pick.doc.uri) + '.dbc', fingerprint: await documentFingerprint(pick.doc) };
    }
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Compare with this file', filters: { 'DBC files': ['dbc'], 'All files': ['*'] }, title: NAME + ': the older version of this DBC file' });
    if (!files || !files.length) return null;
    try {
      const file = await readDbcFile(files[0], limit);
      return { uri: files[0], text: file.text, name: ui.baseName(files[0]) + '.dbc', fingerprint: file.fingerprint };
    } catch (e) {
      let size = 0;
      try { size = (await vscode.workspace.fs.stat(files[0])).size; } catch (e2) { /* the first error is reported */ }
      if (typeof size === 'number' && size > limit) return { tooLarge: size };
      throw e;
    }
  }

  reg('canAtlas.compareFiles', async function () {
    const editor = ui.dbcEditor();
    if (!editor) return;
    if (!(await requirePro('Compare DBC With Another File'))) return;
    const newLength = app.lengthOf(editor.document);
    const tooLarge = function (oldLength) {
      warn(NAME + ': Compare reads at most ' + megabytes(MAX_COMPARE_BYTES) + ' MB of DBC text in total, because both files are held in memory at the same time, each about twelve times its size. ' +
        (oldLength ? 'This file is ' + megabytes(newLength) + ' MB and the other file is ' + megabytes(oldLength) + ' MB.' : 'This file alone is ' + megabytes(newLength) + ' MB.') + ' Split the database into several files, or compare smaller files.');
    };
    if (newLength > MAX_COMPARE_BYTES) { tooLarge(0); return; }
    const other = await chooseOtherDbc(editor, MAX_COMPARE_BYTES - newLength);
    if (!other) return;
    if (other.tooLarge) { tooLarge(other.tooLarge); return; }
    const diff = loadPro('diff');
    const oldDb = P.parseDbc(other.text);
    const newDb = app.parsedOf(editor.document, true);
    const result = diff.diffDatabases(oldDb, newDb, { oldFingerprint: other.fingerprint, newFingerprint: await documentFingerprint(editor.document) });
    diffState = { result: result, oldName: other.name, newName: nameOf(editor.document), oldUri: other.uri, newUri: editor.document.uri };
    diffEmitter.fire(undefined);
    await vscode.commands.executeCommand('canAtlas.diff.focus').then(undefined, function () { /* the view is not available in this window */ });
    info(NAME + ': ' + diffState.newName + ' compared with ' + diffState.oldName + ' (the older version): ' + result.summary.text + (result.notes && result.notes.length ? ' ' + result.notes.join(' ') : ''));
  });

  reg('canAtlas.revealChange', async function (index) {
    if (!diffState) return;
    const c = diffState.result.changes[Number(index)];
    if (!c) return;
    const useNew = typeof c.newOffset === 'number' && c.newOffset >= 0;
    const uri = useNew ? diffState.newUri : diffState.oldUri;
    const offset = useNew ? c.newOffset : c.oldOffset;
    if (!uri || typeof offset !== 'number' || offset < 0) return;
    await vscode.commands.executeCommand('canAtlas.revealOffset', uri.toString(), offset);
  });

  reg('canAtlas.clearComparison', function () { diffState = null; diffEmitter.fire(undefined); });

  reg('canAtlas.exportComparison', async function () {
    if (!(await requirePro('Export Comparison Report'))) return;
    if (!diffState) { warn('There is no comparison to export. Run "' + NAME + ': Compare DBC With Another File (Pro)" first.'); return; }
    const pick = await vscode.window.showQuickPick([
      { label: 'Markdown', ext: 'md', detail: 'A table of the changes grouped by class.' },
      { label: 'HTML', ext: 'html', detail: 'One page without scripts; open it in a browser.' },
      { label: 'CSV', ext: 'csv', detail: 'One row per change, for a spreadsheet.' }
    ], { placeHolder: 'Report format' });
    if (!pick) return;
    const rep = loadPro('diffreport');
    const meta = { oldName: diffState.oldName, newName: diffState.newName };
    const content = pick.ext === 'md' ? rep.diffMarkdown(diffState.result, meta) : pick.ext === 'html' ? rep.diffHtml(diffState.result, meta) : rep.diffCsv(diffState.result, meta, { neutralise: neutralise() });
    const filters = {}; filters[pick.label] = [pick.ext];
    await saveText('dbc-comparison.' + pick.ext, filters, content);
  });

  // ---- graphical bit layout ---------------------------------------------------------------------
  reg('canAtlas.showBitLayoutGraphic', async function () {
    const editor = ui.dbcEditor();
    if (!editor) return;
    if (!(await requirePro('Show Graphical Bit Layout'))) return;
    const db = app.parsedOf(editor.document, true);
    const message = await pickMessage(editor, db, 'Message to draw');
    if (!message) return;
    const panel = vscode.window.createWebviewPanel('canAtlas.layout', 'Bit layout: ' + message.name, vscode.ViewColumn.Beside, { enableScripts: false, localResourceRoots: [] });
    panel.webview.html = loadPro('graphic').layoutHtml(db, message, { nonce: nonce(), title: 'Bit layout of ' + message.name, cspSource: panel.webview.cspSource });
  });

  // ---- trace decode -----------------------------------------------------------------------------
  async function chooseTrace() {
    const items = [];
    for (const d of vscode.workspace.textDocuments) {
      if (app.isDbcDocument(d) || (d.uri.scheme !== 'file' && d.uri.scheme !== 'untitled') || d.lineCount < 1) continue;
      items.push({ label: '$(file) ' + (d.uri.path.slice(d.uri.path.lastIndexOf('/') + 1) || 'untitled'), description: 'open editor', doc: d });
      if (items.length >= 8) break;
    }
    items.push({ label: '$(folder-opened) Choose a trace file...', browse: true });
    const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { placeHolder: 'The trace to decode (candump log, CSV or Vector-style ASCII log)' });
    if (!pick) return null;
    if (pick.doc) {
      const label = pick.doc.uri.path.slice(pick.doc.uri.path.lastIndexOf('/') + 1) || 'untitled';
      return { source: { kind: 'text', text: pick.doc.getText(), name: label }, name: label };
    }
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Decode this trace', filters: TRACE_FILTERS, title: NAME + ': trace file' });
    if (!files || !files.length) return null;
    const uri = files[0];
    const label = uri.path.slice(uri.path.lastIndexOf('/') + 1);
    if (uri.scheme === 'file') return { source: { kind: 'file', path: uri.fsPath }, name: label };
    const bytes = await readBytes(uri, MAX_VIRTUAL_TRACE_BYTES);
    return { source: { kind: 'bytes', bytes: bytes, name: label }, name: label };
  }

  // Runs decodeTrace with a progress notice that can be cancelled.
  function runDecode(source, db, options, title) {
    const run = loadPro('run');
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: NAME + ': ' + title, cancellable: true }, function (progress, token) {
      const ac = new AbortController();
      token.onCancellationRequested(function () { ac.abort(); });
      let last = 0;
      return run.decodeTrace(source, db, Object.assign({}, options, {
        signal: ac.signal,
        onProgress: function (fraction) {
          if (typeof fraction === 'number' && fraction > last) { progress.report({ increment: (fraction - last) * 100, message: Math.round(fraction * 100) + ' %' }); last = fraction; }
        }
      }));
    });
  }

  function traceSummary(res) {
    const c = res.counters || {};
    return (c.frames || 0) + ' frames read, ' + (c.decodedFrames || 0) + ' of messages in the DBC' + (res.cancelled ? ' (cancelled: the figures cover the part that was read)' : '');
  }

  // A buffered writer to a file: blocks of up to 1 MB are written synchronously, so memory stays flat.
  function createFileSink(path) {
    const fd = nodeFs.openSync(path, 'w');
    let buffer = [];
    let size = 0;
    return {
      write: function (text) { buffer.push(text); size += text.length; if (size >= 1048576) { nodeFs.writeSync(fd, buffer.join('')); buffer = []; size = 0; } },
      close: function () { try { if (size) nodeFs.writeSync(fd, buffer.join('')); } finally { nodeFs.closeSync(fd); } }
    };
  }
  function createMemorySink() {
    const parts = [];
    return { write: function (text) { parts.push(text); }, close: function () {}, text: function () { return parts.join(''); } };
  }

  async function exportRows(trace, db, format, filter, channel) {
    const X = loadPro('export');
    const filters = {}; filters[format === 'json' ? 'JSON' : 'CSV'] = [format];
    const folders = vscode.workspace.workspaceFolders;
    const defaultUri = folders && folders.length ? vscode.Uri.joinPath(folders[0].uri, 'decoded-trace.' + format) : undefined;
    const target = await vscode.window.showSaveDialog({ defaultUri: defaultUri, filters: filters, saveLabel: 'Export', title: NAME + ': export the decoded trace' });
    if (!target) return;
    const local = target.scheme === 'file';
    const sink = local ? createFileSink(target.fsPath) : createMemorySink();
    let res;
    try {
      const writer = format === 'json' ? X.createJsonWriter(sink.write) : X.createCsvWriter(sink.write, { neutralise: neutralise() });
      writer.begin();
      res = await runDecode(trace.source, db, { format: trace.format || 'auto', filter: filter, channel: channel, maxRows: 0, sink: function (row) { writer.row(row); } }, 'exporting the decoded trace');
      writer.end();
    } finally { sink.close(); }
    if (!local) await vscode.workspace.fs.writeFile(target, Buffer.from(sink.text(), 'utf8'));
    info(NAME + ': exported ' + res.totalMatching + ' rows (' + traceSummary(res) + ').', 'Open').then(function (pick) { if (pick === 'Open') vscode.commands.executeCommand('vscode.open', target); }, function () { /* closed */ });
  }

  reg('canAtlas.decodeTrace', async function () {
    const editor = ui.dbcEditor();
    if (!editor) return;
    if (!(await requirePro('Decode Trace With This DBC'))) return;
    const db = app.parsedOf(editor.document, true);
    const trace = await chooseTrace();
    if (!trace) return;
    const view = loadPro('view');
    const settings = app.getSettings();
    const options = { format: 'auto', filter: {}, channel: null, maxRows: settings.traceMaxTableRows };
    let res = await runDecode(trace.source, db, options, 'decoding the trace');
    if ((!res.counters || !res.counters.frames) && trace.name) {
      // The layout was not recognised, or the file holds no frame in it: the user may name the layout.
      const layout = await vscode.window.showQuickPick(TRACE_LAYOUTS, { placeHolder: 'No frames could be read from ' + trace.name + ' with the automatic layout detection. Read it as:' });
      if (layout) {
        options.format = layout.format;
        res = await runDecode(trace.source, db, options, 'decoding the trace');
      }
    }
    trace.format = options.format;
    if (!res.counters || !res.counters.frames) {
      warn('No frames could be read from ' + trace.name + (res.warnings && res.warnings.length ? ': ' + res.warnings[0] : '') + '. The reader understands candump -L logs, CSV files with the columns time, id and data, and the message lines of Vector-style ASCII logs. Open "' + NAME + ': Open Sample Trace" to see the candump layout.');
      return;
    }
    const panel = vscode.window.createWebviewPanel('canAtlas.trace', 'Decoded trace: ' + trace.name, vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [] });
    let current = { filter: options.filter, channel: options.channel, errors: [] };
    let last = res;
    let busy = false;
    function render() {
      panel.webview.html = view.renderTraceView({
        title: 'Decoded trace: ' + trace.name, summary: last, stats: last.stats, rows: last.rows, filter: current.filter, channel: current.channel, truncated: last.truncated,
        totalMatching: last.totalMatching, nonce: nonce(), errors: current.errors, displayLimit: VIEW_DISPLAY_LIMIT
      });
    }
    render();
    panel.webview.onDidReceiveMessage(async function (msg) {
      if (busy || !msg || typeof msg !== 'object') return;
      busy = true;
      try {
        if (msg.type === 'filter') {
          const f = view.normaliseViewFilter(msg.filter);
          if (f.errors.length) { current = { filter: current.filter, channel: current.channel, errors: f.errors }; render(); return; }
          last = await runDecode(trace.source, db, { format: trace.format || 'auto', filter: f.filter, channel: f.channel, maxRows: settings.traceMaxTableRows }, 'applying the filter');
          current = { filter: f.filter, channel: f.channel, errors: [] };
          render();
        } else if (msg.type === 'export' && (msg.format === 'csv' || msg.format === 'json')) {
          await exportRows(trace, db, msg.format, current.filter, current.channel);
        }
      } catch (err) {
        warn(err && err.message ? err.message : 'The trace could not be processed.');
      } finally { busy = false; }
    }, undefined, ui.disposables);
    info(NAME + ': ' + traceSummary(res) + '. Time spans and statistics are in the Statistics and Messages tabs.');
  });

  reg('canAtlas.exportTrace', async function () {
    const editor = ui.dbcEditor();
    if (!editor) return;
    if (!(await requirePro('Export Decoded Trace'))) return;
    const db = app.parsedOf(editor.document, true);
    const trace = await chooseTrace();
    if (!trace) return;
    const pick = await vscode.window.showQuickPick([
      { label: 'Every decoded value as CSV', id: 'csv', detail: 'time, channel, message, id, signal, raw, physical, unit, description' },
      { label: 'Every decoded value as JSON', id: 'json', detail: 'One array, written row by row.' },
      { label: 'Statistics as Markdown', id: 'stats-md', detail: 'Minimum, maximum and mean per signal; frequency and jitter per message.' },
      { label: 'Statistics as HTML', id: 'stats-html', detail: 'The same as one page without scripts.' },
      { label: 'Statistics of the messages as CSV', id: 'stats-messages', detail: 'One row per message.' },
      { label: 'Statistics of the signals as CSV', id: 'stats-signals', detail: 'One row per signal.' }
    ], { placeHolder: 'What to export' });
    if (!pick) return;
    if (pick.id === 'csv' || pick.id === 'json') { await exportRows(trace, db, pick.id, {}, null); return; }
    const X = loadPro('export');
    const res = await runDecode(trace.source, db, { filter: {}, channel: null, maxRows: 0 }, 'reading the trace');
    const meta = { name: trace.name };
    if (pick.id === 'stats-md') await saveText('trace-statistics.md', { Markdown: ['md'] }, X.statsMarkdown(res.stats, meta));
    else if (pick.id === 'stats-html') await saveText('trace-statistics.html', { HTML: ['html'] }, X.statsHtml(res.stats, meta));
    else await saveText('trace-statistics-' + (pick.id === 'stats-messages' ? 'messages' : 'signals') + '.csv', { CSV: ['csv'] }, X.statsCsv(res.stats, pick.id === 'stats-messages' ? 'messages' : 'signals', { neutralise: neutralise() }));
  });

  // ---- documentation, signal lists, inventory -----------------------------------------------------
  reg('canAtlas.createDocumentation', async function () {
    const editor = ui.dbcEditor();
    if (!editor) return;
    if (!(await requirePro('Create DBC Documentation'))) return;
    if (tooLargeForCommand(editor.document, MAX_DOCUMENTATION_BYTES, 'Create DBC Documentation')) return;
    const db = app.parsedOf(editor.document, true);
    const pick = await vscode.window.showQuickPick([
      { label: 'Markdown', ext: 'md', detail: 'Opens in a new editor.' },
      { label: 'HTML', ext: 'html', detail: 'One page without scripts; saved to a file you choose.' }
    ], { placeHolder: 'Documentation format' });
    if (!pick) return;
    const docgen = loadPro('docgen');
    const meta = { name: nameOf(editor.document) };
    if (pick.ext === 'md') await ui.openText(docgen.documentationMarkdown(db, meta), 'markdown', ui.baseName(editor.document.uri) + '-documentation.md');
    else await saveText(ui.baseName(editor.document.uri) + '-documentation.html', { HTML: ['html'] }, docgen.documentationHtml(db, meta));
  });

  reg('canAtlas.exportSignalsCsv', async function () {
    const editor = ui.dbcEditor();
    if (!editor) return;
    if (!(await requirePro('Export Signals As CSV'))) return;
    if (tooLargeForCommand(editor.document, MAX_SIGNAL_TABLE_BYTES, 'Export Signals As CSV')) return;
    const db = app.parsedOf(editor.document, true);
    await saveText(ui.baseName(editor.document.uri) + '-signals.csv', { CSV: ['csv'] }, loadPro('csvdbc').signalsToCsv(db, { neutralise: neutralise() }));
  });

  reg('canAtlas.importSignalsCsv', async function () {
    if (!(await requirePro('Create DBC From Signal CSV'))) return;
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Create DBC from this table', filters: { 'CSV files': ['csv', 'txt', 'tsv'], 'All files': ['*'] }, title: NAME + ': signal table' });
    if (!files || !files.length) return;
    const text = U.decodeBytes(await readBytes(files[0], MAX_DBC_BYTES)).text;
    const res = loadPro('csvdbc').csvToDbc(text, {});
    const refused = res.problems.filter(function (p) { return p.refused; }).length;
    if (!res.messages) {
      warn('No message could be created from the table. ' + (res.problems.length ? 'First problem: line ' + res.problems[0].line + ': ' + res.problems[0].message : 'The table has no rows.'));
      return;
    }
    await ui.openText(res.dbc, 'dbc', ui.baseName(files[0]) + '.dbc');
    if (res.problems.length) {
      const list = res.problems.slice(0, 200).map(function (p) { return '* line ' + p.line + (p.refused ? ' (row refused)' : ' (kept)') + ': ' + U.escapeMarkdown(p.message); }).join('\n');
      const pick = await info(NAME + ': created a DBC file with ' + res.messages + ' messages and ' + res.signals + ' signals; ' + refused + ' rows were refused and ' + (res.problems.length - refused) + ' notes were made.', 'Show List');
      if (pick === 'Show List') await ui.openText('# Signal table problems\n\n' + list + (res.problems.length > 200 ? '\n\n' + (res.problems.length - 200) + ' more are not listed.' : '') + '\n', 'markdown', 'signal-table-problems.md');
    } else info(NAME + ': created a DBC file with ' + res.messages + ' messages and ' + res.signals + ' signals from the table.');
  });

  reg('canAtlas.inventory', async function (folderUri) {
    if (!(await requirePro('Create Workspace DBC Inventory'))) return;
    let folder = folderUri && folderUri.scheme ? folderUri : null;
    if (!folder) {
      const folders = vscode.workspace.workspaceFolders || [];
      if (!folders.length) { warn('Open a folder first: the inventory reads the DBC files of a folder.'); return; }
      if (folders.length === 1) folder = folders[0].uri;
      else {
        const pick = await vscode.window.showQuickPick(folders.map(function (f) { return { label: f.name, uri: f.uri }; }), { placeHolder: 'Folder to read' });
        if (!pick) return;
        folder = pick.uri;
      }
    }
    const s = app.getSettings();
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, s.workspaceInclude), s.workspaceExclude, s.workspaceMaxFiles);
    if (!uris.length) { info(NAME + ': No files match "' + s.workspaceInclude + '" in this folder (setting canAtlas.workspace.include).'); return; }
    const files = [];
    let skipped = 0;
    let total = 0;
    uris.sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: NAME + ': reading DBC files' }, async function () {
      for (const uri of uris) {
        if (total > MAX_INVENTORY_BYTES) { skipped++; continue; }
        try {
          const bytes = await readBytes(uri, Math.max(1, s.maxFileSizeMB) * 1048576);
          total += bytes.length;
          files.push({ name: vscode.workspace.asRelativePath(uri, false), text: U.decodeBytes(bytes).text });
        } catch (e) { skipped++; }
      }
    });
    const inv = loadPro('inventory');
    const result = inv.inventoryFiles(files, {});
    const meta = { name: folder.path.slice(folder.path.lastIndexOf('/') + 1) || 'workspace' };
    const pick = await vscode.window.showQuickPick([
      { label: 'Markdown report', id: 'md', detail: 'Opens in a new editor.' },
      { label: 'HTML report', id: 'html', detail: 'One page without scripts; saved to a file you choose.' },
      { label: 'CSV: the files', id: 'csv-files', detail: 'One row per file.' },
      { label: 'CSV: the collisions between files', id: 'csv-collisions', detail: 'One row per collision.' }
    ], { placeHolder: files.length + ' files read' + (skipped ? ' (' + skipped + ' skipped: too large, unreadable or over the total limit)' : '') + '; ' + result.collisions.length + ' collisions found. Report format' });
    if (!pick) return;
    if (pick.id === 'md') await ui.openText(inv.inventoryMarkdown(result, meta, {}), 'markdown', 'dbc-inventory.md');
    else if (pick.id === 'html') await saveText('dbc-inventory.html', { HTML: ['html'] }, inv.inventoryHtml(result, meta, {}));
    else await saveText('dbc-inventory-' + (pick.id === 'csv-files' ? 'files' : 'collisions') + '.csv', { CSV: ['csv'] }, inv.inventoryCsv(result, meta, { table: pick.id === 'csv-files' ? 'files' : 'collisions', neutralise: neutralise() }));
  });

  return ui.disposables.slice(before);
}

module.exports = { registerProCommands: registerProCommands, LIMITS: { compare: MAX_COMPARE_BYTES, documentation: MAX_DOCUMENTATION_BYTES, signalTable: MAX_SIGNAL_TABLE_BYTES } };
