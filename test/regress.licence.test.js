'use strict';
// Regression tests for the independent audit of 0.1.0:
//   defect 7   a clock set back to before the trial start and then corrected cost the user the days of the set-back,
//   defect 10  Remove Licence said "could not be reached" when the server had answered with a refusal,
//   defect 11  the activation label named VS Code for every editor.

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/licence/config');
const messages = require('../src/licence/messages');
const L = require('../src/licence/licence');
const testEnvironment = require('./helpers/test-environment');
const { server, make, DAY } = require('./helpers/licence-fakes');

testEnvironment.register();

// ---- defect 7 --------------------------------------------------------------------------------------

test('trial: a clock set back to before the start and then corrected costs no days (the audit\'s case)', async () => {
  const m = make({ start: Date.UTC(2026, 10, 12, 10, 0, 0) });
  await m.lic.startTrial();
  m.setClock(Date.UTC(2026, 10, 15, 10, 0, 0));
  await m.lic.touchTrial(); // 3 days used
  m.setClock(Date.UTC(2026, 10, 10, 10, 0, 0)); // two days before the start
  let t = await m.lic.checkTrial();
  assert.equal(t.state, 'active');
  assert.equal(t.daysLeft, 11, 'correct for the clock shown: the 3 days that were used stay used');
  assert.equal(await m.lic.hasAccess(), true);
  m.setClock(Date.UTC(2026, 10, 15, 11, 0, 0)); // the clock is right again
  t = await m.lic.checkTrial();
  assert.equal(t.state, 'active');
  assert.equal(t.daysLeft, 11, 'the trial started on 12 November and ends on 26 November: 11 days are left on the 15th');
  assert.equal(t.endsAt, Date.UTC(2026, 10, 26, 10, 0, 0));
  assert.equal(m.s.globalMap.get('trial.startedAt'), Date.UTC(2026, 10, 12, 10, 0, 0), 'the original start is back');
  assert.equal(m.s.globalMap.has('trial.rebasedFrom'), false, 'the two helper records are gone');
  assert.equal(m.s.globalMap.has('trial.rebasedSeen'), false);
  m.setClock(Date.UTC(2026, 10, 26, 9, 59, 59));
  assert.equal(m.lic.trialStatus().state, 'active');
  m.setClock(Date.UTC(2026, 10, 26, 10, 0, 0));
  assert.equal((await m.lic.checkTrial()).state, 'expired');
});

test('trial: while the clock is still wrong the re-anchored start counts, and a second set-back keeps the first original', async () => {
  const m = make({ start: Date.UTC(2026, 10, 12, 10, 0, 0) });
  await m.lic.startTrial();
  m.setClock(Date.UTC(2026, 10, 15, 10, 0, 0));
  await m.lic.touchTrial();
  m.setClock(Date.UTC(2026, 10, 10, 10, 0, 0));
  await m.lic.checkTrial();
  assert.equal(m.s.globalMap.get('trial.rebasedFrom'), Date.UTC(2026, 10, 12, 10, 0, 0));
  assert.equal(m.s.globalMap.get('trial.rebasedSeen'), Date.UTC(2026, 10, 15, 10, 0, 0));
  // Back to the 13th: the clock is not yet where it was (the 15th), the anchored trial goes on.
  m.setClock(Date.UTC(2026, 10, 13, 10, 0, 0));
  let t = await m.lic.checkTrial();
  assert.equal(t.state, 'active');
  assert.equal(t.daysLeft, 8, 'started on the 7th (anchored), ends on the 21st');
  // Set back again, further: the first original is kept.
  m.setClock(Date.UTC(2026, 10, 1, 10, 0, 0));
  await m.lic.checkTrial();
  assert.equal(m.s.globalMap.get('trial.rebasedFrom'), Date.UTC(2026, 10, 12, 10, 0, 0));
  assert.equal(m.s.globalMap.get('trial.rebasedSeen'), Date.UTC(2026, 10, 15, 10, 0, 0));
  m.setClock(Date.UTC(2026, 10, 16, 10, 0, 0));
  t = await m.lic.checkTrial();
  assert.equal(t.state, 'active');
  assert.equal(t.endsAt, Date.UTC(2026, 10, 26, 10, 0, 0), 'the original start again');
});

