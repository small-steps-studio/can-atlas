'use strict';
// CAN Atlas entry point. Builds the shared `app` object and installs every part of the extension;
// a failure in one part does not take the others down.

const vscode = require('vscode');
const os = require('node:os');
const P = require('./dbc/parse');
const { validate } = require('./dbc/validate');
const { createLicence } = require('./licence/licence');
const providers = require('./providers');
const { registerCommands } = require('./commands');
const { registerProCommands } = require('./procommands');
const { DEFAULTS } = require('./settings');

function numberSetting(value, fallback, min, max) {
  const n = Number(value);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function stringSetting(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function activate(context) {
  let output = null;
  function log(text) {
    if (!output) output = vscode.window.createOutputChannel('CAN Atlas');
    output.appendLine(text);
  }

  let settingsCache = null;
  function getSettings() {
    if (settingsCache) return settingsCache;
    const c = vscode.workspace.getConfiguration('canAtlas');
    const disabled = c.get('problems.disabledCodes', []);
    settingsCache = {
      maxFileSizeMB: numberSetting(c.get('maxFileSizeMB', DEFAULTS.maxFileSizeMB), DEFAULTS.maxFileSizeMB, 0.1, 48),
      maxProblems: Math.floor(numberSetting(c.get('maxProblems', DEFAULTS.maxProblems), DEFAULTS.maxProblems, 1, 20000)),
      validateOnType: c.get('validateOnType', true) !== false,
      hoverEnabled: c.get('hover.enabled', true) !== false,
      disabledCodes: Array.isArray(disabled) ? disabled.filter(function (x) { return typeof x === 'string' && /^DBC-[A-Z0-9-]+$/.test(x); }).slice(0, 200) : [],
      workspaceInclude: stringSetting(c.get('workspace.include', DEFAULTS['workspace.include']), DEFAULTS['workspace.include']),
      workspaceExclude: stringSetting(c.get('workspace.exclude', DEFAULTS['workspace.exclude']), DEFAULTS['workspace.exclude']),
      workspaceMaxFiles: Math.floor(numberSetting(c.get('workspace.maxFiles', DEFAULTS['workspace.maxFiles']), DEFAULTS['workspace.maxFiles'], 1, 20000)),
      traceMaxTableRows: Math.floor(numberSetting(c.get('trace.maxTableRows', DEFAULTS['trace.maxTableRows']), DEFAULTS['trace.maxTableRows'], 1000, 1000000)),
      neutraliseFormulas: c.get('export.neutraliseFormulas', true) !== false
    };
    return settingsCache;
  }

  // The licence server environment is the live one, always. No setting, command, environment
  // variable or editor mode changes it (a development host of the extension included).
  const licence = createLicence({ secrets: context.secrets, globalState: context.globalState, editorName: vscode.env && vscode.env.appName });
  licence.checkTrial().then(undefined, function () { /* read-only state */ });

  const parseCache = new WeakMap();
  const validationCache = new WeakMap();
  const app = {
    vscode: vscode,
    context: context,
    licence: licence,
    getSettings: getSettings,
    defaults: DEFAULTS,
    diagnostics: null,
    tree: null,
    status: null,
    extensionVersion: (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || require('../package.json').version,
    osRelease: function () { try { return os.release(); } catch (e) { return ''; } },
    isDbcDocument: function (document) { return !!document && document.languageId === 'dbc'; },
    // Length of a document without copying its text.
    lengthOf: function (document) {
      if (!document.lineCount) return 0;
      try { return document.offsetAt(document.lineAt(document.lineCount - 1).range.end); } catch (e) { return document.getText().length; }
    },
    tooLarge: function (document) { return app.lengthOf(document) > getSettings().maxFileSizeMB * 1024 * 1024; },
    // The database of a document (cached per version); null for files over the size limit unless
    // `force` is set.
    parsedOf: function (document, force) {
      if (!force && app.tooLarge(document)) return null;
      const hit = parseCache.get(document);
      if (hit && hit.version === document.version) return hit.db;
      const text = document.getText();
      const db = P.parseDbc(text);
      db.replacementAt = text.indexOf('�');
      parseCache.set(document, { version: document.version, db: db });
      return db;
    },
    // Check result of a database (cached per database and settings).
    validateParsed: function (db) {
      const s = getSettings();
      const key = s.maxProblems + '|' + s.disabledCodes.join(',');
      const hit = validationCache.get(db);
      if (hit && hit.key === key) return hit.result;
      const result = validate(db, { maxProblems: s.maxProblems, disabledCodes: s.disabledCodes, replacementAt: db.replacementAt });
      validationCache.set(db, { key: key, result: result });
      return result;
    },
    settingsForReport: function () {
      const c = vscode.workspace.getConfiguration('canAtlas');
      const out = {};
      for (const k of Object.keys(DEFAULTS)) out[k] = c.get(k, DEFAULTS[k]);
      return out;
    }
  };

  const subscriptions = context.subscriptions;
  subscriptions.push(vscode.workspace.onDidChangeConfiguration(function (event) {
    if (event.affectsConfiguration('canAtlas')) settingsCache = null;
  }));

  function install(name, fn) {
    try {
      const result = fn();
      if (Array.isArray(result)) result.forEach(function (d) { subscriptions.push(d); });
      else if (result && typeof result.dispose === 'function') subscriptions.push(result);
      return result;
    } catch (err) {
      log('Could not start ' + name + ': ' + (err && err.message ? err.message : err));
      return null;
    }
  }

  install('commands', function () { return registerCommands(app); });
  install('Pro commands', function () { return registerProCommands(app); });
  app.diagnostics = install('problems', function () { return providers.createDiagnostics(app); });
  install('language features', function () { return providers.registerLanguageFeatures(app); });
  app.tree = install('outline', function () { return providers.createOutlineTree(app); });
  app.status = install('status bar', function () { return providers.createStatus(app); });
}

function deactivate() {}

module.exports = { activate: activate, deactivate: deactivate, DEFAULTS: DEFAULTS };
