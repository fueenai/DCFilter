const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const copy = value => JSON.parse(JSON.stringify(value));
function setup(raw = {}, href = 'https://gall.dcinside.com/mgallery/board/lists/?id=sff') {
  const data = copy(raw), writes = [], removals = [];
  const context = { window: {}, location: { href }, URL, TextEncoder, chrome: { storage: { sync: {
    async get(query) {
      if (query === null) return copy(data);
      if (typeof query === 'string') return Object.hasOwn(data, query) ? { [query]: copy(data[query]) } : {};
      return Object.fromEntries(Object.entries(query).map(([key, fallback]) => [key, copy(Object.hasOwn(data, key) ? data[key] : fallback)]));
    },
    async set(values) { writes.push(copy(values)); Object.assign(data, copy(values)); },
    async remove(name) { removals.push(name); delete data[name]; }
  } } } };
  vm.runInNewContext(fs.readFileSync('src/storage.js', 'utf8'), context);
  return { api: context.window.DCFilterStorage, data, writes, removals };
}

test('gallery URL keys distinguish major, minor, mini and person boards', () => {
  const { api } = setup();
  const cases = [
    ['https://gall.dcinside.com/board/lists/?id=sff', 'major:sff'],
    ['https://gall.dcinside.com/mgallery/board/view/?id=sff&no=123', 'minor:sff'],
    ['https://gall.dcinside.com/mini/board/lists?id=some_test-1', 'mini:some_test-1'],
    ['https://gall.dcinside.com/person/board/view?id=member&no=123#comments', 'person:member']
  ];
  for (const [url, expected] of cases) assert.equal(api.galleryKeyFromUrl(url), expected);
  for (const key of ['minor:sff', 'major:sff', 'mini:a-b_1', 'person:member']) assert.equal(api.validGalleryKey(key), true);
  for (const key of [null, 123, {}, 'sff', 'gallery:sff', 'minor:', 'minor:UPPER', 'minor:../sff', `minor:${'x'.repeat(81)}`]) {
    assert.equal(api.validGalleryKey(key), false, String(key));
  }
});

test('gallery URL parser rejects other origins, unsupported routes and malformed identifiers', () => {
  const { api } = setup();
  for (const url of [
    'http://gall.dcinside.com/mgallery/board/lists/?id=sff',
    'https://gall.dcinside.com.evil.example/mgallery/board/lists/?id=sff',
    'https://example.com/mgallery/board/lists/?id=sff',
    'https://user@gall.dcinside.com/mgallery/board/lists/?id=sff',
    'https://user:password@gall.dcinside.com/mgallery/board/lists/?id=sff',
    'https://gall.dcinside.com:8443/mgallery/board/lists/?id=sff',
    'https://gall.dcinside.com/mgallery/board/delete/?id=sff',
    'https://gall.dcinside.com/mgallery/board/lists/?id=../sff',
    'https://gall.dcinside.com/mgallery/board/lists/?id=',
    'https://gall.dcinside.com/mgallery/board/lists/',
    '/mgallery/board/lists/?id=sff', 'not a URL'
  ]) assert.equal(api.galleryKeyFromUrl(url), '', url);
});

test('profiles override only supported keys and remain isolated by board type and gallery', async () => {
  const { api, data } = setup({ imageSafety: true, botCommentFilter: true, blockKeywords: ['공통'], hideAds: false });
  await api.saveGalleryProfile('minor:sff', { imageSafety: false, blockKeywords: ['갤러리'], hideAds: true, botCommentAllowlist: ['무시'] });
  await api.saveGalleryProfile('minor:ai_utilize', { botCommentFilter: false });
  assert.deepEqual(data['galleryProfile:minor:sff'], { imageSafety: false, blockKeywords: ['갤러리'] });
  const sff = await api.loadSettings('minor:sff');
  assert.equal(sff.imageSafety, false);
  assert.deepEqual(copy(sff.blockKeywords), ['갤러리']);
  assert.equal(sff.botCommentFilter, true);
  assert.equal(sff.hideAds, false);
  assert.equal((await api.loadSettings('minor:ai_utilize')).imageSafety, true);
  assert.equal((await api.loadSettings('minor:ai_utilize')).botCommentFilter, false);
  assert.deepEqual(copy((await api.loadSettings('major:sff')).blockKeywords), ['공통']);
  assert.equal((await api.loadSettings()).imageSafety, false, 'default load derives the active gallery from the page URL');
});

test('global partial saves never copy active gallery overrides into common settings', async () => {
  const { api, data, writes } = setup({
    imageSafety: true, blockKeywords: ['공통'], botCommentAllowlist: ['허용할 문장'],
    'galleryProfile:minor:sff': { imageSafety: false, blockKeywords: ['SFF 전용'] }
  });
  assert.equal((await api.loadSettings()).imageSafety, false);
  const saved = await api.savePatch({ hideAds: true });
  assert.deepEqual(writes, [{ hideAds: true }]);
  assert.equal(saved.imageSafety, true);
  assert.equal(data.imageSafety, true);
  assert.deepEqual(data.blockKeywords, ['공통']);
  assert.deepEqual(data.botCommentAllowlist, ['허용할 문장']);
  assert.equal((await api.loadSettings()).imageSafety, false);
});

