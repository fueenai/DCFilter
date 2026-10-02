const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const api = require('../src/release-updates.js');

const published = (version, patch = {}) => ({
  draft: false, prerelease: true, tag_name: `v${version}`,
  html_url: `${api.RELEASES_URL}/tag/v${version}`, ...patch
});
const now = 1800000000000;
const cached = (patch = {}) => ({
  schema: 1, lastAttemptAt: now - 2 * api.CHECK_INTERVAL, lastSuccessAt: now - 2 * api.CHECK_INTERVAL,
  latest: api.selectLatest([published('0.7.0')]), retryAt: 0, error: '', ...patch
});

test('extension versions compare numerically and reject invalid manifest versions', () => {
  assert.equal(api.compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(api.compareVersions('1.2', '1.2.0.0'), 0);
  assert.equal(api.compareVersions('1.2.0.1', '1.2'), 1);
  for (const value of ['0', '0.0.0', '01.2', '1.65536', '1.2.3.4.5', '1.2-beta', '', null]) {
    assert.equal(api.parseVersion(value), null, String(value));
    assert.equal(api.compareVersions(value, '1.0'), null);
  }
});

test('newest numeric release wins regardless of API order, including prereleases', () => {
  const list = [published('0.9.0'), published('0.6.3'), published('0.10.0'), published('1.0', { draft: true })];
  assert.equal(api.selectLatest(list).version, '0.10.0');
  assert.equal(api.selectLatest(list.reverse()).version, '0.10.0');
  assert.equal(api.selectLatest([published('1.0'), published('1.0', { prerelease: false })]).prerelease, false);
  assert.equal(api.selectLatest([]), null);
  assert.throws(() => api.selectLatest({ message: 'error' }));
  assert.throws(() => api.selectLatest(Array(101).fill(published('1.0'))));
});

test('release links and cached links cannot leave the exact repository and tag', () => {
  const valid = published('0.8.0');
  for (const html_url of [
    'https://github.com/other/DCFilter/releases/tag/v0.8.0',
    'https://github.com/fueenai/Other/releases/tag/v0.8.0',
    'javascript:alert(1)',
    'https://github.com@evil.example/fueenai/DCFilter/releases/tag/v0.8.0',
    `${valid.html_url}?redirect=https://evil.example`,
    `${valid.html_url}#foo`,
    valid.html_url.replace('github.com', 'github.com:444'),
    valid.html_url.replace('https:', 'http:'),
    valid.html_url.replace('v0.8.0', 'v1.0.0')
  ]) assert.equal(api.selectLatest([{ ...valid, html_url }]), null, html_url);
  const corrupt = cached({ latest: { ...api.selectLatest([valid]), url: 'https://evil.example' } });
  assert.equal(api.normalizeCache(corrupt, now).lastSuccessAt, 0);
  assert.equal(api.normalizeCache(corrupt, now).latest, null);
  assert.equal(api.normalizeRelease({ ...api.selectLatest([valid]), tag: '../evil' }), null);
});

test('cache limits automatic checks to daily and manual checks to one minute', () => {
  const fresh = api.normalizeCache(cached({ lastAttemptAt: now, lastSuccessAt: now }), now);
  assert.equal(api.shouldCheck(fresh, now + 1000, false), false);
  assert.equal(api.shouldCheck(fresh, now + 1000, true), false);
  assert.equal(api.shouldCheck(fresh, now + api.MANUAL_INTERVAL, true), true);
  assert.equal(api.shouldCheck(fresh, now + api.CHECK_INTERVAL, false), true);
  assert.equal(api.shouldCheck({ ...fresh, retryAt: now + 120000 }, now + 60000, true), false);
  const future = api.normalizeCache(cached({ lastAttemptAt: now + 1000, lastSuccessAt: now + 1000 }), now);
  assert.equal(api.shouldCheck(future, now, false), true);
});

test('display distinguishes installed, newer, no published version, and stale results', () => {
  assert.match(api.describe(cached(), '0.6.3').message, /시험 버전/);
  assert.equal(api.describe(cached(), '0.6.3').url, `${api.RELEASES_URL}/tag/v0.7.0`);
  assert.match(api.describe(cached(), '0.7.0').message, /최신/);
  assert.equal(api.describe(cached(), '0.7.0').url, '');
  assert.match(api.describe(cached(), '0.8.0').message, /공개 버전/);
  assert.match(api.describe(cached({ latest: null }), '0.6.3').message, /찾지 못/);
  assert.match(api.describe(cached({ error: 'offline' }), '0.6.3').message, /마지막 확인 결과/);
  assert.equal(api.describe(cached({ error: 'offline' }), '0.6.3').url, `${api.RELEASES_URL}/tag/v0.7.0`);
});

function response(body, options = {}) {
  const value = new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: options.status || 200,
    headers: { 'content-type': 'application/json', ...options.headers }
  });
  Object.defineProperty(value, 'url', { value: options.url || api.API_URL });
  return value;
}

