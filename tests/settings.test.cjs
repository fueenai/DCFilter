const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup(raw = {}) {
  const data = { ...raw };
  const context = { window: {}, TextEncoder, chrome: { storage: { sync: {
    get: async defaults => ({ ...defaults, ...data }), set: async values => Object.assign(data, values)
  } } } };
  vm.runInNewContext(fs.readFileSync('src/storage.js','utf8'), context);
  return { api: context.window.DCFilterStorage, data };
}
test('설정 저장은 다른 창에서 변경한 무관한 설정을 유지한다', async () => {
  const { api, data } = setup({ darkMode: true, blockUsers: ['keep-me'] });
  await api.savePatch({ hideAds: true });
  assert.equal(data.darkMode, true); assert.equal(data.hideAds, true); assert.deepEqual(data.blockUsers, ['keep-me']);
});
test('설정 정규화는 알 수 없는 키를 저장하지 않고 삭제된 값은 기본값으로 복구한다', () => {
  const { api } = setup(); const result = api.normalizeSettings({ enabled: undefined, alien: 'data', systemTheme: true });
  assert.equal(result.enabled, true); assert.equal(result.alien, undefined); assert.equal(result.systemTheme, true);
});
test('잘못된 백업 형식과 저장 한도를 넘는 차단 목록은 저장 전에 거부한다', async () => {
  const { api, data } = setup({ blockKeywords: ['original'] });
  assert.throws(() => api.parseBackup('{"settings":{}}'));
  assert.throws(() => api.parseBackup('{"app":"DCFilter","schema":1,"settings":{"enabled":"false"}}'));
  await assert.rejects(api.savePatch({ blockKeywords: ['가'.repeat(3000)] }));
  assert.deepEqual(data.blockKeywords, ['original']);
});
test('설정 백업 왕복으로 설정 값과 차단 항목이 유지된다', () => {
  const { api } = setup();
  const original = api.normalizeSettings({ systemTheme: true, hideAds: true, blockUsers: ['tester', '1.2'], blockKeywords: ['스포일러'] });
  const imported = api.parseBackup(JSON.stringify({ app: 'DCFilter', schema: 1, settings: original }));
  assert.equal(JSON.stringify(imported), JSON.stringify(original));
});
test('구버전 기본 강조색은 새 기본값(디시 남색)으로 이관하고 사용자가 고른 색은 유지한다', () => {
  const { api } = setup();
  assert.equal(api.normalizeSettings({ accentColor: '#3B82F6' }).accentColor, '#3b4890');
  assert.equal(api.normalizeSettings({}).accentColor, '#3b4890');
  assert.equal(api.normalizeSettings({ accentColor: '#e53935' }).accentColor, '#e53935');
  assert.equal(api.normalizeSettings({ accentColor: 'blue' }).accentColor, '#3b4890');
});
test('테마 판정: 디시 야간모드가 우선하고, 시스템·시간대·수동 순으로 따른다', () => {
  const { api } = setup();
  const s = (patch) => api.normalizeSettings(patch);
  const env = (patch) => ({ siteNight: false, listPage: true, systemDark: false, now: new Date(2026, 9, 2, 12), ...patch });
  assert.equal(api.prefersDarkTheme(s({ darkMode: false }), env({ siteNight: true })), true);
  assert.equal(api.prefersDarkTheme(s({ darkMode: false }), env()), false);
  assert.equal(api.prefersDarkTheme(s({ darkMode: true }), env()), true);
  assert.equal(api.prefersDarkTheme(s({ systemTheme: true, darkMode: true }), env({ systemDark: false })), false);
  assert.equal(api.prefersDarkTheme(s({ autoDark: true }), env({ now: new Date(2026, 9, 2, 22) })), true);
  assert.equal(api.prefersDarkTheme(s({ autoDark: true }), env({ now: new Date(2026, 9, 2, 8) })), false);
});
test('루트 상태: 꺼져 있으면 모든 클래스를 끄고, 정리 레일은 목록 페이지에서만 켠다', () => {
  const { api } = setup();
  const env = { siteNight: false, listPage: true, systemDark: false, now: new Date(2026, 9, 2, 12) };
  const off = api.rootState(api.normalizeSettings({ enabled: false, darkMode: true }), env);
  assert.ok(Object.values(off.classes).every((on) => on === false));
  const on = api.rootState(api.normalizeSettings({ darkMode: true }), env);
  assert.equal(on.classes['dcf-active'], true); assert.equal(on.classes['dcf-dark'], true); assert.equal(on.classes['dcf-clean-rail'], true);
  assert.equal(api.rootState(api.normalizeSettings({}), { ...env, listPage: false }).classes['dcf-clean-rail'], false);
  assert.equal(on.vars['--dcf-accent'], '#3b4890');
});

