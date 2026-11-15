'use strict';
// Licence service, trial and product allow-list, with an injected fetch, clock and stores.
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/licence/config');
const messages = require('../src/licence/messages');
const L = require('../src/licence/licence');
const testEnvironment = require('./helpers/test-environment');
const { stores, server, make, HOUR, DAY } = require('./helpers/licence-fakes');

testEnvironment.register();

const LIVE = config.products.live;
const TESTP = config.products.test;

test('config: the allow-list lists exactly the Personal and Business products per environment', () => {
  assert.deepEqual(config.allowedProductIds('test'), [TESTP.personal, TESTP.business]);
  assert.deepEqual(config.allowedProductIds('live'), [LIVE.personal, LIVE.business]);
  assert.deepEqual(config.allowedProductIds(undefined), config.allowedProductIds('live'), 'the default environment is live');
  assert.equal(config.licenceTypeOf('test', TESTP.business), 'business');
  assert.equal(config.licenceTypeOf('live', LIVE.personal), 'personal');
  assert.equal(config.licenceTypeOf('live', TESTP.personal), '', 'a test product never counts in live mode');
  assert.equal(config.licenceTypeOf('test', LIVE.personal), '', 'a live product never counts in test mode');
  for (const bad of [undefined, null, '', ' ' + LIVE.personal, LIVE.personal.toLowerCase() + 'x', LIVE.personal + ' ', 42, {}, [LIVE.personal]]) assert.equal(config.licenceTypeOf('live', bad), '', String(bad));
  assert.equal(config.mode, 'live');
  assert.equal(config.trialDays, 14);
  assert.equal(config.activationLimit, 3);
  assert.equal(config.maxUsers, 100);
  assert.equal(config.priceText, 'USD 29');
  assert.equal(config.businessPriceText, 'USD 59 per user');
  assert.equal(config.productName, 'CAN Atlas');
});

test('config: the four product ids are in the configuration; placeholder detection works', () => {
  const savedProducts = JSON.parse(JSON.stringify(config.products));
  const set = (live, test2) => { config.products.live.personal = live[0]; config.products.live.business = live[1]; config.products.test.personal = test2[0]; config.products.test.business = test2[1]; };
  try {
    set(['PDT_PERSONAL_LIVE', 'PDT_BUSINESS_LIVE'], ['PDT_PERSONAL_TEST', 'PDT_BUSINESS_TEST']);
    assert.deepEqual(config.placeholderIds(), ['live personal (PDT_PERSONAL_LIVE)', 'live business (PDT_BUSINESS_LIVE)', 'test personal (PDT_PERSONAL_TEST)', 'test business (PDT_BUSINESS_TEST)']);
    set(['pdt_short', 'pdt_0123456789LiveBusiness'], ['pdt_0123456789TestPersonal', 'pdt_0123456789TestBusiness']);
    assert.equal(config.placeholderIds().length, 1, 'a malformed id counts as a placeholder');
    set(['pdt_0123456789LivePersonal', 'pdt_0123456789LiveBusiness'], ['pdt_0123456789TestPersonal', 'pdt_0123456789TestBusiness']);
    assert.deepEqual(config.placeholderIds(), []);
  } finally {
    set([savedProducts.live.personal, savedProducts.live.business], [savedProducts.test.personal, savedProducts.test.business]);
  }
  assert.deepEqual(config.PLACEHOLDER_IDS.slice().sort(), ['PDT_BUSINESS_LIVE', 'PDT_BUSINESS_TEST', 'PDT_PERSONAL_LIVE', 'PDT_PERSONAL_TEST']);
});