async function popup({ cache, fetcher, setTimeout: schedule = setTimeout } = {}) {
  const elements = Object.fromEntries(['updateStatus', 'checkUpdates', 'updateReleaseLink'].map(id => [id, {
    textContent: '', disabled: false, hidden: false, listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; }
  }]));
  const storage = cache === undefined ? {} : { [api.CACHE_KEY]: cache };
  const calls = [];
  const context = {
    window: { DCFilterReleaseUpdates: api, setTimeout: schedule, clearTimeout },
    document: { getElementById: id => elements[id] },
    chrome: {
      runtime: { getManifest: () => ({ version: '0.6.3' }) },
      storage: { local: { get: async () => storage, set: async values => Object.assign(storage, values) } }
    },
    Date: class extends Date { static now() { return now; } },
    AbortController, TextDecoder,
    fetch: async (...args) => { calls.push(args); return (fetcher || (() => response([published('0.7.0')])))(...args); }
  };
  vm.runInNewContext(fs.readFileSync('popup/updates.js', 'utf8'), context);
  for (let count = 0; count < 8; count++) await new Promise(resolve => setImmediate(resolve));
  return { elements, storage, calls };
}

test('popup checks with no credentials and publishes only a trusted download page', async () => {
  const { elements, storage, calls } = await popup();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], api.API_URL);
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].referrerPolicy, 'no-referrer');
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].body, undefined);
  assert.equal(elements.updateReleaseLink.href, `${api.RELEASES_URL}/tag/v0.7.0`);
  assert.equal(elements.updateReleaseLink.hidden, false);
  assert.equal(elements.updateReleaseLink.rel, 'noopener noreferrer');
  assert.equal(elements.checkUpdates.disabled, false);
  assert.equal(storage[api.CACHE_KEY].lastSuccessAt, now);
  await elements.checkUpdates.listeners.click();
  assert.equal(calls.length, 1, 'manual double clicks do not issue another request');
});

test('fresh popup cache skips automatic network requests, manual check can refresh after one minute', async () => {
  const { calls, elements } = await popup({ cache: cached({ lastAttemptAt: now - 120000, lastSuccessAt: now - 120000 }) });
  assert.equal(calls.length, 0);
  assert.match(elements.updateStatus.textContent, /0.7.0/);
  await elements.checkUpdates.listeners.click();
  assert.equal(calls.length, 1);
});

test('offline and rate-limit failures retain the last trusted result and retry state', async () => {
  const offline = await popup({ cache: cached(), fetcher: () => { throw new TypeError('fetch failed'); } });
  assert.match(offline.elements.updateStatus.textContent, /연결하지 못/);
  assert.match(offline.elements.updateStatus.textContent, /마지막 확인 결과/);
  assert.equal(offline.elements.updateReleaseLink.hidden, false);
  assert.equal(offline.storage[api.CACHE_KEY].error, 'offline');
  const limited = await popup({ cache: cached(), fetcher: () => response({}, {
    status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 3600) }
  }) });
  assert.match(limited.elements.updateStatus.textContent, /요청 한도/);
  assert.equal(limited.storage[api.CACHE_KEY].retryAt, now + 3600000);
  await limited.elements.checkUpdates.listeners.click();
  assert.equal(limited.calls.length, 1);
});

test('unexpected origin, excessive response size, and malformed JSON never become current results', async () => {
  const bad = [
    () => response([published('99.0')], { url: 'https://evil.example/releases' }),
    () => response([published('99.0')], { headers: { 'content-length': '2000000' } }),
    () => response(' '.repeat(1024 * 1024 + 1)),
    () => response('this is not JSON'),
    () => response({ message: 'not a release list' })
  ];
  for (const fetcher of bad) {
    const ui = await popup({ cache: cached(), fetcher });
    assert.equal(ui.storage[api.CACHE_KEY].error, 'response');
    assert.equal(ui.storage[api.CACHE_KEY].latest.version, '0.7.0');
    assert.match(ui.elements.updateStatus.textContent, /마지막 확인 결과/);
  }
});

test('a timed-out request reports timeout and re-enables checking', async () => {
  const ui = await popup({
    setTimeout: callback => setTimeout(callback, 0),
    fetcher: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })
  });
  // Timers and immediate queues can interleave differently between Node versions.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ui.storage[api.CACHE_KEY].error, 'timeout');
  assert.match(ui.elements.updateStatus.textContent, /초과/);
  assert.equal(ui.elements.checkUpdates.disabled, false);
});
