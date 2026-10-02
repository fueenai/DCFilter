const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(raw = {}) {
  const data = copy(raw), writes = [], listeners = [];
  let rejectWrites = false;
  const chrome = {
    runtime: { id: 'dcfilter-test', onMessage: { addListener: callback => listeners.push(callback) } },
    storage: { sync: {
      async get(query) {
        const result = query === null ? copy(data) : Object.fromEntries(Object.entries(query).map(([key, fallback]) => [key, copy(Object.hasOwn(data, key) ? data[key] : fallback)]));
        await tick(); // Snapshot before yielding so an un-serialized read-modify-write would lose edits.
        return result;
      },
      async set(values) {
        await tick();
        if (rejectWrites) throw new Error('QUOTA_BYTES exceeded');
        writes.push(copy(values));
        Object.assign(data, copy(values));
      }
    } }
  };
  const context = vm.createContext({ chrome, TextEncoder, URL });
  context.importScripts = (...names) => names.forEach(name => vm.runInContext(fs.readFileSync(path.join('src', name), 'utf8'), context, { filename: name }));
  vm.runInContext(fs.readFileSync('src/background.js', 'utf8'), context, { filename: 'background.js' });
  assert.equal(listeners.length, 1);
  const send = (message, sender = { id: chrome.runtime.id, url: 'https://gall.dcinside.com/mgallery/board/view/?id=sff&no=1' }) => new Promise(resolve => {
    const keepOpen = listeners[0](message, sender, response => resolve(response));
    if (!keepOpen) resolve(undefined);
  });
  chrome.runtime.sendMessage = message => send(message);
  return { data, writes, send, api: context.DCFilterStorage, setRejectWrites: value => { rejectWrites = value; } };
}

const rule = (text, action) => ({ type: 'dcf:comment-rule', text, action });

test('actual worker listener serializes simultaneous rule edits from different tabs without losing any', async () => {
  const worker = setup({ botCommentAllowlist: [], botCommentExamples: [], hideAds: true, 'galleryProfile:minor:sff': { imageSafety: false } });
  const texts = Array.from({ length: 12 }, (_, i) => `동시에 저장하는 정상 댓글 ${i}`);
  const results = await Promise.all(texts.map(text => worker.send(rule(text, 'allow'))));
  assert.ok(results.every(result => result.ok === true));
  assert.deepEqual(worker.data.botCommentAllowlist, texts);
  assert.deepEqual(worker.data.botCommentExamples, []);
  assert.equal(worker.data.hideAds, true);
  assert.deepEqual(worker.data['galleryProfile:minor:sff'], { imageSafety: false });
  assert.equal(worker.writes.length, 12);
});

test('allow and block remove only the matching opposite rule after full sentence normalization', async () => {
  const worker = setup({
    botCommentAllowlist: ['남겨 둘 허용 문장'],
    botCommentExamples: ['AI 기술은 정말 발전하고 있네요', '다른 차단 문장은 유지합니다']
  });
  assert.equal((await worker.send(rule('ＡＩ  기술은 정말 발전하고 있네요', 'allow'))).ok, true);
  assert.deepEqual(worker.data.botCommentExamples, ['다른 차단 문장은 유지합니다']);
  assert.deepEqual(worker.data.botCommentAllowlist, ['남겨 둘 허용 문장', 'ＡＩ 기술은 정말 발전하고 있네요']);
  assert.equal((await worker.send(rule('ai 기술은 정말 발전하고 있네요', 'block'))).ok, true);
  assert.deepEqual(worker.data.botCommentAllowlist, ['남겨 둘 허용 문장']);
  assert.deepEqual(worker.data.botCommentExamples, ['다른 차단 문장은 유지합니다', 'ai 기술은 정말 발전하고 있네요']);
  const again = await worker.send(rule('AI 기술은 정말 발전하고 있네요', 'block'));
  assert.equal(again.ok, true);
  assert.equal(worker.data.botCommentExamples.length, 2, 'duplicate rules stay a single item');
});

test('remove actions remove their own exact rule without adding to or changing the other list', async () => {
  const worker = setup({ botCommentAllowlist: ['허용 문장입니다', '허용 문장입니다 덧붙임'], botCommentExamples: ['차단 문장입니다', '남겨둘 차단 문장입니다'] });
  assert.equal((await worker.send(rule('허용 문장입니다', 'removeAllow'))).ok, true);
  assert.deepEqual(worker.data.botCommentAllowlist, ['허용 문장입니다 덧붙임']);
  assert.deepEqual(worker.data.botCommentExamples, ['차단 문장입니다', '남겨둘 차단 문장입니다']);
  assert.equal((await worker.send(rule('차단 문장입니다', 'removeBlock'))).ok, true);
  assert.deepEqual(worker.data.botCommentExamples, ['남겨둘 차단 문장입니다']);
  assert.deepEqual(worker.data.botCommentAllowlist, ['허용 문장입니다 덧붙임']);
});