test('config: buy links carry the product and the quantity', () => {
  const live = 'https://checkout.dodopayments.com/buy/';
  assert.equal(config.buyUrlFor('live', 'personal', 1), live + LIVE.personal + '?quantity=1');
  assert.equal(config.buyUrlFor('live', 'business', 7), live + LIVE.business + '?quantity=7');
  assert.equal(config.buyUrlFor('live', 'business', 1), live + LIVE.business + '?quantity=1');
  assert.equal(config.buyUrlFor('live', 'business', 100), live + LIVE.business + '?quantity=100');
  assert.equal(config.buyUrlFor('test', 'business', 100), 'https://test.checkout.dodopayments.com/buy/' + TESTP.business + '?quantity=100');
  for (const bad of [0, 101, 2.5, '3', NaN, -1, undefined, null, 1e3, Infinity, 'ten']) assert.equal(config.buyUrlFor('live', 'business', bad), '', String(bad));
  assert.equal(config.buyUrlFor('live', 'personal', 50), live + LIVE.personal + '?quantity=1', 'Personal is always one licence');
  assert.equal(config.buyUrlFor('live', 'enterprise', 1), '');
  assert.ok(!/\?.*\?|&/.test(config.buyUrlFor('live', 'business', 5)), 'no other query parameter');
});

test('no network without a key', async () => {
  const m = make();
  assert.equal(await m.lic.isPro(), false);
  const st = await m.lic.status(true);
  assert.equal(st.hasKey, false);
  await m.lic.remove();
  await m.lic.peek();
  await m.lic.checkTrial();
  assert.equal(m.srv.calls.length, 0);
});

test('activation stores key, instance and product; never the customer block, and logs nothing', async () => {
  const logged = [];
  const saved = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { saved[k] = console[k]; console[k] = (...a) => logged.push(a.join(' ')); }
  let m;
  try {
    m = make();
    const r = await m.lic.activate('  KEY-PERSONAL  ');
    assert.deepEqual(r, { ok: true, licenceType: 'personal' });
    await m.lic.isPro();
    await m.lic.status(true);
  } finally { for (const k of Object.keys(saved)) console[k] = saved[k]; }
  assert.deepEqual(logged, [], 'nothing is logged');
  assert.equal(m.srv.calls[0].body.name, 'VS Code on Windows', 'the activation name is the platform, never a computer or user name');
  assert.deepEqual(Object.keys(m.srv.calls[0].body).sort(), ['license_key', 'name']);
  assert.equal(m.s.secretsMap.get('licence.key.live'), 'KEY-PERSONAL');
  assert.equal(m.s.globalMap.get('licence.productId.live'), LIVE.personal);
  const written = JSON.stringify(m.s.writes.filter((w) => w[0] === 'state'));
  assert.ok(!/buyer@example\.com|Test Buyer|cus_1|bus_1|lic_1|business_id|customer/.test(written), 'customer details must not be stored');
  assert.deepEqual(m.s.writes.filter((w) => w[0] === 'secret').map((w) => w[1]), ['licence.key.live'], 'the key goes to the secret storage only');
  assert.ok(!written.includes('KEY-PERSONAL'), 'the key is not in the global state');
  const st = await m.lic.status(false);
  assert.equal(st.licenceType, 'personal');
  assert.equal(st.keyHint, '...ONAL');
  assert.ok(!JSON.stringify(st).includes('KEY-PERSONAL'), 'the status never holds the key');
});

test('a Business key activates as Business; each environment accepts its own products only', async () => {
  const m = make();
  assert.deepEqual(await m.lic.activate('KEY-BUSINESS'), { ok: true, licenceType: 'business' });
  assert.match(messages.activatedText('business', {}), /Business licence.*pass the key on to a colleague/);
  assert.equal(m.srv.calls[0].url, 'https://live.dodopayments.com/licenses/activate');
  assert.deepEqual(await make().lic.activate('KEY-TEST-P'), { ok: false, reason: 'product', released: true }, 'a test-product key in the live environment is refused');
  const test2 = make({ mode: 'test' });
  assert.deepEqual(await test2.lic.activate('KEY-TEST-B'), { ok: true, licenceType: 'business' });
  assert.equal(test2.srv.calls[0].url, 'https://test.dodopayments.com/licenses/activate');
  assert.deepEqual(await make({ mode: 'test' }).lic.activate('KEY-PERSONAL'), { ok: false, reason: 'product', released: true }, 'a live-product key in the test environment is refused');
});