test('trial: an ended trial stays ended; a clock set back never gives days; no helper record means no change', async () => {
  const m = make({ start: Date.UTC(2026, 10, 12, 10, 0, 0) });
  await m.lic.startTrial();
  m.setClock(Date.UTC(2026, 10, 15, 10, 0, 0));
  await m.lic.touchTrial();
  m.setClock(Date.UTC(2026, 10, 10, 10, 0, 0));
  await m.lic.checkTrial();
  m.setClock(Date.UTC(2026, 10, 10, 10, 0, 0) + 12 * DAY); // the 22nd: the clock is back past the 15th, the original start (ends on the 26th) is back
  assert.equal((await m.lic.checkTrial()).state, 'active');
  // Within the trial a clock set back gives no extra day.
  const n = make({ start: Date.UTC(2026, 10, 12, 10, 0, 0) });
  await n.lic.startTrial();
  n.setClock(Date.UTC(2026, 10, 20, 10, 0, 0));
  await n.lic.touchTrial();
  n.setClock(Date.UTC(2026, 10, 13, 10, 0, 0));
  assert.equal((await n.lic.checkTrial()).endsAt, Date.UTC(2026, 10, 26, 10, 0, 0));
  assert.equal(n.s.globalMap.has('trial.rebasedFrom'), false, 'nothing is rebased inside the trial');
  // After the end, a set-back and a correction leave it ended.
  const e = make({ start: Date.UTC(2026, 10, 12, 10, 0, 0) });
  await e.lic.startTrial();
  e.setClock(Date.UTC(2026, 11, 20, 10, 0, 0));
  assert.equal((await e.lic.checkTrial()).state, 'expired');
  e.setClock(Date.UTC(2026, 10, 1, 10, 0, 0));
  assert.equal((await e.lic.checkTrial()).state, 'expired');
  e.setClock(Date.UTC(2026, 11, 21, 10, 0, 0));
  assert.equal((await e.lic.checkTrial()).state, 'expired');
});

// ---- defect 10 -------------------------------------------------------------------------------------

test('remove: the reason says whether the server could not be reached or answered with a refusal', async () => {
  for (const [name, setup, reason, status] of [
    ['unreachable', (srv) => { srv.options.down = true; }, 'network', 0],
    ['404', (srv) => { srv.options.deactivateStatus = 404; }, 'status', 404],
    ['422', (srv) => { srv.options.deactivateStatus = 422; }, 'status', 422],
    ['500', (srv) => { srv.options.deactivateStatus = 500; }, 'status', 500]
  ]) {
    const srv = server();
    const m = make({ server: srv });
    await m.lic.activate('KEY-PERSONAL');
    setup(srv);
    const r = await m.lic.remove();
    assert.equal(r.ok, true, name);
    assert.equal(r.deactivated, false, name);
    assert.equal(r.reason, reason, name);
    if (status) assert.equal(r.status, status, name);
    assert.equal(m.s.secretsMap.size, 0, name + ': the local key is removed anyway');
    const text = messages.removedText(r);
    assert.match(text, /^The licence was removed from this computer\./, name);
    if (reason === 'network') {
      assert.match(text, /could not be reached/, name);
      assert.ok(!/HTTP/.test(text), name);
    } else {
      assert.ok(!/could not be reached/.test(text), name + ': the server was reached');
      assert.match(text, new RegExp('did not confirm that the activation was freed \\(HTTP ' + status + ';'), name);
    }
    assert.match(text, /may still count against the limit of 3/, name);
  }
  // Success and "nothing to free" are unchanged.
  const ok = make();
  await ok.lic.activate('KEY-PERSONAL');
  assert.deepEqual(await ok.lic.remove(), { ok: true, deactivated: true });
  assert.match(messages.removedText({ ok: true, deactivated: true }), /the activation was freed\. You can enter the key on another computer now\./);
});

// ---- defect 11 -------------------------------------------------------------------------------------