test('이미지 보호는 기본으로 켜지며 선택한 범위와 민감도를 백업에 보존한다', async () => {
  const { api, data } = setup();
  assert.equal(api.DEFAULTS.imageSafety, true);
  assert.equal(api.DEFAULTS.imageSafetySexual, true);
  assert.equal(api.DEFAULTS.imageSafetyHideUncertain, false);
  assert.equal(api.normalizeSettings({ imageSafetySensitivity: 'invalid' }).imageSafetySensitivity, 'strict');
  const saved = await api.savePatch({ imageSafetySexual: false, imageSafetySensitivity: 'balanced' });
  const restored = api.parseBackup(JSON.stringify({ app: 'DCFilter', schema: 1, settings: saved }));
  assert.equal(restored.imageSafety, true);
  assert.equal(restored.imageSafetySexual, false);
  assert.equal(restored.imageSafetySensitivity, 'balanced');
  assert.equal(data.imageSafetySensitivity, 'balanced');
});

test('기존 설정과 구버전 백업은 애매한 이미지 추가 가림을 끈 상태로 불러온다', async () => {
  const legacy = { imageSafety: true, imageSafetySexual: false, imageSafetySensitivity: 'balanced', hideImages: true };
  const { api } = setup(legacy);
  const loaded = await api.loadSettings();
  const restored = api.parseBackup(JSON.stringify({ app: 'DCFilter', schema: 1, settings: legacy }));
  for (const settings of [loaded, restored]) {
    assert.equal(settings.imageSafetyHideUncertain, false);
    assert.equal(settings.imageSafety, true);
    assert.equal(settings.imageSafetySexual, false);
    assert.equal(settings.imageSafetySensitivity, 'balanced');
    assert.equal(settings.hideImages, true);
  }
  assert.equal(api.normalizeSettings({ imageSafetyHideUncertain: undefined }).imageSafetyHideUncertain, false);
});

test('애매한 이미지 가림 옵션은 저장과 백업 왕복에서 켜짐·꺼짐을 유지한다', async () => {
  const { api, data } = setup({ imageSafety: true, imageSafetySexual: true, blockKeywords: ['유지'] });
  for (const value of [true, false]) {
    const saved = await api.savePatch({ imageSafetyHideUncertain: value });
    const restored = api.parseBackup(JSON.stringify({ app: 'DCFilter', schema: 1, settings: saved }));
    assert.equal(data.imageSafetyHideUncertain, value);
    assert.equal(restored.imageSafetyHideUncertain, value);
    assert.equal(restored.imageSafety, true);
    assert.equal(restored.imageSafetySexual, true);
    assert.deepEqual(data.blockKeywords, ['유지']);
  }
  assert.throws(() => api.parseBackup(JSON.stringify({ app: 'DCFilter', schema: 1, settings: { imageSafetyHideUncertain: 'false' } })), /형식/);
});

test('봇 댓글 예시와 판별 기준은 설정 백업과 부분 저장에서 유지된다', async () => {
  const { api, data } = setup({ imageSafety: true });
  assert.equal(api.DEFAULTS.botCommentFilter, true);
  assert.equal(api.DEFAULTS.botCommentExamples.length, 4);
  assert.equal(api.normalizeSettings({ botCommentSensitivity: 'invalid' }).botCommentSensitivity, 'balanced');
  const saved = await api.savePatch({ botCommentFilter: false, botCommentSensitivity: 'strict', botCommentExamples: ['문장 예시 하나입니다.', '문장 예시 하나입니다.'] });
  const restored = api.parseBackup(JSON.stringify({ app: 'DCFilter', schema: 1, settings: saved }));
  assert.equal(restored.botCommentFilter, false);
  assert.equal(restored.botCommentSensitivity, 'strict');
  assert.equal(restored.botCommentExamples.length, 1);
  assert.equal(data.imageSafety, true);
  await assert.rejects(api.savePatch({ botCommentExamples: ['가'.repeat(3000)] }), /봇 댓글 예시/);
  assert.equal(data.botCommentExamples.length, 1);
  assert.equal(api.normalizeSettings({ botCommentExamples: [] }).botCommentExamples.length, 0);
});