test('a key of another product is refused and its activation released', async () => {
  const m = make();
  const r = await m.lic.activate('KEY-OTHER');
  assert.deepEqual(r, { ok: false, reason: 'product', released: true });
  assert.equal(m.srv.calls[1].url, 'https://live.dodopayments.com/licenses/deactivate');
  assert.equal(m.srv.active.size, 0);
  assert.equal(m.s.secretsMap.size, 0);
  assert.equal(await m.lic.isPro(), false);
  assert.match(messages.activationFailureText(r), /another product.*released again and nothing was stored/);
  const unconfirmed = make({ server: server({ deactivateStatus: 500 }) });
  const r2 = await unconfirmed.lic.activate('KEY-OTHER');
  assert.equal(r2.released, false);
  assert.match(messages.activationFailureText(r2), /could not be released/);
});

test('malformed product answers are refused and the activation is released', async () => {
  const shapes = [null, '', ' ' + LIVE.personal, LIVE.personal + ' ', LIVE.personal.toLowerCase() + 'x', LIVE.personal + 'x', 42, {}, [LIVE.personal], '__proto__', TESTP.personal];
  for (const productAnswer of shapes) {
    const m = make({ server: server({ productAnswer: productAnswer }) });
    const r = await m.lic.activate('KEY-A');
    assert.equal(r.ok, false, JSON.stringify(productAnswer));
    assert.ok(r.reason === 'product' || r.reason === 'unverified', JSON.stringify(productAnswer));
    assert.equal(r.released, true);
    assert.equal(m.srv.active.size, 0, 'seat given back for ' + JSON.stringify(productAnswer));
    assert.equal(m.s.secretsMap.size, 0);
  }
  const noProduct = make({ server: server({ noProduct: true }) });
  assert.deepEqual(await noProduct.lic.activate('KEY-A'), { ok: false, reason: 'unverified', released: true });
  assert.equal(noProduct.srv.active.size, 0);
  const weird = make({ server: { fetch: async (url, init) => { const body = JSON.parse(init.body); return url.endsWith('/activate') ? { status: 201, json: async () => ({ id: 'lki_9', product: 'not an object', key: body.license_key }) } : { status: 200, json: async () => null }; }, calls: [] } });
  assert.equal((await weird.lic.activate('KEY-A')).reason, 'unverified');
});

test('secret storage failure releases the seat and stores nothing', async () => {
  const s = stores({ failStore: true });
  const m = make({ stores: s });
  assert.deepEqual(await m.lic.activate('KEY-PERSONAL'), { ok: false, reason: 'storage', released: true });
  assert.equal(m.srv.active.size, 0, 'the activation must be given back');
  assert.equal(s.globalMap.has('licence.instanceId.live'), false);
  assert.equal(s.globalMap.has('licence.productId.live'), false);
  assert.match(messages.activationFailureText({ reason: 'storage', released: true }), /released again/);
  assert.match(messages.activationFailureText({ reason: 'storage', released: false }), /could not be released/);
});

test('seats: entering the same key again uses no further activation (four entries, one seat)', async () => {
  const m = make();
  assert.deepEqual(await m.lic.activate('KEY-PERSONAL'), { ok: true, licenceType: 'personal' });
  for (let k = 0; k < 3; k++) {
    const r = await m.lic.activate('KEY-PERSONAL');
    assert.deepEqual(r, { ok: true, licenceType: 'personal', already: true });
  }
  assert.equal(m.srv.seats('KEY-PERSONAL'), 1);
  assert.equal(m.srv.calls.filter((c) => c.url.endsWith('/activate')).length, 1, 'one activation request in four entries');
  assert.equal(m.srv.calls.filter((c) => c.url.endsWith('/validate')).length, 3);
  assert.match(messages.activatedText('personal', { already: true }), /no further activation was used/);
  const spaced = await m.lic.activate('  KEY-PERSONAL \n');
  assert.equal(spaced.already, true, 'spaces around the key do not matter');
  assert.equal(m.srv.seats('KEY-PERSONAL'), 1);
});

