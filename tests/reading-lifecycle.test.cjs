"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const model = require("../src/reading-state.js");
const source = fs.readFileSync(path.join(__dirname, "../src/reading.js"), "utf8");
const settings = { enabled: true, showReadPosts: true, showCommentDelta: true, restoreListPosition: true };

function makeStore() {
  const data = {};
  const listeners = new Set();
  const writes = [];
  function notify(changes) { listeners.forEach((fn) => fn(changes, "local")); }
  return {
    data, writes,
    api: {
      local: {
        async get(keys) {
          const selected = keys === null ? data : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in data).map((key) => [key, data[key]]));
          return structuredClone(selected);
        },
        async set(values) {
          const changes = {};
          Object.entries(values).forEach(([key, value]) => {
            changes[key] = { oldValue: data[key], newValue: value };
            data[key] = structuredClone(value);
          });
          writes.push(structuredClone(values));
          notify(changes);
        },
        async remove(keys) {
          const changes = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
            if (key in data) changes[key] = { oldValue: data[key] };
            delete data[key];
          });
          notify(changes);
        }
      },
      onChanged: { addListener(fn) { listeners.add(fn); } }
    }
  };
}

function fixture(t, options = {}) {
  const store = options.store || makeStore();
  const handlers = {};
  const timers = new Set();
  const positions = new Map();
  const count = { textContent: options.comments === undefined ? "댓글 2" : options.comments };
  const doc = {
    visibilityState: options.hidden ? "hidden" : "visible",
    referrer: "", documentElement: { scrollHeight: 1800 },
    addEventListener(name, fn) { handlers[name] = fn; },
    querySelector(selector) {
      if (selector.includes(".title_subject")) return options.invalidPage ? null : { textContent: "test post" };
      if (selector === ".writing_view_box") return {};
      if (selector.includes(".gall_comment")) return options.missingComments ? null : count;
      return null;
    },
    querySelectorAll() { return []; }
  };
  const window = {
    DCFilterReadingState: model,
    addEventListener(name, fn) { handlers[name] = fn; },
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    scrollX: 0, scrollY: options.y || 0, innerHeight: 1000
  };
  const context = vm.createContext({
    window, document: doc, chrome: { storage: store.api, extension: { inIncognitoContext: Boolean(options.private) } },
    location: { href: options.list ? 'https://gall.dcinside.com/board/lists/?id=programming&page=2' : `https://gall.dcinside.com/board/view/?id=programming&no=${options.no || 123}`, hash: "" },
    sessionStorage: { getItem(key) { return positions.get(key) || null; }, setItem(key,value) { positions.set(key,value); } },
    performance: { getEntriesByType() { return []; } },
    console, Date, URL, Element: class Element {}, MutationObserver: class MutationObserver { observe() {} disconnect() {} }
  });
  vm.runInContext(source, context);
  t.after(() => timers.forEach(clearTimeout));
  const link = {href:`https://gall.dcinside.com/board/view/?id=programming&no=${options.no || 123}&page=2`,closest(){return row;}};
  const row = {querySelector(selector){return selector==='td.gall_num'?{textContent:String(options.no||123)}:link;},getBoundingClientRect(){return{top:280};}};
  return { api: window.DCFilterReading, doc, count, store, handlers, positions, window, link, key: `${model.READ_PREFIX}main:programming:${options.no || 123}` };
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise(setImmediate); };

test("표시 중인 실제 본문만 저장하고 같은 댓글 수로 반복 쓰지 않는다", async (t) => {
  const f = fixture(t);
  await f.api.init(settings);
  await flush();
  assert.equal(f.store.data[f.key].comments, 2);
  const writes = f.store.writes.length;
  f.api.enhance(); f.api.enhance();
  assert.equal(f.store.writes.length, writes);
  f.count.textContent = "댓글 7";
  f.api.enhance();
  assert.equal(f.store.data[f.key].comments, 7);
});

test("백그라운드 로드는 읽음이 아니며 visibilitychange 후에만 기록한다", async (t) => {
  const f = fixture(t, { hidden: true });
  await f.api.init(settings);
  assert.equal(f.store.data[f.key], undefined);
  f.doc.visibilityState = "visible";
  f.handlers.visibilitychange();
  await flush();
  assert.equal(f.store.data[f.key].comments, 2);
});

test("시크릿 창·비활성 설정·오류 페이지는 기록하지 않는다", async (t) => {
  for (const options of [{ private: true }, { invalidPage: true }, { disabled: true }]) {
    const f = fixture(t, options);
    await f.api.init({ ...settings, enabled: !options.disabled });
    assert.equal(f.store.data[f.key], undefined);
  }
});

test("댓글 수를 알 수 없는 경우 0이라고 추정하지 않는다", async (t) => {
  const f = fixture(t, { missingComments: true });
  await f.api.init(settings);
  assert.equal(f.store.data[f.key].comments, null);
});

test("다른 글을 동시에 연 탭들이 서로의 읽음 기록을 덮지 않는다", async (t) => {
  const store = makeStore();
  const a = fixture(t, { store, no: 123 });
  const b = fixture(t, { store, no: 456 });
  await Promise.all([a.api.init(settings), b.api.init(settings)]);
  await flush();
  assert.equal(store.data[a.key].comments, 2);
  assert.equal(store.data[b.key].comments, 2);
});

test("기록 비우기 후 열려 있던 글이 기록을 다시 생성하지 않는다", async (t) => {
  const f = fixture(t);
  await f.api.init(settings);
  await f.store.api.local.set({ [model.RESET_KEY]: Date.now() + 1, blockedImageFingerprints: [{ hash: "keep" }] });
  await f.store.api.local.remove(f.key);
  f.count.textContent = "댓글 10";
  f.api.enhance();
  f.handlers.visibilitychange();
  await flush();
  assert.equal(f.store.data[f.key], undefined);
  assert.equal(f.store.data.blockedImageFingerprints[0].hash, "keep");
});

test("읽음 기능을 끄면 댓글 변화도 저장하지 않는다", async (t) => {
  const f = fixture(t);
  await f.api.init(settings);
  f.api.configure({ ...settings, showReadPosts: false });
  f.count.textContent = "댓글 99";
  f.api.enhance();
  assert.equal(f.store.data[f.key].comments, 2);
});

test("새 탭에서 읽고 목록으로 복귀하는 이벤트는 스크롤을 바꾸지 않는다", async (t) => {
  const f = fixture(t, {list:true,y:560});
  await f.api.init(settings);
  f.api.rememberLink(f.link);
  const before=JSON.parse(f.positions.get(model.POSITION_KEY))[0];
  assert.equal(before.pending,true);
  await f.store.api.local.set({[f.key]:{visitedAt:Date.now(),comments:2}});
  f.handlers.visibilitychange();
  await flush();
  const after=JSON.parse(f.positions.get(model.POSITION_KEY))[0];
  assert.equal(after.pending,false);
  assert.equal(f.window.scrollY,560);
});

test("위치 복원 OFF는 미사용 복원 기록을 소비하고 새 위치를 저장하지 않는다", async (t) => {
  const f = fixture(t, {list:true,y:560});
  await f.api.init(settings);
  f.api.rememberLink(f.link);
  f.api.configure({...settings,restoreListPosition:false});
  const before=f.positions.get(model.POSITION_KEY);
  assert.equal(JSON.parse(before)[0].pending,false);
  f.window.scrollY=900;
  f.api.rememberLink(f.link);
  assert.equal(f.positions.get(model.POSITION_KEY),before);
});
