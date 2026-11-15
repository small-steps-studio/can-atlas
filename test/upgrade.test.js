'use strict';
// Stored state written by hand, broken on disk or from another environment must never unlock Pro
// by mistake, never throw and never block the free features.
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/licence/config');
const L = require('../src/licence/licence');
const testEnvironment = require('./helpers/test-environment');

testEnvironment.register();

const LIVE = config.products.live;
const TESTP = config.products.test;

function make(initial, secret, now) {
  const global = new Map(Object.entries(initial || {}));
  const secrets = new Map(Object.entries(secret || {}));
  const calls = [];
  const lic = L.createLicence({
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } },
    globalState: { get: (k) => global.get(k), update: async (k, v) => { if (v === undefined) global.delete(k); else global.set(k, v); } },
    fetch: async (url) => { calls.push(url); return { status: 200, json: async () => ({ valid: true }) }; },
    now: () => now || Date.UTC(2026, 10, 12)
  });
  return { lic: lic, calls: calls, global: global };
}

test('the installed default environment is live', async () => {
  const m = make({ 'licence.instanceId.live': 'lki_1', 'licence.productId.live': LIVE.personal }, { 'licence.key.live': 'K' });
  assert.equal(await m.lic.isPro(), true);
  assert.ok(m.calls[0].startsWith('https://live.dodopayments.com/'));
});

test('a stored activation without a product id does not unlock Pro (no earlier version existed)', async () => {
  const m = make({ 'licence.instanceId.live': 'lki_1' }, { 'licence.key.live': 'SOME-KEY' });
  assert.equal(await m.lic.isPro(), false);
  const st = await m.lic.status(true);
  assert.equal(st.via, 'product');
  assert.equal(m.calls.length, 0, 'no request for a key that cannot count');
});

test('a stored product id of another product does not unlock Pro', async () => {
  const m = make({ 'licence.instanceId.live': 'lki_1', 'licence.productId.live': 'pdt_SomethingElse001' }, { 'licence.key.live': 'K' });
  assert.equal(await m.lic.isPro(), false);
});

test('a test-environment licence never counts in the live environment', async () => {
  const m = make({ 'licence.instanceId.test': 'lki_1', 'licence.productId.test': TESTP.personal }, { 'licence.key.test': 'K' });
  assert.equal(await m.lic.isPro(), false);
});

test('a live licence record is not read in the test environment either', async () => {
  const global = new Map(Object.entries({ 'licence.instanceId.live': 'lki_1', 'licence.productId.live': LIVE.personal }));
  const secrets = new Map(Object.entries({ 'licence.key.live': 'K' }));
  const lic = L.createLicence({
    secrets: { get: async (k) => secrets.get(k), store: async () => {}, delete: async () => {} },
    globalState: { get: (k) => global.get(k), update: async () => {} },
    fetch: async () => ({ status: 200, json: async () => ({ valid: true }) }), getMode: () => 'test'
  });
  assert.equal(await lic.isPro(), false);
});

test('wrong types in stored values are ignored', async () => {
  for (const bad of [null, 42, {}, [], 'text', NaN, Infinity, -1]) {
    const m = make({ 'trial.startedAt': bad, 'trial.lastSeenAt': bad, 'trial.expiredAt': bad, 'licence.instanceId.live': bad, 'licence.checkedAt.live': bad, 'licence.productId.live': bad }, {});
    const t = m.lic.trialStatus();
    assert.ok(['unused', 'active', 'expired'].indexOf(t.state) !== -1, String(bad));
    assert.equal(await m.lic.isPro(), false);
    await m.lic.checkTrial();
  }
});

test('a cached check from the future (clock moved back) is asked again', async () => {
  const now = Date.UTC(2026, 10, 12);
  const m = make({ 'licence.instanceId.live': 'lki_1', 'licence.productId.live': LIVE.business, 'licence.checkedAt.live': now + 10 * 86400000, 'licence.checkedValid.live': true }, { 'licence.key.live': 'K' });
  assert.equal(await m.lic.isPro(), true);
  assert.equal(m.calls.length, 1);
});

test('a trial record of a never-existing earlier version with a start far in the past ends the trial, once', async () => {
  const now = Date.UTC(2026, 10, 12);
  const m = make({ 'trial.startedAt': now - 400 * 86400000, 'trial.lastSeenAt': now - 399 * 86400000 }, {}, now);
  assert.equal((await m.lic.checkTrial()).state, 'expired');
  assert.ok(m.global.get('trial.expiredAt') > 0, 'the end is written down');
  assert.equal((await m.lic.startTrial()).state, 'expired');
});

test('the free features need no stored state at all', async () => {
  const m = make({}, {});
  assert.equal(await m.lic.isPro(), false);
  assert.equal(m.lic.trialStatus().state, 'unused');
  assert.equal(m.calls.length, 0);
});