test('inherited profile keys follow global changes and deleting a profile restores common values', async () => {
  const { api, data, removals } = setup({ imageSafety: true, botCommentFilter: true, blockKeywords: ['공통'] });
  await api.saveGalleryProfile('minor:sff', { imageSafety: false, botCommentFilter: undefined });
  await api.savePatch({ botCommentFilter: false, blockKeywords: ['바뀐 공통'] });
  const effective = await api.loadSettings('minor:sff');
  assert.equal(effective.imageSafety, false);
  assert.equal(effective.botCommentFilter, false);
  assert.deepEqual(copy(effective.blockKeywords), ['바뀐 공통']);
  await api.saveGalleryProfile('minor:sff', {});
  assert.deepEqual(removals, ['galleryProfile:minor:sff']);
  assert.equal(Object.hasOwn(data, 'galleryProfile:minor:sff'), false);
  assert.equal((await api.loadSettings('minor:sff')).imageSafety, true);
});

test('profile sync byte limits and invalid keys fail before any storage mutation', async () => {
  const { api, data, writes, removals } = setup({ 'galleryProfile:minor:sff': { imageSafety: false } });
  const before = copy(data);
  await assert.rejects(api.saveGalleryProfile('minor:sff', { blockKeywords: ['가'.repeat(2600)] }), /너무 큽니다/);
  await assert.rejects(api.saveGalleryProfile('other:sff', { imageSafety: true }), /갤러리 주소/);
  await assert.rejects(api.savePatch({ hideAds: true }, { 'minor:sff': { blockKeywords: ['가'.repeat(2600)] } }), /너무 큽니다/);
  assert.deepEqual(data, before);
  assert.equal(writes.length, 0);
  assert.equal(removals.length, 0);
  await api.saveGalleryProfile('minor:sff', { blockKeywords: ['가'.repeat(2500)] });
  assert.equal(data['galleryProfile:minor:sff'].blockKeywords[0].length, 2500);
});

test('schema 2 backup round trip preserves common settings, allowed comments and separate profiles', async () => {
  const source = setup({
    imageSafety: true, botCommentAllowlist: ['정상 댓글 허용'], botCommentExamples: ['차단 예시 문장입니다.'],
    'galleryProfile:minor:sff': { imageSafety: false, blockKeywords: ['SFF 전용'] },
    'galleryProfile:mini:sff': { botCommentFilter: false },
    'galleryProfile:bad:sff': { imageSafety: false }, privateKey: 'excluded'
  });
  const backup = await source.api.createBackup();
  assert.equal(backup.schema, 2);
  assert.equal(backup.settings.imageSafety, true, 'backup uses global settings, not current gallery overrides');
  assert.equal(backup.settings.privateKey, undefined);
  assert.deepEqual(copy(backup.settings.botCommentAllowlist), ['정상 댓글 허용']);
  assert.deepEqual(Object.keys(backup.galleryProfiles).sort(), ['mini:sff', 'minor:sff']);
  const target = setup({ 'galleryProfile:minor:keep': { imageSafetySexual: false } });
  const parsed = target.api.parseBackupBundle(JSON.stringify(backup));
  await target.api.savePatch(parsed.settings, parsed.galleryProfiles);
  assert.equal((await target.api.loadSettings('minor:sff')).imageSafety, false);
  assert.equal((await target.api.loadGlobalSettings()).imageSafety, true);
  assert.deepEqual(copy((await target.api.loadGlobalSettings()).botCommentAllowlist), ['정상 댓글 허용']);
  assert.equal((await target.api.loadSettings('mini:sff')).botCommentFilter, false);
  assert.equal((await target.api.loadSettings('minor:keep')).imageSafetySexual, false, 'import merges named profiles without deleting unrelated ones');
});

test('schema 1 import keeps gallery profiles while applying legacy common values', async () => {
  const { api, data } = setup({ 'galleryProfile:minor:sff': { imageSafety: false } });
  const parsed = api.parseBackupBundle(JSON.stringify({ app: 'DCFilter', schema: 1, settings: { hideAds: true } }));
  assert.equal(parsed.galleryProfiles, null);
  await api.savePatch(parsed.settings, parsed.galleryProfiles);
  assert.equal(data.hideAds, true);
  assert.deepEqual(data['galleryProfile:minor:sff'], { imageSafety: false });
  assert.equal((await api.loadSettings('minor:sff')).imageSafety, false);
});

test('invalid schema 2 profile shapes, types, counts and sizes are rejected', () => {
  const { api } = setup();
  const profiles = [
    undefined, null, [], 'bad', { 'bad:sff': {} }, { 'minor:sff': [] }, { 'minor:sff': null },
    { 'minor:sff': { imageSafety: 'false' } },
    { 'minor:sff': { blockKeywords: 'text' } },
    { 'minor:sff': { blockKeywords: [123] } },
    { 'minor:sff': { imageSafetySensitivity: true } },
    { 'minor:sff': { blockKeywords: ['가'.repeat(2600)] } },
    Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`minor:g${i}`, {}]))
  ];
  for (const galleryProfiles of profiles) {
    assert.throws(() => api.parseBackupBundle(JSON.stringify({ app: 'DCFilter', schema: 2, settings: {}, galleryProfiles })));
  }
  assert.throws(() => api.parseBackupBundle(JSON.stringify({ app: 'Foreign', schema: 2, settings: {}, galleryProfiles: {} })));
});

test('a valid backup with more than 100 saved galleries can be restored', async () => {
  const { api } = setup();
  for (let i = 0; i < 101; i++) await api.saveGalleryProfile(`minor:g${i}`, { botCommentFilter: false });
  const backup = await api.createBackup();
  const parsed = api.parseBackupBundle(JSON.stringify(backup));
  assert.equal(Object.keys(parsed.galleryProfiles).length, 101);
});
