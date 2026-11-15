'use strict';
// Licence handling for the Pro tier. Only the public licence endpoints are used:
//   POST /licenses/activate    { license_key, name }                       -> 201 { id, product: { product_id, name }, customer: {...}, ... }
//   POST /licenses/validate    { license_key, license_key_instance_id }    -> 200 { valid }
//   POST /licenses/deactivate  { license_key, license_key_instance_id }    -> 200, empty body
// The key lives in the editor's secret storage; the activation id, the product id and the times
// of the last checks live in global state. A successful validation is trusted for 24 hours; when
// the server cannot be reached, the last successful validation keeps Pro working for 14 days.
//
// A key only unlocks Pro when the activation answer names one of the products in
// config.ALLOWED_PRODUCT_IDS (the validation answer carries only `valid`). Nothing else of the
// activation answer is kept: not the customer block, not the buyer's name or e-mail address.
//
// Entering a key never uses up an activation it does not need: the same key again is validated
// instead of activated; another key replaces the stored one only after it is active and stored,
// and then the activation of the old key is released. When the new key cannot be stored, its
// activation is released and the stored licence is put back exactly as it was.
//
// A key that the server rejected does not come back through the offline grace period: the grace
// only covers a server that cannot be reached after a successful check.
//
// The free trial lives here too. It is recorded only in the editor's global state of this machine
// (start time, last use, end, last reminder), never sent anywhere, and needs no key and no
// network. It starts when the user first runs a Pro feature, not at install. Once the trial was
// seen as ended it stays ended (trial.expiredAt), also when the clock is set back. A start time
// in the future (the clock was ahead when the trial began and has been corrected) does not end the
// trial: the time that was really used is kept and the start is moved back from now by it.
//
// No editor API is used: storage and the network function are injected (unit-testable).

const config = require('./config');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CACHE_MS = config.cacheHours * HOUR_MS;
const GRACE_MS = config.graceDays * DAY_MS;
const TRIAL_MS = config.trialDays * DAY_MS;
const REMINDER_MS = DAY_MS;
const RETRY_BACKOFF_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_KEY_LENGTH = 256;

const TRIAL_KEYS = Object.freeze({
  startedAt: 'trial.startedAt', lastSeenAt: 'trial.lastSeenAt', lastNoticeAt: 'trial.lastNoticeAt', expiredAt: 'trial.expiredAt',
  rebasedFrom: 'trial.rebasedFrom', rebasedSeen: 'trial.rebasedSeen'
});

function platformLabel(platform) {
  switch (platform) {
    case 'win32': return 'Windows';
    case 'darwin': return 'macOS';
    case 'linux': return 'Linux';
    default: return String(platform || 'unknown');
  }
}

/**
 * The name of the editor application for the activation label: the product name the editor reports
 * (vscode.env.appName), cut down to plain letters, digits and a few signs and at most 32 characters;
 * 'VS Code' when it is missing or unusable. "Visual Studio Code" is written "VS Code".
 */