test('invalid or overlength payloads fail without writes and do not poison the serialized queue', async () => {
  const worker = setup({ botCommentAllowlist: ['유지할 허용 문장'], botCommentExamples: ['유지할 차단 문장'] });
  const before = copy(worker.data);
  const invalid = [
    rule('', 'allow'), rule('  \n ', 'allow'), rule('가'.repeat(601), 'allow'),
    rule('ﷺ'.repeat(50), 'allow'), rule(null, 'allow'), rule({}, 'block'),
    rule('정상적인 길이의 문장입니다', 'unknown'), rule('일곱자', 'block'),
    { type: 'dcf:comment-rule' }
  ];
  for (const message of invalid) {
    const result = await worker.send(message);
    assert.equal(result.ok, false, JSON.stringify(message));
    assert.equal(typeof result.error, 'string');
  }
  assert.equal(worker.writes.length, 0);
  assert.deepEqual(worker.data, before);
  assert.equal((await worker.send(rule('검증 실패 이후 정상 문장도 저장됩니다', 'allow'))).ok, true);
  assert.equal(worker.data.botCommentAllowlist.length, 2);
});

test('list item limit failure does not delete an existing rule from the opposite list', async () => {
  const worker = setup({
    botCommentAllowlist: ['차단으로 바꿀 문장입니다'],
    botCommentExamples: Array.from({ length: 100 }, (_, i) => `기존 차단 예시 문장 ${i}`)
  });
  const before = copy(worker.data);
  const result = await worker.send(rule('차단으로 바꿀 문장입니다', 'block'));
  assert.equal(result.ok, false);
  assert.match(result.error, /100개/);
  assert.deepEqual(worker.data, before);
  assert.equal(worker.writes.length, 0);
});

test('per-item UTF-8 sync size rejection preserves both rule lists before writing', async () => {
  const text = '나'.repeat(590);
  const worker = setup({
    botCommentAllowlist: [text],
    botCommentExamples: Array.from({ length: 4 }, (_, i) => `${i}${'가'.repeat(590)}`)
  });
  const before = copy(worker.data);
  const result = await worker.send(rule(text, 'block'));
  assert.equal(result.ok, false);
  assert.match(result.error, /너무 큽니다/);
  assert.deepEqual(worker.data, before);
  assert.equal(worker.writes.length, 0);
});

test('storage quota errors reach the caller without destructive writes and later commands recover', async () => {
  const worker = setup({ botCommentAllowlist: [], botCommentExamples: ['전환할 기존 차단 문장입니다'] });
  const before = copy(worker.data);
  worker.setRejectWrites(true);
  const result = await worker.send(rule('전환할 기존 차단 문장입니다', 'allow'));
  assert.equal(result.ok, false);
  assert.match(result.error, /QUOTA_BYTES/);
  assert.deepEqual(worker.data, before);
  worker.setRejectWrites(false);
  await worker.api.updateCommentRule('전환할 기존 차단 문장입니다', 'allow');
  assert.deepEqual(worker.data.botCommentExamples, []);
  assert.deepEqual(worker.data.botCommentAllowlist, ['전환할 기존 차단 문장입니다']);
});

test('foreign senders and unrelated message types cannot mutate stored rules', async () => {
  const worker = setup({ botCommentAllowlist: ['원래 문장'], botCommentExamples: [] });
  const before = copy(worker.data);
  assert.equal(await worker.send(rule('인증되지 않은 외부 메시지입니다', 'allow'), { id: 'other-extension' }), undefined);
  assert.equal(await worker.send(rule('발신자가 없는 메시지입니다', 'allow'), {}), undefined);
  assert.equal(await worker.send({ type: 'unrelated', text: '다른 메시지입니다', action: 'allow' }), undefined);
  assert.equal(await worker.send(null), undefined);
  assert.deepEqual(worker.data, before);
  assert.equal(worker.writes.length, 0);
});

test('storage client helper reports worker validation failure to callers', async () => {
  const worker = setup({ botCommentAllowlist: [], botCommentExamples: [] });
  await assert.rejects(worker.api.updateCommentRule('짧음', 'block'), /8자 이상/);
  assert.equal(worker.writes.length, 0);
});
