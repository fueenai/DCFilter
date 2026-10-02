"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../src/image-allowlist.js"), "utf8");
const digest = (n) => n.toString(16).padStart(64, "0");

function page(values) {
  const context = vm.createContext({ chrome: { storage: { local: {
    async get(key) { return key === null ? { ...values } : Object.hasOwn(values, key) ? { [key]: values[key] } : {}; },
    async set(changes) { Object.assign(values, changes); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }
  } } } });
  vm.runInContext(source, context);
  return context.DCFImageAllowlist;
}

test("exact image permissions persist across pages and independent simultaneous adds survive", async () => {
  const values = { unrelatedSetting: true };
  const first = page(values), second = page(values);
  await Promise.all([first.add(digest(1)), second.add(digest(2))]);
  const reloaded = page(values);
  assert.equal(await reloaded.has(digest(1)), true);
  assert.equal(await reloaded.has(digest(2)), true);
  assert.equal(await reloaded.has(digest(3)), false);
  assert.equal((await reloaded.list()).length, 2);
  assert.equal(Object.keys(values).length, 3, "one independent key per digest");
  assert.equal(JSON.stringify(values).includes("https"), false);
});

test("remove and clear revoke remembered images without touching unrelated local data", async () => {
  const values = { readingHistory: { first: 3 } };
  const allowed = page(values);
  await allowed.add(digest(1));
  await allowed.add(digest(2));
  await allowed.remove(digest(1));
  assert.equal(await page(values).has(digest(1)), false);
  assert.equal(await allowed.has(digest(2)), true);
  await allowed.clear();
  assert.deepEqual(values, { readingHistory: { first: 3 } });
});

test("remembered set is bounded and evicts the oldest entry", async () => {
  const values = {};
  const allowed = page(values);
  for (let n = 1; n <= allowed.MAX_ENTRIES; n++) values[allowed.PREFIX + digest(n)] = { addedAt: n };
  await Promise.all([allowed.add(digest(1000)), page(values).add(digest(1001))]);
  assert.equal((await allowed.list()).length, allowed.MAX_ENTRIES);
  assert.equal(await allowed.has(digest(1)), false);
  assert.equal(await allowed.has(digest(2)), false);
  assert.equal(await allowed.has(digest(1000)), true);
  assert.equal(await allowed.has(digest(1001)), true);
});

test("URLs, invalid digests and corrupt persisted values cannot grant permission", async () => {
  const values = {};
  const allowed = page(values);
  for (const invalid of [null, "https://dcimg1.dcinside.com/image.jpg", "a".repeat(63), "A".repeat(64)]) {
    await assert.rejects(allowed.add(invalid));
    await assert.rejects(allowed.has(invalid));
  }
  values[allowed.PREFIX + digest(1)] = true;
  values[allowed.PREFIX + digest(2)] = { addedAt: -5 };
  assert.equal(await allowed.has(digest(1)), false);
  assert.equal(await allowed.has(digest(2)), false);
  assert.equal(allowed.isChange({ [allowed.PREFIX + digest(1)]: { newValue: {} } }), true);
  assert.equal(allowed.isChange({ unrelatedSetting: { newValue: true } }), false);
});