test('seats: replacing a key releases the old activation after the new one is stored', async () => {
  const m = make();
  await m.lic.activate('KEY-PERSONAL');
  const r = await m.lic.activate('KEY-BUSINESS');
  assert.deepEqual(r, { ok: true, licenceType: 'business', replaced: true, previousReleased: true });
  assert.equal(m.srv.seats('KEY-PERSONAL'), 0);
  assert.equal(m.srv.seats('KEY-BUSINESS'), 1);
  assert.equal(m.s.secretsMap.get('licence.key.live'), 'KEY-BUSINESS');
  const urls = m.srv.calls.map((c) => c.url.replace(/^.*\/licenses\//, ''));
  assert.deepEqual(urls, ['activate', 'activate', 'deactivate'], 'the old activation is released only after the new key is active');
  assert.equal(m.srv.calls[2].body.license_key, 'KEY-PERSONAL', 'the old activation is released with the old key');
  assert.match(messages.activatedText('business', r), /stored before was released/);
  const unconfirmed = make({ server: server() });
  await unconfirmed.lic.activate('KEY-PERSONAL');
  unconfirmed.srv.options.deactivateStatus = 500;
  const r2 = await unconfirmed.lic.activate('KEY-BUSINESS');
  assert.deepEqual([r2.ok, r2.replaced, r2.previousReleased], [true, true, false]);
  assert.match(messages.activatedText('business', r2), /could not be released/);
});

test('seats: a mistyped second key leaves the working licence alone', async () => {
  const m = make();
  await m.lic.activate('KEY-PERSONAL');
  assert.equal((await m.lic.activate('KEY-TYPO')).reason, 'invalid');
  assert.equal(m.s.secretsMap.get('licence.key.live'), 'KEY-PERSONAL');
  assert.equal(m.srv.seats('KEY-PERSONAL'), 1);
  assert.equal(await m.lic.isPro(), true);
});

test('seats: a lost secret store does not lose a seat on every restart', async () => {
  const srv = server();
  const s = stores();
  const first = make({ stores: s, server: srv });
  await first.lic.activate('KEY-PERSONAL');
  s.options.memoryOnly = true; // after a restart the key is gone, the activation id is still stored
  const again = make({ stores: s, server: srv });
  assert.equal(await again.lic.isPro(), false);
  const r = await again.lic.activate('KEY-PERSONAL');
  assert.deepEqual(r, { ok: true, licenceType: 'personal', already: true });
  assert.equal(srv.seats('KEY-PERSONAL'), 1);
});

test('seats: a lost key and another key entered: the old activation is not released with the wrong key', async () => {
  const srv = server();
  const s = stores();
  const first = make({ stores: s, server: srv });
  await first.lic.activate('KEY-PERSONAL');
  s.options.memoryOnly = true;
  const second = make({ stores: s, server: srv });
  const r = await second.lic.activate('KEY-BUSINESS');
  assert.equal(r.ok, true);
  assert.equal(r.licenceType, 'business');
  assert.equal(r.replaced, undefined, 'nothing is said about a release that was not tried');
  assert.equal(srv.calls.filter((c) => c.url.endsWith('/deactivate')).length, 0, 'no release request with the wrong key');
  assert.equal(srv.seats('KEY-BUSINESS'), 1);
});

test('seats: a stored activation that the server no longer knows is replaced, not added to', async () => {
  const srv = server();
  const m = make({ server: srv });
  await m.lic.activate('KEY-PERSONAL');
  srv.active.clear();
  const r = await m.lic.activate('KEY-PERSONAL');
  assert.deepEqual(r.ok && r.licenceType, 'personal');
  assert.equal(srv.seats('KEY-PERSONAL'), 1);
});

test('seats: no clear answer from the server changes nothing', async () => {
  const srv = server();
  const m = make({ server: srv });
  await m.lic.activate('KEY-PERSONAL');
  srv.options.validateStatus = 500;
  assert.deepEqual(await m.lic.activate('KEY-PERSONAL'), { ok: false, reason: 'error', status: 500 });
  assert.equal(srv.seats('KEY-PERSONAL'), 1);
  srv.options.validateStatus = 0;
  srv.options.down = true;
  assert.deepEqual(await m.lic.activate('KEY-PERSONAL'), { ok: false, reason: 'network' });
  assert.equal(srv.seats('KEY-PERSONAL'), 1);
});

test('seats: the activation limit leaves a stored licence alone', async () => {
  const srv = server({ limit: 1 });
  await make({ server: srv }).lic.activate('KEY-BUSINESS');
  const m = make({ server: srv });
  await m.lic.activate('KEY-PERSONAL');
  const r = await m.lic.activate('KEY-BUSINESS');
  assert.deepEqual(r, { ok: false, reason: 'limit', hasStored: true });
  assert.equal(m.s.secretsMap.get('licence.key.live'), 'KEY-PERSONAL');
  assert.match(messages.activationFailureText(r), /maximum number of computers \(3\).*already stored on this computer was not changed/);
});

test('activation errors map to reasons', async () => {
  assert.equal((await make({ server: server({ status: 422 }) }).lic.activate('KEY-PERSONAL')).reason, 'limit');
  assert.equal((await make({ server: server({ status: 403 }) }).lic.activate('KEY-PERSONAL')).reason, 'inactive');
  assert.equal((await make({ server: server({ status: 400 }) }).lic.activate('KEY-PERSONAL')).reason, 'invalid');
  assert.equal((await make({ server: server({ status: 500 }) }).lic.activate('KEY-PERSONAL')).reason, 'error');
  assert.equal((await make({ server: server({ status: 302 }) }).lic.activate('KEY-PERSONAL')).reason, 'error');
  assert.equal((await make({ server: server({ down: true }) }).lic.activate('KEY-PERSONAL')).reason, 'network');
  assert.equal((await make().lic.activate('NO-SUCH-KEY')).reason, 'invalid');
  for (const bad of ['', '   ', 'two words', 'x'.repeat(257), null, 42, undefined, {}, 'tab\tkey']) {
    const m = make();
    assert.equal((await m.lic.activate(bad)).reason, 'invalid', String(bad));
    assert.equal(m.srv.calls.length, 0, 'a key that is refused locally makes no request: ' + String(bad));
  }
});

test('24 hour cache, revalidation, grace period and expiry', async () => {
  const srv = server();
  const m = make({ server: srv });
  await m.lic.activate('KEY-PERSONAL');
  const after = srv.calls.length;
  assert.equal(await m.lic.isPro(), true);
  assert.equal(srv.calls.length, after, 'trusted from the cache');
  m.advance(25 * HOUR);
  assert.equal(await m.lic.isPro(), true);
  const last = srv.calls[srv.calls.length - 1];
  assert.ok(last.url.endsWith('/licenses/validate'));
  assert.deepEqual(Object.keys(last.body).sort(), ['license_key', 'license_key_instance_id'], 'the check sends the key and the activation id only');
  srv.options.down = true;
  m.advance(25 * HOUR);
  assert.equal(await m.lic.isPro(), true, 'grace while offline');
  const st = await m.lic.status(false);
  assert.equal(st.via, 'grace');
  assert.match(messages.licenceStatusText(st), /offline mode/);
  m.advance(14 * DAY);
  assert.equal(await m.lic.isPro(), false, 'grace ends after 14 days');
  srv.options.down = false;
  m.advance(6 * 60 * 1000);
  assert.equal(await m.lic.isPro(), true, 'Pro returns when the server answers again');
});

test('a clock set back after a check does not extend the cache: the server is asked again', async () => {
  const srv = server();
  const m = make({ server: srv });
  await m.lic.activate('KEY-PERSONAL');
  const before = srv.calls.length;
  m.advance(-2 * DAY);
  assert.equal(await m.lic.isPro(), true);
  assert.equal(srv.calls.length, before + 1, 'a cached answer from the future is not trusted');
});

test('concurrent checks share one request; odd answers count as an outage', async () => {
  const srv = server();
  const m = make({ server: srv });
  await m.lic.activate('KEY-PERSONAL');
  m.advance(25 * HOUR);
  const before = srv.calls.length;
  assert.deepEqual(await Promise.all([m.lic.isPro(), m.lic.isPro(), m.lic.isPro()]), [true, true, true]);
  assert.equal(srv.calls.length, before + 1);
  m.advance(25 * HOUR);
  srv.options.validateStatus = 429;
  assert.equal(await m.lic.isPro(), true, 'grace');
  assert.equal((await m.lic.status(false)).via, 'grace');
});

test('a revoked key turns Pro off at once; a running trial is still named', async () => {
  const srv = server();
  const m = make({ server: srv });
  await m.lic.startTrial();
  await m.lic.activate('KEY-PERSONAL');
  srv.options.invalid = true;
  const st = await m.lic.status(true);
  assert.equal(st.pro, false);
  assert.equal(st.via, 'rejected');
  assert.equal(await m.lic.hasAccess(), true, 'the trial still runs');
  const text = messages.licenceStatusText(st);
  assert.match(text, /no longer valid.*does not unlock Pro.*stay on through your trial/);
  assert.ok(!/so the Pro features are off/.test(text), 'the text must not say Pro is off while the trial keeps it on');
  const noTrial = make({ server: server() });
  await noTrial.lic.activate('KEY-PERSONAL');
  noTrial.srv.options.invalid = true;
  assert.match(messages.licenceStatusText(await noTrial.lic.status(true)), /so the Pro features are off/);
});

test('peek reads the stored state without any request', async () => {
  const srv = server();
  const m = make({ server: srv });
  await m.lic.activate('KEY-PERSONAL');
  const before = srv.calls.length;
  assert.equal((await m.lic.peek()).via, 'cache');
  m.advance(30 * HOUR);
  assert.equal((await m.lic.peek()).via, 'stale');
  assert.equal(srv.calls.length, before);
});

test('remove frees the activation and clears everything but the trial', async () => {
  const srv = server();
  const m = make({ server: srv });
  await m.lic.startTrial();
  await m.lic.activate('KEY-PERSONAL');
  assert.deepEqual(await m.lic.remove(), { ok: true, deactivated: true });
  assert.equal(srv.active.size, 0);
  assert.equal(m.s.secretsMap.size, 0);
  assert.deepEqual(Array.from(m.s.globalMap.keys()).filter((k) => k.startsWith('licence.')), []);
  assert.equal(m.lic.trialStatus().state, 'active', 'the trial record stays');
});

test('remove while offline still clears the key and says so', async () => {
  const srv = server();
  const m = make({ server: srv });
  await m.lic.activate('KEY-PERSONAL');
  srv.options.down = true;
  assert.deepEqual(await m.lic.remove(), { ok: true, deactivated: false, reason: 'network' });
  assert.equal(m.s.secretsMap.size, 0);
});

test('trial: unused, started at the first Pro use, exactly 14 days, reminders once a day, no network', async () => {
  const m = make();
  assert.equal(m.lic.trialStatus().state, 'unused');
  assert.equal(await m.lic.hasAccess(), false);
  const t = await m.lic.startTrial();
  assert.equal(t.state, 'active');
  assert.equal(t.daysLeft, 14);
  assert.equal(t.endsAt - t.startedAt, 14 * DAY);
  assert.equal(await m.lic.hasAccess(), true);
  assert.equal(await m.lic.noteTrialReminder(), true);
  assert.equal(await m.lic.noteTrialReminder(), false);
  m.advance(DAY + 1);
  assert.equal(await m.lic.noteTrialReminder(), true);
  assert.equal(m.lic.trialStatus().daysLeft, 13);
  m.advance(13 * DAY - 1 - 1);
  assert.equal(m.lic.trialStatus().state, 'active', 'one millisecond before the end');
  m.advance(1);
  assert.equal(m.lic.trialStatus().state, 'expired', 'at 14 days exactly');
  assert.equal(await m.lic.hasAccess(), false);
  assert.equal((await m.lic.startTrial()).state, 'expired', 'never restarts');
  assert.equal(m.srv.calls.length, 0, 'the trial uses no network');
});

test('trial: a clock set back does not stretch it', async () => {
  const m = make();
  await m.lic.startTrial();
  m.advance(10 * DAY);
  await m.lic.touchTrial();
  m.advance(-9 * DAY);
  assert.equal(m.lic.trialStatus().daysLeft, 4, 'the days used stay used');
  // After the end, a clock set back (or a start edited into the future) does not reopen the trial.
  m.advance(9 * DAY + 5 * DAY);
  assert.equal((await m.lic.checkTrial()).state, 'expired');
  m.advance(-30 * DAY);
  assert.equal(m.lic.trialStatus().state, 'expired', 'an ended trial stays ended');
  assert.equal((await m.lic.startTrial()).state, 'expired');
});

test('trial: a clock that was ahead when the trial began does not cost the user the trial', async () => {
  // The clock is 40 days ahead for the first Pro command, then 3 days of use, then it is corrected.
  const m = make();
  m.advance(40 * DAY);
  await m.lic.startTrial();
  m.advance(3 * DAY);
  await m.lic.touchTrial();
  m.advance(-43 * DAY);
  const t = await m.lic.checkTrial();
  assert.equal(t.state, 'active', 'correcting the clock does not end the trial');
  assert.equal(t.daysLeft, 11, 'the 3 days that were used stay used');
  assert.equal(await m.lic.hasAccess(), true);
  assert.equal(m.s.globalMap.get('trial.startedAt'), m.now() - 3 * DAY, 'the corrected start is written down once');
  m.advance(11 * DAY - 1);
  assert.equal(m.lic.trialStatus().state, 'active');
  m.advance(1);
  assert.equal(m.lic.trialStatus().state, 'expired');
  // A wrong year: one year ahead, immediately corrected.
  const y = make();
  y.advance(365 * DAY);
  await y.lic.startTrial();
  y.advance(-365 * DAY);
  const u = await y.lic.checkTrial();
  assert.equal(u.state, 'active');
  assert.equal(u.daysLeft, 14);
});

test('trial: an edited start in the future gains nothing beyond the time that was used; an ended trial stays ended', async () => {
  const f = make();
  f.s.globalMap.set('trial.startedAt', f.now() + 1000 * DAY);
  f.s.globalMap.set('trial.lastSeenAt', f.now() + 1000 * DAY + 5 * DAY);
  const t = await f.lic.checkTrial();
  assert.equal(t.state, 'active');
  assert.equal(t.daysLeft, 9, 'the recorded 5 days of use are kept');
  f.advance(9 * DAY);
  assert.equal((await f.lic.checkTrial()).state, 'expired');
  // Once ended, an edited start does not bring it back.
  f.s.globalMap.set('trial.startedAt', f.now() + 5 * DAY);
  assert.equal(f.lic.trialStatus().state, 'expired');
  // A recorded use that fills the whole trial ends it.
  const g = make();
  g.s.globalMap.set('trial.startedAt', g.now() + 100 * DAY);
  g.s.globalMap.set('trial.lastSeenAt', g.now() + 130 * DAY);
  assert.equal((await g.lic.checkTrial()).state, 'expired');
});

test('trial: a start less than a day ahead (small clock error) counts as it is', async () => {
  const f = make();
  f.s.globalMap.set('trial.startedAt', f.now() + 0.9 * DAY);
  f.s.globalMap.set('trial.lastSeenAt', f.now() + 0.9 * DAY);
  const t = f.lic.trialStatus();
  assert.equal(t.state, 'active');
  assert.equal(t.daysLeft, 14);
  assert.equal(f.s.globalMap.get('trial.startedAt'), f.now() + 0.9 * DAY, 'nothing is rewritten');
});

test('trial: storage that cannot be written gives "unavailable" and the notice explains it', async () => {
  const m = make({ stores: stores({ readOnly: true }) });
  const t = await m.lic.startTrial();
  assert.equal(t.state, 'unavailable');
  assert.match(messages.proNoticeText('Create DBC Documentation', t), /could not be started/);
  assert.equal((await m.lic.checkTrial()).state, 'unused');
});

test('messages: status texts name the trial, the prices and never a test environment', () => {
  const base = { pro: false, hasKey: false, mode: 'live', trial: { state: 'unused' } };
  assert.match(messages.licenceStatusText(base), /free 14-day trial/);
  assert.ok(!/test environment/.test(messages.licenceStatusText(base)));
  assert.ok(!/test environment/.test(messages.licenceStatusText(Object.assign({}, base, { mode: 'test' }))), 'the status text has no wording for a test environment');
  assert.match(messages.licenceStatusText(Object.assign({}, base, { trial: { state: 'active', daysLeft: 1, endsAt: Date.now() } })), /1 day left/);
  assert.match(messages.licenceStatusText(Object.assign({}, base, { trial: { state: 'expired', endsAt: Date.now() } })), /USD 29.*USD 59 per user/);
  assert.match(messages.licenceStatusText({ pro: false, hasKey: true, via: 'product', keyHint: '...ABCD', mode: 'live' }), /belongs to another product/);
  assert.match(messages.proNoticeText('Compare DBC With Another File', { state: 'expired', endsAt: Date.now() }), /^Compare DBC With Another File is a Pro feature of CAN Atlas\. Your 14-day trial ended/);
});

test('messages: buy choices and the users question', () => {
  const c = messages.buyChoices();
  assert.deepEqual(c.map((x) => x.tier), ['personal', 'business']);
  assert.match(c[0].description, /USD 29/);
  assert.match(c[1].description, /USD 59 per user/);
  assert.match(c[0].detail, /one person.*3 of your computers.*use at work is allowed/);
  assert.match(c[1].detail, /One key per user/);
  assert.equal(messages.businessUsersQuestion(), 'How many users? (1-100)');
  for (const ok of ['1', '42', ' 100 ', '007']) assert.equal(messages.businessUsersError(ok), null, ok);
  for (const bad of ['0', '101', '1.5', 'ten', '', '-3', '1e2', '+5', '0x10', '1 000', '９', undefined, null, '1,000', '2147483648']) assert.ok(messages.businessUsersError(bad), String(bad));
});

test('messages: every failure reason has an actionable sentence', () => {
  for (const reason of ['limit', 'invalid', 'inactive', 'network', 'product', 'unverified', 'storage', 'error']) {
    const t = messages.activationFailureText({ reason: reason, status: 500 });
    assert.ok(t.length > 40, reason);
  }
  assert.match(messages.activationFailureText({ reason: 'network' }), /live\.dodopayments\.com/);
  assert.match(messages.activationFailureText({ reason: 'storage', kept: true }), /nothing was changed/);
  assert.match(messages.lostKeyText(), /Dodo Payments/);
  assert.match(messages.removeConfirmText(), /frees one of the 3 activations/);
});

test('the activation name is a platform label, never a host name', () => {
  assert.equal(L.instanceName('win32'), 'VS Code on Windows');
  assert.equal(L.instanceName('darwin'), 'VS Code on macOS');
  assert.equal(L.instanceName('linux'), 'VS Code on Linux');
  assert.equal(L.instanceName('freebsd'), 'VS Code on freebsd');
  assert.equal(L.instanceName(undefined), 'VS Code on unknown');
});