function editorLabel(editorName) {
  let name = typeof editorName === 'string' ? editorName.replace(/[^A-Za-z0-9 .+-]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  name = name.replace(/^Visual Studio Code\b/i, 'VS Code').slice(0, 32).trim();
  return name || 'VS Code';
}

/** The label sent as the activation name: `<editor> on <platform>`, for example `VS Code on Windows` (never the host name). */
function instanceName(platform, editorName) { return editorLabel(editorName) + ' on ' + platformLabel(platform); }

function asTime(value) { return typeof value === 'number' && isFinite(value) ? value : 0; }
function okStatus(s) { return s === 200 || s === 201 || s === 204; }

/**
 * Creates the licence service. Options: secrets (async get/store/delete), globalState
 * (get/update), fetch, now, getMode ('live' in an installed copy), platform. Never throws.
 */
function createLicence(options) {
  const secrets = options.secrets;
  const state = options.globalState;
  const now = options.now || Date.now;
  const getMode = options.getMode || function () { return 'live'; };
  const platform = options.platform || process.platform;
  const editorName = options.editorName;
  let inflight = null;
  let retryNotBefore = 0;

  function env() { return config.resolve(getMode()); }
  function names() {
    const mode = env().mode;
    return {
      key: 'licence.key.' + mode, instance: 'licence.instanceId.' + mode, product: 'licence.productId.' + mode,
      checkedAt: 'licence.checkedAt.' + mode, checkedValid: 'licence.checkedValid.' + mode, lastGood: 'licence.lastGoodAt.' + mode
    };
  }
  async function readKey(n) {
    try { const k = await secrets.get(n.key); return typeof k === 'string' && k ? k : undefined; } catch (e) { return undefined; }
  }
  function readInstance(n) { const v = state.get(n.instance); return typeof v === 'string' && v ? v : undefined; }

  async function post(path, body) {
    const fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch : null);
    if (typeof fetchImpl !== 'function') return { status: 0, data: null, networkError: true };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
    try {
      const res = await fetchImpl(env().api + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { status: res.status, data: data };
    } catch (e) {
      return { status: 0, data: null, networkError: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function evaluate(force) {
    const n = names();
    const key = await readKey(n);
    const instanceId = readInstance(n);
    const mode = env().mode;
    if (!key || !instanceId) return { pro: false, via: 'none', mode: mode, hasKey: !!key };
    const licenceType = config.licenceTypeOf(mode, state.get(n.product));
    if (!licenceType) return { pro: false, via: 'product', mode: mode, hasKey: true, key: key };
    const t = now();
    const lastGoodAt = asTime(state.get(n.lastGood));
    const checkedAt = asTime(state.get(n.checkedAt));
    const age = t - checkedAt;
    if (!force && checkedAt && age >= 0 && age < CACHE_MS) {
      const cachedValid = state.get(n.checkedValid) === true;
      return { pro: cachedValid, via: cachedValid ? 'cache' : 'rejected', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: lastGoodAt, checkedAt: checkedAt, key: key };
    }
    let result = null;
    if (force || t >= retryNotBefore) result = await post('/licenses/validate', { license_key: key, license_key_instance_id: instanceId });
    if (result && result.status === 200 && result.data && typeof result.data.valid === 'boolean') {
      retryNotBefore = 0;
      await state.update(n.checkedAt, t);
      await state.update(n.checkedValid, result.data.valid);
      if (result.data.valid) {
        await state.update(n.lastGood, t);
        return { pro: true, via: 'server', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: t, checkedAt: t, key: key };
      }
      // A key the server rejected must not come back through the offline grace period.
      await state.update(n.lastGood, undefined);
      return { pro: false, via: 'rejected', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: 0, checkedAt: t, key: key };
    }
    if (result && (result.status === 403 || result.status === 404 || result.status === 422)) {
      retryNotBefore = 0;
      await state.update(n.checkedAt, t);
      await state.update(n.checkedValid, false);
      await state.update(n.lastGood, undefined);
      return { pro: false, via: 'rejected', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: 0, checkedAt: t, key: key };
    }
    if (result) retryNotBefore = t + RETRY_BACKOFF_MS;
    if (state.get(n.checkedValid) === false) {
      // The last answer of the server was a rejection; an unreachable server does not change that.
      return { pro: false, via: 'rejected', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: 0, checkedAt: checkedAt, key: key };
    }
    const graceAge = t - lastGoodAt;
    if (lastGoodAt && graceAge >= 0 && graceAge < GRACE_MS) {
      return { pro: true, via: 'grace', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: lastGoodAt, graceEndsAt: lastGoodAt + GRACE_MS, key: key };
    }
    return { pro: false, via: 'expired', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: lastGoodAt, key: key };
  }

  /** True when a valid licence is active (cached 24 h, shared in-flight check, 14-day grace). */
  function isPro() {
    if (inflight) return inflight;
    inflight = evaluate(false).then(function (r) { return r.pro === true; }, function () { return false; })
      .then(function (value) { inflight = null; return value; });
    return inflight;
  }

  /** Detailed state for Show Licence Status; `force` asks the server now. The key is never returned in full. */
  async function status(force) {
    let r;
    try { r = await evaluate(force === true); } catch (e) { r = { pro: false, via: 'none', mode: env().mode, hasKey: false }; }
    return {
      pro: r.pro, via: r.via, mode: r.mode, hasKey: r.hasKey, lastGoodAt: r.lastGoodAt || 0, graceEndsAt: r.graceEndsAt || 0,
      keyHint: r.key ? '...' + r.key.slice(-4) : '', licenceType: r.licenceType || '', trial: trialStatus()
    };
  }

  /**
   * The licence state from what is stored, without any network request (for the diagnostics
   * block): { pro, via: cache | rejected | stale | product | none, mode, hasKey, licenceType, trial }.
   */
  async function peek() {
    const mode = env().mode;
    try {
      const n = names();
      const key = await readKey(n);
      const instanceId = readInstance(n);
      if (!key || !instanceId) return { pro: false, via: 'none', mode: mode, hasKey: !!key, trial: trialStatus() };
      const licenceType = config.licenceTypeOf(mode, state.get(n.product));
      if (!licenceType) return { pro: false, via: 'product', mode: mode, hasKey: true, trial: trialStatus() };
      const checkedAt = asTime(state.get(n.checkedAt));
      const age = now() - checkedAt;
      const fresh = checkedAt > 0 && age >= 0 && age < CACHE_MS;
      const valid = state.get(n.checkedValid) === true;
      return { pro: fresh && valid, via: !fresh ? 'stale' : valid ? 'cache' : 'rejected', mode: mode, hasKey: true, licenceType: licenceType, trial: trialStatus() };
    } catch (e) {
      return { pro: false, via: 'none', mode: mode, hasKey: false, trial: { state: 'unused' } };
    }
  }

  /**
   * Activates a key on this machine. Resolves to { ok: true, licenceType, already?, replaced?,
   * previousReleased? } or { ok: false, reason, released?, kept?, hasStored? } with reason
   * invalid | inactive | limit | network | storage | product | unverified | error.
   */
  async function activate(rawKey) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key || key.length > MAX_KEY_LENGTH || /\s/.test(key)) return { ok: false, reason: 'invalid' };
    const n = names();
    const mode = env().mode;
    const oldKey = await readKey(n);
    let oldInstance = readInstance(n);
    const oldType = config.licenceTypeOf(mode, state.get(n.product));
    const oldValues = [n.instance, n.product, n.checkedAt, n.checkedValid, n.lastGood].map(function (k) { return [k, state.get(k)]; });

    // The stored activation may already belong to this key: validate instead of activating again.
    if (oldInstance && oldType && (oldKey === key || !oldKey)) {
      const v = await post('/licenses/validate', { license_key: key, license_key_instance_id: oldInstance });
      if (v.status === 200 && v.data && v.data.valid === true) {
        const t = now();
        try {
          if (!oldKey) await secrets.store(n.key, key);
          await state.update(n.checkedAt, t);
          await state.update(n.checkedValid, true);
          await state.update(n.lastGood, t);
        } catch (e) {
          return { ok: false, reason: 'storage', released: false, kept: true };
        }
        retryNotBefore = 0;
        return { ok: true, licenceType: oldType, already: true };
      }
      const answered = (v.status === 200 && v.data && v.data.valid === false) || v.status === 403 || v.status === 404 || v.status === 422;
      // No clear answer: do not risk a second activation; nothing is changed.
      if (!answered) return v.networkError ? { ok: false, reason: 'network' } : { ok: false, reason: 'error', status: v.status };
      // The stored activation does not belong to this key (or is gone): a new one replaces it.
      if (oldKey === key || !oldKey) oldInstance = undefined;
    }

    const r = await post('/licenses/activate', { license_key: key, name: instanceName(platform, editorName) });
    if ((r.status === 200 || r.status === 201) && r.data && typeof r.data.id === 'string' && r.data.id) {
      const t = now();
      const release = async function () {
        const d = await post('/licenses/deactivate', { license_key: key, license_key_instance_id: r.data.id });
        return okStatus(d.status);
      };
      const product = r.data.product;
      const productId = product && typeof product === 'object' && typeof product.product_id === 'string' ? product.product_id : '';
      const licenceType = config.licenceTypeOf(mode, productId);
      if (!licenceType) return { ok: false, reason: productId ? 'product' : 'unverified', released: await release() };
      try {
        await secrets.store(n.key, key);
        await state.update(n.instance, r.data.id);
        await state.update(n.product, productId);
        await state.update(n.checkedAt, t);
        await state.update(n.checkedValid, true);
        await state.update(n.lastGood, t);
      } catch (e) {
        // The new licence cannot be kept on this machine: its activation is given back, and the
        // licence that was stored before (if any) is put back exactly as it was.
        const released = await release();
        if (oldKey) { try { await secrets.store(n.key, oldKey); } catch (e2) { /* left as it is */ } }
        else { try { await secrets.delete(n.key); } catch (e2) { /* nothing stored */ } }
        for (const pair of oldValues) { try { await state.update(pair[0], pair[1]); } catch (e2) { /* left as it is */ } }
        const failed = { ok: false, reason: 'storage', released: released };
        if (oldKey && oldInstance) {
          const keyNow = await readKey(n);
          failed.previousKept = keyNow === oldKey && state.get(n.instance) === oldInstance;
        }
        return failed;
      }
      retryNotBefore = 0;
      const result = { ok: true, licenceType: licenceType };
      // The new licence is stored; now give back the activation it replaced.
      if (oldInstance && oldInstance !== r.data.id) {
        const d = await post('/licenses/deactivate', { license_key: oldKey || key, license_key_instance_id: oldInstance });
        result.replaced = true;
        result.previousReleased = okStatus(d.status);
      }
      return result;
    }
    if (r.networkError) return { ok: false, reason: 'network' };
    if (r.status === 422) return { ok: false, reason: 'limit', hasStored: !!(oldKey && oldInstance) };
    if (r.status === 403) return { ok: false, reason: 'inactive' };
    if (r.status === 404 || r.status === 400) return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'error', status: r.status };
  }

  /**
   * Removes the licence: frees the activation (best effort) and always clears the local key and state.
   * Resolves to { ok: true, deactivated } and, when the activation was not freed, reason 'network'
   * (the server could not be reached), 'status' (the server answered with a refusal; `status` is
   * the HTTP status) or 'error'.
   */
  async function remove() {
    const n = names();
    let deactivated = false;
    let reason = '';
    let httpStatus = 0;
    try {
      const key = await readKey(n);
      const instanceId = readInstance(n);
      if (key && instanceId) {
        const r = await post('/licenses/deactivate', { license_key: key, license_key_instance_id: instanceId });
        deactivated = okStatus(r.status);
        if (!deactivated) { reason = r.networkError ? 'network' : 'status'; httpStatus = r.status; }
      } else deactivated = true;
    } catch (e) { deactivated = false; reason = 'error'; }
    try { await secrets.delete(n.key); } catch (e) { /* nothing stored */ }
    for (const k of [n.instance, n.product, n.checkedAt, n.checkedValid, n.lastGood]) {
      try { await state.update(k, undefined); } catch (e) { /* read-only state */ }
    }
    retryNotBefore = 0;
    const out = { ok: true, deactivated: deactivated };
    if (!deactivated) { out.reason = reason || 'error'; if (httpStatus) out.status = httpStatus; }
    return out;
  }

  /** Checkout link: Personal without arguments; tier 'business' with users (1-100). */
  function buyUrl(tier, users) {
    if (tier === undefined) return env().buyUrl;
    return config.buyUrlFor(env().mode, tier, users);
  }

  // ---- trial --------------------------------------------------------------------------------

  function trialNow() { return Math.max(now(), asTime(state.get(TRIAL_KEYS.lastSeenAt))); }

  // The end of the trial is written down the first time it is seen, so that a clock set back
  // later cannot reopen it. A failed write is tried again at the next look.
  let endWrite = null;
  function rememberEnd(value) {
    if (endWrite) return;
    try {
      endWrite = Promise.resolve(state.update(TRIAL_KEYS.expiredAt, Math.max(1, value))).then(undefined, function () { endWrite = null; });
    } catch (e) { endWrite = null; }
  }

  // A start time more than a day ahead of the clock means that the clock was set back, or was ahead
  // when the trial began and has been corrected since (or that the record was edited). The time that
  // was really used is kept: the start is moved back from now by the time used so far, and written
  // down once. The start and the last use that were replaced are kept too (trial.rebasedFrom and
  // trial.rebasedSeen): when the clock has come back to where it was, they are put back, so that a
  // clock that was wrong for a while costs the user no days. A trial is never ended by a clock
  // correction, and a correction gains nothing either.
  let rebaseWrite = null;
  function rememberRebase(startedAt, seenAt, from, seen) {
    if (rebaseWrite) return;
    rebaseWrite = (async function () {
      try {
        if (!asTime(state.get(TRIAL_KEYS.rebasedFrom))) {
          await state.update(TRIAL_KEYS.rebasedFrom, from);
          await state.update(TRIAL_KEYS.rebasedSeen, seen);
        }
        await state.update(TRIAL_KEYS.startedAt, startedAt);
        await state.update(TRIAL_KEYS.lastSeenAt, seenAt);
      } catch (e) { /* read-only state: tried again at the next look */ } finally { rebaseWrite = null; }
    })();
  }
  let restoreWrite = null;
  function rememberRestore(startedAt, seenAt) {
    if (restoreWrite) return;
    restoreWrite = (async function () {
      try {
        await state.update(TRIAL_KEYS.startedAt, startedAt);
        await state.update(TRIAL_KEYS.lastSeenAt, seenAt);
        await state.update(TRIAL_KEYS.rebasedFrom, undefined);
        await state.update(TRIAL_KEYS.rebasedSeen, undefined);
      } catch (e) { /* read-only state: tried again at the next look */ } finally { restoreWrite = null; }
    })();
  }

  /**
   * { state: unused | active | expired, startedAt, endsAt, daysLeft, lastNoticeAt }. A trial that
   * was once seen as ended stays ended (trial.expiredAt), also when the clock is set back. A start
   * time more than a day in the future is re-anchored (see above). The only side effects are that
   * the end, or the re-anchored start, is written down the first time it is seen.
   */
  function trialStatus() {
    let startedAt = asTime(state.get(TRIAL_KEYS.startedAt));
    const lastNoticeAt = asTime(state.get(TRIAL_KEYS.lastNoticeAt));
    if (!startedAt) return { state: 'unused', startedAt: 0, endsAt: 0, daysLeft: config.trialDays, lastNoticeAt: lastNoticeAt };
    const expiredAt = asTime(state.get(TRIAL_KEYS.expiredAt));
    const current = now();
    let t = trialNow();
    // The clock is back where it was before it was set back: the original start and last use are put back.
    const rebasedFrom = asTime(state.get(TRIAL_KEYS.rebasedFrom));
    const rebasedSeen = asTime(state.get(TRIAL_KEYS.rebasedSeen));
    if (!expiredAt && rebasedFrom && rebasedSeen && current >= rebasedSeen - DAY_MS) {
      startedAt = rebasedFrom;
      t = Math.max(current, rebasedSeen);
      rememberRestore(startedAt, t);
    }
    if (!expiredAt && startedAt > current + DAY_MS) {
      const lastSeen = asTime(state.get(TRIAL_KEYS.lastSeenAt));
      const usedMs = Math.min(TRIAL_MS, Math.max(0, lastSeen - startedAt));
      const from = rebasedFrom || startedAt;
      const seen = rebasedSeen || lastSeen || startedAt;
      startedAt = current - usedMs;
      t = current;
      rememberRebase(startedAt, current, from, seen);
    }
    const endsAt = startedAt + TRIAL_MS;
    if (expiredAt || t >= endsAt) {
      const shownEnd = expiredAt ? Math.min(endsAt, expiredAt) : endsAt;
      if (!expiredAt) rememberEnd(Math.min(endsAt, t));
      return { state: 'expired', startedAt: startedAt, endsAt: shownEnd, daysLeft: 0, lastNoticeAt: lastNoticeAt };
    }
    const daysLeft = Math.min(config.trialDays, Math.max(1, Math.ceil((endsAt - t) / DAY_MS)));
    return { state: 'active', startedAt: startedAt, endsAt: endsAt, daysLeft: daysLeft, lastNoticeAt: lastNoticeAt };
  }

  /** Starts the trial when it was never started; { state: 'unavailable' } when storage refuses. */
  async function startTrial() {
    const current = trialStatus();
    if (current.state !== 'unused') return current;
    const t = now();
    try {
      await state.update(TRIAL_KEYS.startedAt, t);
      await state.update(TRIAL_KEYS.lastSeenAt, t);
    } catch (e) {
      try { await state.update(TRIAL_KEYS.startedAt, undefined); } catch (e2) { /* nothing stored */ }
      return { state: 'unavailable', startedAt: 0, endsAt: 0, daysLeft: 0, lastNoticeAt: 0 };
    }
    return trialStatus();
  }

  /** Records a use of the trial and, once it is seen, its end (keeps the trial clock from running backwards). Never throws. */
  async function touchTrial() {
    if (!asTime(state.get(TRIAL_KEYS.startedAt))) return;
    const t = now();
    if (t > asTime(state.get(TRIAL_KEYS.lastSeenAt))) {
      try { await state.update(TRIAL_KEYS.lastSeenAt, t); } catch (e) { /* read-only state */ }
    }
    trialStatus();
    if (rebaseWrite) await rebaseWrite;
    if (restoreWrite) await restoreWrite;
    if (endWrite) await endWrite;
  }

  /** Trial status after recording the last use and, when it has ended, the end. Never throws. */
  async function checkTrial() {
    try { await touchTrial(); } catch (e) { /* read-only state */ }
    return trialStatus();
  }

  /** True when a trial reminder may be shown now (at most one a day); records it. */
  async function noteTrialReminder() {
    const t = now();
    const last = asTime(state.get(TRIAL_KEYS.lastNoticeAt));
    if (last && t - last < REMINDER_MS && t >= last) return false;
    try { await state.update(TRIAL_KEYS.lastNoticeAt, t); } catch (e) { /* read-only state */ }
    return true;
  }

  /** True when Pro may be used now: a valid licence or an active trial. Never starts the trial. */
  async function hasAccess() {
    if (await isPro()) return true;
    return (await checkTrial()).state === 'active';
  }

  return { isPro: isPro, hasAccess: hasAccess, status: status, peek: peek, activate: activate, remove: remove, buyUrl: buyUrl, trialStatus: trialStatus, startTrial: startTrial, touchTrial: touchTrial, checkTrial: checkTrial, noteTrialReminder: noteTrialReminder };
}

module.exports = { createLicence: createLicence, instanceName: instanceName, editorLabel: editorLabel, platformLabel: platformLabel, CACHE_MS: CACHE_MS, GRACE_MS: GRACE_MS, TRIAL_MS: TRIAL_MS, TRIAL_KEYS: TRIAL_KEYS };
