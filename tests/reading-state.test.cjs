"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const reading = require("../src/reading-state.js");
const now = Date.UTC(2026, 8, 4, 0, 0);
const post = "https://gall.dcinside.com/board/view/?id=programming&no=123&page=2";
const key = reading.parsePage(post).key;

test("게시글 키는 페이지와 검색 조건에 영향받지 않는다", () => {
  assert.equal(key, "dcf.read.v1:main:programming:123");
  assert.equal(reading.parsePage(post + "&s_keyword=test#comment").key, key);
  assert.equal(reading.parsePage(post.replace("no=123", "no=00123")).key, key);
});

test("갤러리 종류와 id가 다르면 같은 글 번호도 분리한다", () => {
  const keys = ["", "mgallery/", "mini/", "person/"].map((prefix) => reading.parsePage(`https://gall.dcinside.com/${prefix}board/view/?id=test&no=123`).key);
  assert.equal(new Set(keys).size, 4);
  assert.notEqual(reading.parsePage(post.replace("programming", "other")).key, key);
});

test("디시 외부, 잘못된 id/번호, 글쓰기 URL은 기록 대상이 아니다", () => {
  for (const url of [post.replace("https:", "http:"), post.replace("gall.dcinside.com", "gall.dcinside.com.example.org"), post.replace("no=123", "no=oops"), post.replace("no=123", "no=0"), post.replace("programming", "../bad"), post.replace("/view/", "/write/")]) {
    assert.equal(reading.parsePage(url), null, url);
  }
});

test("댓글 증가분은 0·누락·감소를 새 댓글로 잘못 표시하지 않는다", () => {
  assert.equal(reading.commentDelta({ comments: 2 }, 7), 5);
  assert.equal(reading.commentDelta({ comments: 0 }, 3), 3);
  assert.equal(reading.commentDelta({ comments: 5 }, 2), 0);
  assert.equal(reading.commentDelta({ comments: null }, 7), 0);
  assert.equal(reading.commentDelta({ comments: 2 }, null), 0);
  assert.equal(reading.commentDelta(null, 7), 0);
});

test("최근 30일만 유지하며 정리 키가 다른 기능의 저장소를 침범하지 않는다", () => {
  const oldKey = key.replace(":123", ":122");
  const invalidKey = `${reading.READ_PREFIX}invalid`;
  const result = reading.selectHistory({
    [key]: { comments: 0, visitedAt: now - 100 },
    [oldKey]: { comments: 8, visitedAt: now - reading.HISTORY_TTL },
    [invalidKey]: { comments: 1, visitedAt: now },
    blockedImageFingerprints: [{ hash: "keep-me" }]
  }, now);
  assert.equal(result.records.size, 1);
  assert.deepEqual(result.records.get(key), { comments: 0, visitedAt: now - 100 });
  assert.deepEqual(new Set(result.removeKeys), new Set([oldKey, invalidKey]));
});

test("기록 비우기 이전 데이터와 잘못된 숫자는 복원하지 않는다", () => {
  const result = reading.selectHistory({ [reading.RESET_KEY]: now - 50, [key]: { comments: 1, visitedAt: now - 100 } }, now);
  assert.equal(result.records.size, 0);
  for (const comments of [-1, 0.5, Infinity, NaN, "3", undefined]) {
    assert.equal(reading.normalizeRecord({ comments, visitedAt: now }, now), null);
  }
  assert.equal(reading.normalizeRecord({ comments: null, visitedAt: now }, now).comments, null);
  assert.equal(reading.normalizeRecord({ comments: 0, visitedAt: now + 120000 }, now), null);
});

test("읽음 기록은 최신 3000개로 제한한다", () => {
  const raw = {};
  for (let index = 1; index <= reading.MAX_RECORDS + 7; index += 1) {
    raw[`${reading.READ_PREFIX}main:test:${index}`] = { comments: 1, visitedAt: now - index };
  }
  const result = reading.selectHistory(raw, now);
  assert.equal(result.records.size, reading.MAX_RECORDS);
  assert.equal(result.removeKeys.length, 7);
  assert.ok(result.records.has(`${reading.READ_PREFIX}main:test:1`));
});

test("목록 복원 키는 검색/개념/페이지를 분리하고 매개변수 순서만 정규화한다", () => {
  const url = "https://gall.dcinside.com/board/lists/?id=programming&page=2&s_type=search_subject&s_keyword=test";
  assert.equal(reading.listKey(url), reading.listKey("https://gall.dcinside.com/board/lists?s_keyword=test&page=2&id=programming&s_type=search_subject#x"));
  assert.notEqual(reading.listKey(url), reading.listKey(url.replace("page=2", "page=3")));
  assert.notEqual(reading.listKey(url), reading.listKey(url + "&exception_mode=recommend"));
  assert.equal(reading.listKey(post), "");
  assert.equal(reading.listKey("/board/lists/?id=test"), reading.listKey("/board/lists/?id=test&page=1"));
});

function position(extra) {
  return Object.assign({ url: "https://gall.dcinside.com/board/lists/?id=programming&page=2", rowKey: key, x: 0, y: 520, rowTop: 280, savedAt: now, pending: true }, extra);
}

test("목록 복원 좌표와 원래 갤러리를 검증한다", () => {
  assert.equal(reading.normalizePosition(position(), now).y, 520);
  for (const patch of [{ x: -1 }, { y: NaN }, { rowTop: "280" }, { savedAt: now - reading.POSITION_TTL - 1 }, { rowKey: key.replace("programming", "other") }, { url: post }]) {
    assert.equal(reading.normalizePosition(position(patch), now), null);
  }
});

test("탭 내 복원 기록은 URL별 최신 하나, 최대 20개로 제한한다", () => {
  const list = Array.from({ length: 25 }, (_, index) => position({ url: `https://gall.dcinside.com/board/lists/?id=programming&page=${index + 1}`, savedAt: now - index }));
  list.push(position({ url: list[0].url, savedAt: now - 500, y: 999 }));
  const result = reading.selectPositions(list, now);
  assert.equal(result.length, 20);
  assert.equal(result[0].y, 520);
  assert.equal(reading.selectPositions({}, now).length, 0);
});
