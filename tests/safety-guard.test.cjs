"use strict";
// Exercise the real guard with a small DOM/message harness. Worker classification
// and image decoding have their own tests; these cover UI state/race handling.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const guardSource = fs.readFileSync(path.join(__dirname, "../src/safety-guard.js"), "utf8");
const allowlistSource = fs.readFileSync(path.join(__dirname, "../src/image-allowlist.js"), "utf8");
const digest = "a".repeat(64), otherDigest = "b".repeat(64);
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };

function fixture(options = {}) {
  const windowEvents = {}, documentEvents = {}, storageListeners = [];
  const requests = [], values = options.values || {}, raf = [];
  let mutation;
  class Element {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase(); this.children = []; this.events = {};
      this.dataset = {}; this.style = {}; this.isConnected = true; this.textContent = "";
      this.classes = new Set();
      this.classList = { add: (...names) => names.forEach((name) => this.classes.add(name)), toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
      if (this.tagName === "IFRAME") this.contentWindow = { postMessage: (message) => requests.push({ message, frame: this }) };
    }
    addEventListener(type, listener) { this.events[type] = listener; }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { if (name === "data-dcf-safety-state") delete this.dataset.dcfSafetyState; else delete this[name]; }
    append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
    appendChild(node) { this.children.push(node); node.parentNode = this; if (node.tagName === "IFRAME") queueMicrotask(() => node.events.load?.()); return node; }
    replaceChildren(...nodes) { this.children = nodes; }
    remove() { this.isConnected = false; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) { return this.children.flatMap((node) => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
    matches(selector) { return selector === "button" ? this.tagName === "BUTTON" : selector.includes(".write_div :is") && this === media; }
    closest() { return null; }
    getBoundingClientRect() { return { left: 10, top: 10, right: 310, bottom: 210, width: 300, height: 200 }; }
    focus() {}
    pause() {}
    click() { this.events.click?.({ preventDefault() {}, stopPropagation() {} }); }
  }
  const media = new Element(options.tag || "img");
  media.complete = true; media.src = options.src || "https://dcimg1.dcinside.com/first.png"; media.currentSrc = "";
  const root = new Element("html"), body = new Element("body");
  root.appendChild(body); body.appendChild(media);
  const notify = (changes, area = "local") => queueMicrotask(() => storageListeners.forEach((listener) => listener(changes, area)));
  const chrome = { runtime: { getURL: (url) => "chrome-extension://test/" + url }, storage: {
    local: {
      async get(key) { return key === null ? { ...values } : Object.hasOwn(values, key) ? { [key]: values[key] } : {}; },
      async set(changes) { const events = {}; for (const [key, value] of Object.entries(changes)) { events[key] = { oldValue: values[key], newValue: value }; values[key] = value; } notify(events); },
      async remove(keys) { const changes = {}; for (const key of Array.isArray(keys) ? keys : [keys]) { if (Object.hasOwn(values, key)) changes[key] = { oldValue: values[key] }; delete values[key]; } notify(changes); }
    }, onChanged: { addListener(listener) { storageListeners.push(listener); } }
  } };
  const settings = { enabled: true, imageSafety: true, imageSafetySexual: true, imageSafetySensitivity: "strict", imageSafetyHideUncertain: true };
  const context = vm.createContext({ Element, chrome, URL, setTimeout, clearTimeout, innerHeight: 800,
    requestAnimationFrame(callback) { raf.push(callback); return raf.length; },
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} },
    location: { href: "https://gall.dcinside.com/board/view/?id=test&no=1" },
    document: { documentElement: root, body, visibilityState: "visible", createElement: (tag) => new Element(tag), addEventListener(type, listener) { documentEvents[type] = listener; } }
  });
  context.window = context;
  context.addEventListener = (type, listener) => { windowEvents[type] = listener; };
  context.DCFilterStorage = { DEFAULTS: settings, normalizeSettings: (value) => value, loadSettings: options.loadSettings || (async () => ({ ...settings })), isSettingsChange: () => true };
  vm.runInContext(allowlistSource, context);
  vm.runInContext(guardSource, context);
  const cover = () => body.children.find((node) => node.dataset.dcfSafetyUi && node.tagName === "DIV");
  return {
    media, values, requests, context, cover,
    labels() { return cover()?.children.map((node) => node.textContent) || []; },
    button(text) { return cover()?.children.find((node) => node.tagName === "BUTTON" && node.textContent === text); },
    replace(source) { media.src = source; mutation([{ type: "attributes", attributeName: "src", target: media }]); },
    load() { documentEvents.load({ target: media }); },
    settingsChanged(changes) { notify(changes, "sync"); },
    respond(result, index = requests.length - 1) {
      const { message, frame } = requests[index];
      windowEvents.message({ origin: new URL(frame.src).origin, source: frame.contentWindow,
        data: { type: "dcf:safety:response", requestId: message.requestId, ok: !["error", "unsupported"].includes(result.status), result } });
    },
    async close() { settings.enabled = false; context.DCFilterStorage.loadSettings = async () => ({ ...settings }); notify({ enabled: { newValue: false } }, "sync"); await tick(); }
  };
}

test("stale allowed result cannot reveal a replacement source", async (t) => {
  const page = fixture(); t.after(() => page.close());
  await page.context.DCFImageAllowlist.add(digest);
  await tick();
  assert.equal(page.requests.length, 1);
  page.replace("https://dcimg1.dcinside.com/replacement.png");
  page.respond({ status: "allowed", contentDigest: digest }, 0);
  await tick();
  assert.equal(page.media.dataset.dcfSafetyState, "covered");
  assert.equal(page.requests.length, 2);
  page.respond({ status: "blocked", contentDigest: otherDigest });
  await tick();
  assert.equal(page.media.dataset.dcfSafetyState, "covered");
  assert.equal(page.button("항상 보기 취소"), undefined);
});

