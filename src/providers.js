'use strict';
// Editor features of the free tier: problems, hover, go to definition, find references, document
// symbols, folding, the DBC Outline tree view and the status bar item.

const P = require('./dbc/parse');
const D = require('./dbc/describe');
const O = require('./dbc/outline');
const config = require('./licence/config');

const DEBOUNCE_MS = 400;
const TYPING_LIMIT = 2 * 1024 * 1024;

function rangeOf(vscode, document, start, end) {
  return new vscode.Range(document.positionAt(start), document.positionAt(Math.max(start, end)));
}

/**
 * Every place in the text that names the element found by describe.elementAt(): its definition
 * and the later statements that mention it. Returns [{ start, end }].
 */
function referencesOf(db, el) {
  const out = [];
  if (!el) return out;
  if (el.kind === 'message') {
    const m = el.message;
    out.push({ start: m.nameStart, end: m.nameEnd });
    for (const r of db.refs) if (r.kind === 'message' && r.rawId === m.rawId) out.push({ start: r.start, end: r.end });
  } else if (el.kind === 'signal') {
    const m = el.message;
    const s = el.signal;
    out.push({ start: s.nameStart, end: s.nameEnd });
    for (const r of db.refs) if (r.kind === 'signal' && r.rawId === m.rawId && r.name === s.name) out.push({ start: r.start, end: r.end });
  } else if (el.kind === 'node') {
    const name = el.name;
    const decl = db.nodeByName.get(name);
    if (decl) out.push({ start: decl.start, end: decl.end });
    for (const r of db.refs) if (r.kind === 'node' && r.name === name) out.push({ start: r.start, end: r.end });
    for (const m of db.messages) {
      if (m.sender === name && name !== P.NO_NODE) out.push({ start: m.senderStart, end: m.senderEnd });
      for (const s of m.signals) for (let k = 0; k < s.receivers.length; k++) if (s.receivers[k] === name) out.push({ start: s.receiverPos[2 * k], end: s.receiverPos[2 * k + 1] });
    }
    for (const t of db.transmitters) for (const n of t.nodes) if (n.name === name) out.push({ start: n.start, end: n.end });
  } else if (el.kind === 'valueTable') {
    out.push({ start: el.table.nameStart, end: el.table.nameEnd });
  }
  out.sort(function (a, b) { return a.start - b.start; });
  const seen = new Set();
  return out.filter(function (r) { const k = r.start + ':' + r.end; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---- problems -----------------------------------------------------------------------------------

function createDiagnostics(app) {
  const vscode = app.vscode;
  const collection = vscode.languages.createDiagnosticCollection('canAtlas');
  const timers = new Map();
  const summaries = new Map();
  const SEVERITY = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information };
  const listeners = [];

  function run(document, force) {
    const key = document.uri.toString();
    if (!app.isDbcDocument(document)) { collection.delete(document.uri); summaries.delete(key); return null; }
    if (!force && app.tooLarge(document)) {
      collection.delete(document.uri);
      const s = { skipped: 'size' };
      summaries.set(key, s);
      listeners.forEach(function (fn) { fn(document); });
      return s;
    }
    const db = app.parsedOf(document, true);
    const result = app.validateParsed(db);
    const diags = result.problems.map(function (p) {
      const d = new vscode.Diagnostic(rangeOf(vscode, document, p.start, p.end), p.message, SEVERITY[p.severity]);
      d.code = vscode.Uri && typeof vscode.Uri.parse === 'function' ? { value: p.code, target: vscode.Uri.parse(config.repositoryUrl + '/blob/HEAD/docs/problems.md#' + p.code.toLowerCase()) } : p.code;
      d.source = config.productName;
      return d;
    });
    collection.set(document.uri, diags);
    let signals = 0;
    let messages = 0;
    for (const m of db.messages) { if (!m.pseudo) messages++; signals += m.signals.length; }
    const summary = { counts: result.counts, messages: messages, signals: signals };
    summaries.set(key, summary);
    listeners.forEach(function (fn) { fn(document); });
    return summary;
  }

  function schedule(document) {
    const key = document.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(function () {
      timers.delete(key);
      try { run(document, false); } catch (e) { /* the document was closed meanwhile */ }
    }, DEBOUNCE_MS));
  }

  const subs = [
    collection,
    vscode.workspace.onDidOpenTextDocument(function (d) { if (app.isDbcDocument(d)) schedule(d); }),
    vscode.workspace.onDidSaveTextDocument(function (d) { if (app.isDbcDocument(d)) schedule(d); }),
    vscode.workspace.onDidChangeTextDocument(function (e) {
      if (!app.isDbcDocument(e.document)) return;
      if (app.getSettings().validateOnType && app.lengthOf(e.document) <= TYPING_LIMIT) schedule(e.document);
    }),
    vscode.workspace.onDidCloseTextDocument(function (d) { collection.delete(d.uri); summaries.delete(d.uri.toString()); })
  ];
  if (vscode.workspace.onDidChangeConfiguration) {
    subs.push(vscode.workspace.onDidChangeConfiguration(function (e) {
      if (e.affectsConfiguration && e.affectsConfiguration('canAtlas')) vscode.workspace.textDocuments.forEach(function (d) { if (app.isDbcDocument(d)) schedule(d); });
    }));
  }
  for (const d of vscode.workspace.textDocuments) if (app.isDbcDocument(d)) schedule(d);
  return {
    run: run,
    summaryOf: function (document) { return summaries.get(document.uri.toString()) || null; },
    onDidUpdate: function (fn) { listeners.push(fn); },
    dispose: function () { for (const t of timers.values()) clearTimeout(t); subs.forEach(function (s) { s.dispose(); }); }
  };
}

// ---- hover, definitions, references, symbols, folding -------------------------------------------

const SYMBOL_KIND = { nodes: 'Namespace', node: 'Object', message: 'Struct', signal: 'Field', valueTable: 'Enum' };

function registerLanguageFeatures(app) {
  const vscode = app.vscode;
  const selector = [{ language: 'dbc' }];
  const subs = [];

  function elementAtPosition(document, position) {
    if (app.tooLarge(document)) return null;
    const db = app.parsedOf(document);
    if (!db) return null;
    const el = D.elementAt(db, document.offsetAt(position));
    return el ? { db: db, el: el } : null;
  }

  subs.push(vscode.languages.registerHoverProvider(selector, {
    provideHover: function (document, position) {
      if (!app.getSettings().hoverEnabled) return null;
      const at = elementAtPosition(document, position);
      if (!at) return null;
      const text = D.hoverOf(at.db, at.el);
      if (!text) return null;
      const md = new vscode.MarkdownString(text);
      md.isTrusted = false;
      md.supportHtml = false;
      return new vscode.Hover(md, rangeOf(vscode, document, at.el.start, at.el.end));
    }
  }));
  subs.push(vscode.languages.registerDefinitionProvider(selector, {
    provideDefinition: function (document, position) {
      const at = elementAtPosition(document, position);
      if (!at) return null;
      const def = D.definitionOf(at.db, at.el);
      if (!def) return null;
      return new vscode.Location(document.uri, rangeOf(vscode, document, def.start, def.end));
    }
  }));
  subs.push(vscode.languages.registerReferenceProvider(selector, {
    provideReferences: function (document, position) {
      const at = elementAtPosition(document, position);
      if (!at) return [];
      return referencesOf(at.db, at.el).map(function (r) { return new vscode.Location(document.uri, rangeOf(vscode, document, r.start, r.end)); });
    }
  }));
  subs.push(vscode.languages.registerDocumentSymbolProvider(selector, {
    provideDocumentSymbols: function (document) {
      if (app.tooLarge(document)) return [];
      const db = app.parsedOf(document);
      if (!db) return [];
      const toSymbol = function (n) {
        const range = rangeOf(vscode, document, n.start, n.end);
        let sel = rangeOf(vscode, document, n.selStart, n.selEnd);
        if (!range.contains(sel)) sel = new vscode.Range(range.start, range.start);
        const sym = new vscode.DocumentSymbol(n.name, n.detail, vscode.SymbolKind[SYMBOL_KIND[n.kind] || 'Object'], range, sel);
        sym.children = n.children.map(toSymbol);
        return sym;
      };
      return O.symbols(db).map(toSymbol);
    }
  }, { label: config.productName }));
  if (vscode.languages.registerFoldingRangeProvider) {
    subs.push(vscode.languages.registerFoldingRangeProvider(selector, {
      provideFoldingRanges: function (document) {
        if (app.tooLarge(document)) return [];
        const db = app.parsedOf(document);
        if (!db) return [];
        const out = [];
        for (const m of db.messages) {
          if (m.signals.length < 2) continue;
          const a = document.positionAt(m.start).line;
          const b = document.positionAt(m.end).line;
          if (b > a) out.push(new vscode.FoldingRange(a, b));
          if (out.length >= 100000) break;
        }
        return out;
      }
    }));
  }
  return subs;
}

// ---- outline tree view --------------------------------------------------------------------------

const ICON = { messages: 'mail', nodes: 'server', valueTables: 'list-ordered', independent: 'warning', page: 'list-unordered', nodePage: 'list-unordered', valueTablePage: 'list-unordered',
  message: 'symbol-struct', signal: 'symbol-field', multiplexor: 'symbol-key', multiplexed: 'symbol-property', node: 'circuit-board', valueTable: 'symbol-enum' };

function createOutlineTree(app) {
  const vscode = app.vscode;
  const emitter = new vscode.EventEmitter();
  let roots = [];
  let current = null;
  let timer = null;

  function refresh() {
    const editor = vscode.window.activeTextEditor;
    const doc = editor ? editor.document : null;
    if (!doc || !app.isDbcDocument(doc)) {
      // A non-DBC editor (a result document, the terminal) keeps the outline of the last DBC file.
      if (!current || !vscode.workspace.textDocuments.some(function (d) { return d === current.document; })) { roots = []; current = null; }
      emitter.fire(undefined);
      return;
    }
    if (app.tooLarge(doc)) { roots = []; current = null; emitter.fire(undefined); return; }
    const db = app.parsedOf(doc);
    current = db ? { document: doc, db: db } : null;
    roots = db ? O.rootNodes(db) : [];
    emitter.fire(undefined);
  }
  function later() { clearTimeout(timer); timer = setTimeout(function () { try { refresh(); } catch (e) { /* closed meanwhile */ } }, 300); }

  const provider = {
    onDidChangeTreeData: emitter.event,
    getChildren: function (n) { if (!n) return roots; return current ? O.childrenOf(current.db, n) : []; },
    getTreeItem: function (n) {
      const state = !n.expandable ? vscode.TreeItemCollapsibleState.None
        : (n.kind === 'messages' && roots.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      const item = new vscode.TreeItem(n.label, state);
      item.description = n.detail;
      item.iconPath = new vscode.ThemeIcon(ICON[n.kind] || 'circle-outline');
      item.contextValue = 'canAtlas.' + n.kind;
      if (current && typeof n.offset === 'number') item.command = { command: 'canAtlas.revealOffset', title: 'Reveal', arguments: [current.document.uri.toString(), n.offset] };
      return item;
    }
  };
  const view = vscode.window.createTreeView('canAtlas.outline', { treeDataProvider: provider, showCollapseAll: true });
  const subs = [view, emitter, vscode.window.onDidChangeActiveTextEditor(later),
    vscode.workspace.onDidChangeTextDocument(function (e) { if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) later(); })];
  later();
  return { refresh: refresh, dispose: function () { clearTimeout(timer); subs.forEach(function (s) { s.dispose(); }); } };
}

// ---- status bar: counts and problems -----------------------------------------------------------

function createStatus(app) {
  const vscode = app.vscode;
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.name = config.productName;
  item.command = 'canAtlas.checkFile';
  let timer = null;

  function update() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !app.isDbcDocument(editor.document)) { item.hide(); return; }
    const doc = editor.document;
    const sum = app.diagnostics ? app.diagnostics.summaryOf(doc) : null;
    if (sum && sum.skipped === 'size') {
      item.text = '$(list-ordered) DBC: file over the size limit';
      item.tooltip = 'Larger than the canAtlas.maxFileSizeMB setting. Click to check it on demand.';
    } else if (sum && sum.counts) {
      item.text = '$(list-ordered) ' + sum.messages + ' message' + (sum.messages === 1 ? '' : 's') + ' · ' + sum.signals + ' signal' + (sum.signals === 1 ? '' : 's') +
        (sum.counts.error ? ' · $(error) ' + sum.counts.error : '') + (sum.counts.warning ? ' · $(warning) ' + sum.counts.warning : '');
      item.tooltip = 'Messages and signals of this DBC file with the number of problems. Click to check the file again.';
    } else { item.hide(); return; }
    item.show();
  }
  function later() { clearTimeout(timer); timer = setTimeout(function () { try { update(); } catch (e) { /* closed meanwhile */ } }, 150); }
  if (app.diagnostics) app.diagnostics.onDidUpdate(later);
  const subs = [item, vscode.window.onDidChangeActiveTextEditor(later)];
  update();
  return { update: update, dispose: function () { clearTimeout(timer); subs.forEach(function (s) { s.dispose(); }); } };
}

module.exports = { createDiagnostics: createDiagnostics, registerLanguageFeatures: registerLanguageFeatures, createOutlineTree: createOutlineTree, createStatus: createStatus, referencesOf: referencesOf, rangeOf: rangeOf };
