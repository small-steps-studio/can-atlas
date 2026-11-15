'use strict';
// Regression tests for the licence defects found in the sister products: a rejected key that comes
// back through the offline period, a storage failure while a key is replaced, a test address in the
// package, and trials that must survive a clock correction.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/licence/config');
const testEnvironment = require('./helpers/test-environment');
const { stores, server, make, HOUR, DAY } = require('./helpers/licence-fakes');

testEnvironment.register();

test('a key the server rejected does not come back through the offline period', async () => {
  for (const reject of [{ invalid: true }, { validateStatus: 403 }, { validateStatus: 404 }, { validateStatus: 422 }]) {
    const srv = server();
    const m = make({ server: srv });
    assert.equal((await m.lic.activate('KEY-PERSONAL')).ok, true);
    assert.equal(await m.lic.isPro(), true);
    m.advance(25 * HOUR);
    Object.assign(srv.options, reject);
    assert.equal(await m.lic.isPro(), false, JSON.stringify(reject) + ': the server says no');
    delete srv.options.invalid;
    delete srv.options.validateStatus;
    srv.options.down = true;
    for (const hours of [25, 50, 5 * 24, 13 * 24]) {
      m.advance(hours * HOUR);
      assert.equal(await m.lic.isPro(), false, JSON.stringify(reject) + ': offline after ' + hours + ' h');
    }
  }
});

test('the offline period still works after a successful check (control)', async () => {
  const srv = server();
  const m = make({ server: srv });
  await m.lic.activate('KEY-BUSINESS');
  srv.options.down = true;
  m.advance(25 * HOUR);
  assert.equal(await m.lic.isPro(), true, 'day 1 offline');
  m.advance(12 * DAY);
  assert.equal(await m.lic.isPro(), true, 'day 13 offline');
  m.advance(2 * DAY);
  assert.equal(await m.lic.isPro(), false, 'day 15 offline');
});

test('replacing a key: when the new key cannot be stored, the working licence and its seat are kept', async () => {
  for (const failing of ['licence.instanceId.live', 'licence.productId.live', 'licence.lastGoodAt.live', 'licence.checkedValid.live']) {
    const st = stores();
    const srv = server();
    const m = make({ stores: st, server: srv });
    assert.equal((await m.lic.activate('KEY-A')).ok, true);
    assert.equal(srv.seats('KEY-A'), 1);
    st.options.failWhen = (kind, key) => kind === 'state' && key === failing;
    const result = await m.lic.activate('KEY-B');
    st.options.failWhen = null;
    assert.equal(result.ok, false, failing);
    assert.equal(result.reason, 'storage', failing);
    assert.equal(result.previousKept, true, failing + ': the previous licence is reported as kept');
    assert.equal(srv.seats('KEY-B'), 0, failing + ': the new activation was released');
    assert.equal(srv.seats('KEY-A'), 1, failing + ': the old activation is still held');
    assert.equal(st.secretsMap.get('licence.key.live'), 'KEY-A', failing + ': the old key is still stored');
    assert.equal(await m.lic.isPro(), true, failing + ': Pro stays on');
    assert.equal((await m.lic.remove()).deactivated, true);
    assert.equal(srv.seats('KEY-A'), 0, failing + ': Remove Licence can still free the seat');
  }
});

test('first activation with failing secret storage stores nothing and leaves no seat', async () => {
  const st = stores({ failStore: true });
  const srv = server();
  const m = make({ stores: st, server: srv });
  const result = await m.lic.activate('KEY-PERSONAL');
  assert.equal(result.reason, 'storage');
  assert.equal(result.released, true);
  assert.equal(srv.seats('KEY-PERSONAL'), 0);
  assert.equal(st.secretsMap.size, 0);
});

test('trial: a clock set back by a user does not stretch the trial, and an ended trial stays ended through a restart', async () => {
  const st = stores();
  const m = make({ stores: st });
  await m.lic.startTrial();
  m.advance(20 * DAY);
  assert.equal((await m.lic.checkTrial()).state, 'expired');
  m.advance(-19 * DAY);
  assert.equal(m.lic.trialStatus().state, 'expired');
  // A restart of the editor: a new service object over the same stored state.
  const again = make({ stores: st, start: m.now() });
  assert.equal(again.lic.trialStatus().state, 'expired');
  assert.equal((await again.lic.startTrial()).state, 'expired');
  assert.equal(await again.lic.hasAccess(), false);
});

test('trial: a state that cannot be written never ends or restarts a trial by mistake', async () => {
  const st = stores();
  const m = make({ stores: st });
  await m.lic.startTrial();
  st.options.readOnly = true;
  m.advance(3 * DAY);
  const t = await m.lic.checkTrial();
  assert.equal(t.state, 'active');
  assert.equal(t.daysLeft, 11);
});

test('the package knows the live licence environment only', () => {
  const root = path.join(__dirname, '..');
  function files(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) files(p, out); else if (/\.(js|json|md)$/.test(e.name)) out.push(p);
    }
    return out;
  }
  for (const f of files(path.join(root, 'src'), []).concat([path.join(root, 'package.json'), path.join(root, 'README.md')])) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/test\.(checkout\.)?dodopayments\.com/.test(text), path.relative(root, f) + ' names a test address');
    assert.ok(!/process\.env/.test(text), path.relative(root, f) + ' reads an environment variable');
    assert.ok(!/extensionMode/.test(text), path.relative(root, f) + ' switches on the extension mode');
  }
  assert.deepEqual(config.knownEnvironments().filter((n) => n !== 'test'), ['live']);
  assert.ok(config.registerTestEnvironment && !/^https:\/\/test/.test(config.apiBaseLive));
  assert.throws(() => config.registerTestEnvironment({ api: 'http://localhost:1', checkoutBase: 'https://x/' }), /https/);
});

test('the four product ids live in one file and the placeholder detection names them', () => {
  const placeholders = config.placeholderIds();
  for (const id of config.PLACEHOLDER_IDS) assert.ok(placeholders.some((p) => p.includes(id)) || !Object.values(config.products.live).concat(Object.values(config.products.test)).includes(id), id);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'licence', 'config.js'), 'utf8');
  assert.equal((src.match(/PDT_(PERSONAL|BUSINESS)_(LIVE|TEST)/g) || []).length >= 4, true);
  // With placeholders the release check refuses; with real ids (set later) it passes. Either way the
  // local-build switch accepts the placeholders and every other rule still holds.
  // (A fresh process is used because this file registers the stand-in test environment, which a build for publishing must not know.)
  const script = "const c=require('./src/licence/config');const p=require('./package.json');let r='ok';try{c.assertShippable(p,{});}catch(e){r=e.message;}let l='ok';try{c.assertShippable(p,{allowPlaceholders:true});}catch(e){l=e.message;}process.stdout.write(JSON.stringify({release:r,local:l}));";
  const out = JSON.parse(require('node:child_process').execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true }));
  if (placeholders.length) assert.match(out.release, /product ids are still placeholders/);
  else assert.equal(out.release, 'ok');
  assert.equal(out.local, 'ok');
  assert.ok(!placeholders.length || !/Refusing/.test(out.local));
});
