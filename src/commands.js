'use strict';
// Free commands (checks, frame decode and encode, bit layout, navigation, samples, help) and the
// licence and trial commands. The Pro commands are in procommands.js.

const config = require('./licence/config');
const messages = require('./licence/messages');
const { createUi } = require('./ui');
const { sampleFor } = require('./samples');
const { diagnosticsBlock, reportProblemText } = require('./support');
const D = require('./dbc/describe');
const O = require('./dbc/outline');
const L = require('./dbc/layout');
const codec = require('./dbc/codec');
const frame = require('./frame');

const WALKTHROUGH_ID = 'SmallStepsStudio.can-atlas#canAtlas.gettingStarted';
const MAX_PICK_ITEMS = 20000;

function registerCommands(app) {
  const vscode = app.vscode;
  const ui = createUi(app);
  app.ui = ui;
  const reg = ui.reg;
  const info = ui.info;
  const warn = ui.warn;
  const NAME = ui.NAME;
  const BUTTONS = ui.BUTTONS;
  let lastFrame = '';
  let lastValues = '';

  function reveal(editor, offset, endOffset) {
    const doc = editor.document;
    const a = doc.positionAt(offset);
    const b = doc.positionAt(endOffset === undefined ? offset : endOffset);
    editor.selection = new vscode.Selection(a, b);
    editor.revealRange(new vscode.Range(a, b), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  // The message under the cursor, or one picked from a list. Returns null when the user cancels.
  async function pickMessage(editor, db, placeHolder) {
    const here = D.messageAt(db, editor.document.offsetAt(editor.selection.active));
    if (here) return here;
    const items = O.messageItems(db);
    if (!items.length) { warn('This file has no messages.'); return null; }
    const pick = await vscode.window.showQuickPick(items.slice(0, MAX_PICK_ITEMS), { placeHolder: placeHolder, matchOnDescription: true, matchOnDetail: true });
    return pick ? pick.message : null;
  }

  // ---- free commands -----------------------------------------------------------------------------
  reg('canAtlas.checkFile', async function () {
    const editor = ui.dbcEditor();
    if (!editor) return;
    const r = app.diagnostics ? app.diagnostics.run(editor.document, true) : null;
    if (!r || !r.counts) return;
    info(NAME + ': ' + r.counts.error + ' errors, ' + r.counts.warning + ' warnings and ' + r.counts.info + ' notes; ' + r.messages + ' messages, ' + r.signals + ' signals. These are structural checks of the database; they do not replace a test on the bus.');
    if (app.status) app.status.update();
  });

  reg('canAtlas.decodeFrame', async function () {
    const editor = ui.dbcEditor();
    if (!editor) return;
    const db = app.parsedOf(editor.document, true);
    const text = await vscode.window.showInputBox({
      title: NAME + ': decode a frame (ID#DATA in hex; x after the ID marks an extended ID)', placeHolder: 'for example 100#401F72FA8E01103C', value: lastFrame, ignoreFocusOut: true,
      validateInput: function (v) { return v && v.trim() ? frame.parseFrameInput(v).error || null : null; }
    });
    if (text === undefined || !text.trim()) return;
    lastFrame = text;
    const f = frame.parseFrameInput(text);
    if (f.error) { warn(f.error); return; }
    const found = frame.findMessage(db, f.id, f.extended);
    if (!found.message) {
      const ids = O.messageItems(db).slice(0, 5).map(function (i) { return i.label.split(' ')[0]; }).join(', ');
      warn('This file has no message with the ID ' + f.id.toString(16).toUpperCase() + (f.extended ? ' (extended)' : '') + '.' + (ids ? ' The first messages have the IDs ' + ids + '.' : ''));
      return;
    }
    await ui.openText(frame.decodeMarkdown(db, found.message, f.bytes, found.note), 'markdown', 'decoded-frame.md');
  });

  reg('canAtlas.encodeSignals', async function () {
    const editor = ui.dbcEditor();
    if (!editor) return;
    const db = app.parsedOf(editor.document, true);
    const message = await pickMessage(editor, db, 'Message to encode');
    if (!message) return;
    const names = message.signals.slice(0, 4).map(function (s) { return s.name + '=' + (s.values && s.values.length ? '"' + s.values[0].text + '"' : '0'); }).join('; ');
    const text = await vscode.window.showInputBox({
      title: NAME + ': encode ' + message.name + ' (Name=value, separated by ;  a value description goes in double quotes; signals left out start at raw 0)', placeHolder: names, value: lastValues, ignoreFocusOut: true,
      validateInput: function (v) { return v && v.trim() ? frame.parseAssignments(v).error || null : null; }
    });
    if (text === undefined) return;
    lastValues = text;
    const parsed = frame.parseAssignments(text);
    if (parsed.error) { warn(parsed.error); return; }
    const enc = codec.encodeMessage(db, message, parsed.assignments);
    await ui.openText(frame.encodeMarkdown(message, enc), 'markdown', 'encoded-frame.md');
    const pick = await info(NAME + ': ' + (enc.ok ? 'encoded ' : 'encoded with errors: ') + enc.frameText, 'Copy Frame');
    if (pick === 'Copy Frame') await vscode.env.clipboard.writeText(enc.frameText);
  });

  reg('canAtlas.showBitLayout', async function () {
    const editor = ui.dbcEditor();
    if (!editor) return;
    const db = app.parsedOf(editor.document, true);
    const message = await pickMessage(editor, db, 'Message to show');
    if (!message) return;
    await ui.openText(L.layoutMarkdown(db, message), 'markdown', 'bit-layout-' + message.name.replace(/[^A-Za-z0-9_]/g, '') + '.md');
  });

  reg('canAtlas.goToMessage', async function () {
    const editor = ui.dbcEditor();
    if (!editor) return;
    const db = app.parsedOf(editor.document, true);
    const items = O.messageItems(db);
    if (!items.length) { warn('This file has no messages.'); return; }
    const pick = await vscode.window.showQuickPick(items.slice(0, MAX_PICK_ITEMS), { placeHolder: 'Message to go to', matchOnDescription: true, matchOnDetail: true });
    if (pick) reveal(editor, pick.message.nameStart, pick.message.nameEnd);
  });

  reg('canAtlas.revealOffset', async function (uriText, offset) {
    const uri = vscode.Uri.parse(String(uriText), true);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false, preview: true });
    const at = Math.max(0, Math.min(app.lengthOf(doc), Number(offset) || 0));
    reveal(editor, at);
  });

  reg('canAtlas.refreshOutline', function () { if (app.tree) app.tree.refresh(); });

  async function openSample(kind) {
    const s = sampleFor(kind);
    if (!s) { warn('This installation is incomplete; reinstall the extension.'); return; }
    await ui.openText(s.text, s.languageId, s.fileName);
    vscode.window.setStatusBarMessage(NAME + ': opened the ' + s.title + ' (invented data)', 5000);
  }
  reg('canAtlas.openSample', function () { return openSample('valid'); });
  reg('canAtlas.openSampleProblems', function () { return openSample('problems'); });
  reg('canAtlas.openSampleTrace', function () { return openSample('trace'); });
  reg('canAtlas.openWalkthrough', async function () { await vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false); });
  reg('canAtlas.showDocumentation', async function () { await ui.openExternal(config.docsUrl); });

  reg('canAtlas.reportProblem', async function () {
    const editor = vscode.window.activeTextEditor;
    let active = null;
    if (editor) {
      const summary = app.diagnostics ? app.diagnostics.summaryOf(editor.document) : null;
      active = {
        kind: app.isDbcDocument(editor.document) ? 'DBC file' : 'not a DBC file (' + editor.document.languageId + ')',
        size: app.lengthOf(editor.document),
        messages: summary ? summary.messages : undefined, signals: summary ? summary.signals : undefined, counts: summary ? summary.counts : undefined, skipped: summary ? summary.skipped : undefined
      };
    }
    const block = diagnosticsBlock({
      extensionVersion: app.extensionVersion, editorName: vscode.env && vscode.env.appName, editorVersion: vscode.version, platform: process.platform,
      osRelease: app.osRelease(), arch: process.arch, nodeVersion: process.versions && process.versions.node, settings: app.settingsForReport(), defaults: app.defaults,
      licence: await app.licence.peek(), active: active
    });
    await vscode.env.clipboard.writeText(block);
    const opened = await ui.openExternal(config.issuesUrl);
    info(NAME + ': ' + reportProblemText(opened !== false));
  });

  // ---- licence commands ----------------------------------------------------------------------------
  reg('canAtlas.buyPro', async function () {
    const choice = await vscode.window.showQuickPick(messages.buyChoices(), { placeHolder: 'Which licence? Both unlock the same Pro features.', matchOnDescription: true, matchOnDetail: true });
    if (!choice) return;
    let users = 1;
    if (choice.tier === 'business') {
      const answer = await vscode.window.showInputBox({ title: NAME + ' Pro Business: ' + messages.businessUsersQuestion(), value: '1', ignoreFocusOut: true, validateInput: messages.businessUsersError });
      if (answer === undefined) return;
      if (messages.businessUsersError(answer)) { warn(messages.businessUsersError(answer) + ' The checkout page was not opened.'); return; }
      users = Number(String(answer).trim());
    }
    const url = app.licence.buyUrl(choice.tier, users);
    if (!url) { info(NAME + ': ' + choice.label + ' is not on sale yet. Please check the extension page again soon.'); return; }
    await ui.openExternal(url);
  });

  reg('canAtlas.enterKey', async function () {
    const raw = await vscode.window.showInputBox({
      title: NAME + ' Pro: paste the licence key from your purchase e-mail', placeHolder: 'Licence key', ignoreFocusOut: true, password: true,
      validateInput: function (v) { return /\s/.test((v || '').trim()) ? 'A licence key contains no spaces.' : null; }
    });
    const key = (raw || '').trim();
    if (!key) return;
    const result = await app.licence.activate(key);
    if (result.ok) info(NAME + ': ' + messages.activatedText(result.licenceType, result));
    else {
      const pick = await vscode.window.showErrorMessage(NAME + ': ' + messages.activationFailureText(result), BUTTONS.lost);
      if (pick === BUTTONS.lost) await ui.showLostKey();
    }
  });

  reg('canAtlas.licenceStatus', async function () {
    const st = await app.licence.status(true);
    const text = NAME + ': ' + messages.licenceStatusText(st);
    let pick;
    if (st.pro) pick = await info(text, BUTTONS.remove);
    else if (st.hasKey) pick = await info(text, BUTTONS.enter, BUTTONS.remove, BUTTONS.lost);
    else pick = await info(text, BUTTONS.buy, BUTTONS.enter, BUTTONS.lost);
    await ui.handleLicenceButton(pick);
  });

  reg('canAtlas.removeLicence', async function () {
    const st = await app.licence.peek();
    if (!st.hasKey) { info(NAME + ': No licence key is stored on this computer, so there is nothing to remove.'); return; }
    const pick = await vscode.window.showWarningMessage(NAME + ': ' + messages.removeConfirmText(), { modal: true }, BUTTONS.remove);
    if (pick !== BUTTONS.remove) return;
    const result = await app.licence.remove();
    info(NAME + ': ' + messages.removedText(result));
  });

  return ui.disposables;
}

module.exports = { registerCommands: registerCommands };