test("remember and revoke controls persist across pages and revocation hides pending checks", async (t) => {
  const values = {};
  const first = fixture({ values }); t.after(() => first.close()); await tick();
  first.respond({ status: "blocked", contentDigest: digest }); await tick();
  assert.equal(first.button("이 이미지는 항상 보기"), undefined, "must reveal before choosing persistent permission");
  first.button("이번만 보기").click();
  first.button("이 이미지는 항상 보기").click(); await tick();
  assert.equal(first.media.dataset.dcfSafetyState, "visible");
  assert.ok(first.button("항상 보기 취소"));
  const next = fixture({ values }); t.after(() => next.close()); await tick();
  assert.equal(next.media.dataset.dcfSafetyState, "covered", "saved permission still needs fresh bytes verified by worker");
  next.respond({ status: "allowed", contentDigest: digest }); await tick();
  assert.equal(next.media.dataset.dcfSafetyState, "visible");
  assert.ok(next.button("항상 보기 취소"));
  next.button("항상 보기 취소").click(); await tick();
  assert.equal(next.media.dataset.dcfSafetyState, "covered");
  assert.equal(await next.context.DCFImageAllowlist.has(digest), false);
  assert.equal(next.requests.length, 2);
});

test("same URL reloaded bytes must be verified again before a remembered image is revealed", async (t) => {
  const page = fixture(); t.after(() => page.close());
  await page.context.DCFImageAllowlist.add(digest); await tick();
  page.respond({ status: "allowed", contentDigest: digest }); await tick();
  assert.equal(page.media.dataset.dcfSafetyState, "visible");
  page.load(); await tick();
  assert.equal(page.media.dataset.dcfSafetyState, "covered");
  assert.equal(page.requests.length, 2);
  page.respond({ status: "blocked", contentDigest: otherDigest }); await tick();
  assert.equal(page.media.dataset.dcfSafetyState, "covered");
});

test("transient failure offers an explicit fresh retry while unsupported media has no retry", async (t) => {
  const page = fixture(); t.after(() => page.close()); await tick();
  page.respond({ status: "error", reason: "일시적 다운로드 실패" }); await tick();
  assert.ok(page.labels().includes("검사 실패 · 가림"));
  assert.equal(page.media.dataset.dcfSafetyState, "covered");
  page.button("다시 검사").click(); await tick();
  assert.equal(page.requests.length, 2);
  assert.equal(page.button("다시 검사"), undefined, "cannot enqueue repeated retries while pending");
  page.respond({ status: "safe", contentDigest: digest, analysisComplete: true }); await tick();
  assert.equal(page.media.dataset.dcfSafetyState, "visible");
  page.replace("https://dcimg1.dcinside.com/animation.gif"); await tick();
  assert.ok(page.labels().includes("자동 검사 미지원 · 가림"));
  assert.equal(page.button("다시 검사"), undefined);
  assert.equal(page.requests.length, 2, "GIF extension is skipped without a retry loop");
});

test("revocation while worker result is in flight prevents stale permission from revealing", async (t) => {
  const page = fixture(); t.after(() => page.close());
  await page.context.DCFImageAllowlist.add(digest); await tick();
  await page.context.DCFImageAllowlist.remove(digest);
  page.respond({ status: "allowed", contentDigest: digest }); await tick();
  assert.equal(page.media.dataset.dcfSafetyState, "covered");
  assert.equal(page.requests.length, 2, "revoked response causes a fresh classification");
  page.respond({ status: "blocked", contentDigest: digest }); await tick();
  assert.equal(page.media.dataset.dcfSafetyState, "covered");
});

test("a newer gallery settings read wins over an outdated initial global read", async (t) => {
  let initialResolve, reads = 0;
  const current = { enabled: true, imageSafety: true, imageSafetyHideUncertain: true };
  const page = fixture({ loadSettings: () => ++reads === 1 ? new Promise((resolve) => { initialResolve = resolve; }) : Promise.resolve(current) });
  t.after(() => page.close());
  page.settingsChanged({ galleryProfiles: { newValue: {} } }); await tick();
  assert.equal(page.requests.length, 1);
  initialResolve({ enabled: false, imageSafety: false }); await tick();
  assert.equal(page.media.dataset.dcfSafetyState, "covered", "old disabled default cannot expose current gallery images");
  page.respond({ status: "blocked", contentDigest: digest }); await tick();
  assert.equal(page.media.dataset.dcfSafetyState, "covered");
});

test("settings read failures expose retry and a recovered read resumes inspection", async (t) => {
  let reads = 0;
  const page = fixture({ loadSettings: async () => {
    if (++reads === 1) throw new Error("temporary storage failure");
    return { enabled: true, imageSafety: true, imageSafetyHideUncertain: true };
  } });
  t.after(() => page.close()); await tick();
  assert.equal(page.requests.length, 0);
  assert.equal(page.media.dataset.dcfSafetyState, "covered");
  page.button("다시 검사").click(); await tick();
  assert.equal(page.requests.length, 1);
  page.respond({ status: "safe", contentDigest: digest, analysisComplete: true }); await tick();
  assert.equal(page.media.dataset.dcfSafetyState, "visible");
});