test('the activation label names the editor that reports itself, cut down to plain characters', async () => {
  assert.equal(L.instanceName('win32', 'Visual Studio Code'), 'VS Code on Windows');
  assert.equal(L.instanceName('darwin', 'Visual Studio Code - Insiders'), 'VS Code - Insiders on macOS');
  assert.equal(L.instanceName('linux', 'VSCodium'), 'VSCodium on Linux');
  assert.equal(L.instanceName('linux', 'Cursor'), 'Cursor on Linux');
  assert.equal(L.instanceName('linux', undefined), 'VS Code on Linux');
  assert.equal(L.instanceName('linux', ''), 'VS Code on Linux');
  assert.equal(L.instanceName('linux', '   '), 'VS Code on Linux');
  assert.equal(L.instanceName('linux', 42), 'VS Code on Linux');
  assert.equal(L.instanceName('win32', 'Some <b>Editor</b>\n"x"; DROP'), 'Some b Editor b x DROP on Windows', 'no markup, quotes or line breaks reach the service');
  assert.ok(L.editorLabel('x'.repeat(200)).length <= 32);
  assert.equal(L.editorLabel('Visual Studio Code').length > 0, true);
  const m = make({ editorName: 'Cursor' });
  await m.lic.activate('KEY-PERSONAL');
  assert.equal(m.srv.calls[0].body.name, 'Cursor on Windows');
  const d = make();
  await d.lic.activate('KEY-PERSONAL');
  assert.equal(d.srv.calls[0].body.name, 'VS Code on Windows', 'no editor name given: the default');
  const v = make({ editorName: 'Visual Studio Code' });
  await v.lic.activate('KEY-PERSONAL');
  assert.equal(v.srv.calls[0].body.name, 'VS Code on Windows');
});

test('the live product ids are the real ones and no placeholder is left', () => {
  assert.equal(config.products.live.personal, 'pdt_0Nro3ovKX83nNHYqq4jXH');
  assert.equal(config.products.live.business, 'pdt_0Nro428BgjPvGnyc8xxYG');
  assert.equal(config.products.test.personal, 'pdt_0Ns19RWDOUCZzPqW3G0OZ');
  assert.equal(config.products.test.business, 'pdt_0Ns19XKeCkRiFSK1Wo2dz');
  assert.deepEqual(config.placeholderIds(), []);
});

// ---- the commands in the stand-in editor -----------------------------------------------------------

const path = require('node:path');
const M = require('./helpers/vscode-mock');
const pkg = require('../package.json');

function startEditor(options, appName) {
  const mock = M.createMock(options || {});
  if (appName) mock.vscode.env.appName = appName;
  const uninstall = M.install(mock.vscode);
  const srcDir = path.join(__dirname, '..', 'src');
  for (const k of Object.keys(require.cache)) if (k.startsWith(srcDir)) delete require.cache[k];
  const ext = require('../src/extension');
  const context = M.makeContext(pkg);
  ext.activate(context);
  return { state: mock.state, context: context, uninstall: uninstall, run: (id, ...a) => mock.vscode.commands.executeCommand(id, ...a) };
}

test('Enter Licence Key sends the name of the editor that runs the extension', async () => {
  for (const [appName, expected] of [['Visual Studio Code', /^VS Code on /], ['VSCodium', /^VSCodium on /], ['Cursor', /^Cursor on /]]) {
    const x = startEditor({ inputAnswers: ['KEY-PERSONAL'] }, appName);
    const realFetch = global.fetch;
    const srv = server();
    global.fetch = srv.fetch;
    try {
      await x.run('canAtlas.enterKey');
      assert.match(srv.calls[0].body.name, expected, appName);
      assert.ok(!/\b(localhost|desktop)\b/i.test(srv.calls[0].body.name));
    } finally { global.fetch = realFetch; x.uninstall(); }
  }
});

test('Remove Licence tells a refusal of the server from a server that cannot be reached', async () => {
  for (const [deactivateStatus, down, expected, unexpected] of [[404, false, /did not confirm that the activation was freed \(HTTP 404;/, /could not be reached/], [0, true, /could not be reached/, /HTTP/]]) {
    const x = startEditor({ buttonAnswers: ['Remove Licence'] });
    x.context.secretsMap.set('licence.key.live', 'KEY-PERSONAL');
    x.context.globalMap.set('licence.instanceId.live', 'lki_1');
    x.context.globalMap.set('licence.productId.live', config.products.live.personal);
    const realFetch = global.fetch;
    const srv = server({ deactivateStatus: deactivateStatus || undefined, down: down });
    global.fetch = srv.fetch;
    try {
      await x.run('canAtlas.removeLicence');
      const warning = x.state.warningMessages[0];
      assert.ok(warning, 'the confirmation question was shown');
      const text = x.state.infoMessages.map((m) => m.text).join(' | ');
      assert.match(text, /The licence was removed from this computer\./);
      assert.match(text, expected);
      assert.doesNotMatch(text, unexpected);
      assert.equal(x.context.secretsMap.size, 0);
    } finally { global.fetch = realFetch; x.uninstall(); }
  }
});
