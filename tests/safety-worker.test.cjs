"use strict";

// Exercise the shipped worker's queue, resource cleanup and completion marker.
// Inference/decoding are mocked: these tests make no detector-accuracy claim.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto, createHash } = require("node:crypto");
const policy = require("../src/safety-policy.js");
const source = fs.readFileSync(path.join(__dirname, "../src/safety-worker.js"), "utf8");
const origin = "https://gall.dcinside.com";
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64"));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(options = {}) {
  const requests = new Map();
  const messages = [];
  const inputTensors = [];
  const outputTensors = [];
  const draws = [];
  const state = { runs: 0, classifications: 0, modelLoads: 0, bitmapCreates: 0, bitmapCloses: 0, imageFetches: 0 };
  const stages = options.stages || [];
  const handlers = {};
  const parent = { postMessage(message, target) {
    assert.equal(target, origin);
    messages.push(message);
    const waiter = requests.get(message.requestId);
    if (waiter) { requests.delete(message.requestId); waiter.resolve(message); }
  } };
  const session = { async run() {
    const index = state.runs++;
    const stage = stages[index] || {};
    if (stage.wait) await stage.wait.promise;
    if (stage.error) throw stage.error;
    const tensor = { data: [index], disposed: false, dispose() { this.disposed = true; } };
    outputTensors.push(tensor);
    return { image_embeds: tensor };
  } };
  const ort = {
    env: { wasm: {} },
    Tensor: class Tensor {
      constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; this.disposed = false; inputTensors.push(this); }
      dispose() { this.disposed = true; }
    },
    InferenceSession: { async create() {
      state.modelLoads++;
      if (options.modelError) throw options.modelError;
      return session;
    } }
  };
  const context = vm.createContext({
    window: { addEventListener(name, handler) { handlers[name] = handler; } },
    parent, location: { href: "chrome-extension://test/src/safety-worker.html" },
    URL, Blob, Uint8Array, Float32Array, AbortController, setTimeout, clearTimeout, crypto: webcrypto,
    DCFImageAllowlist: { async has(digest) { return options.allowed?.has(digest) || false; } },
    ort,
    DCFSafetyPolicy: { ...policy, classifyEmbedding(data) {
      state.classifications++;
      const stage = stages[data[0]] || {};
      if (stage.policyError) throw stage.policyError;
      return stage.result || { status: "safe", score: .01, reason: "fixture safe" };
    } },
    async fetch(url, request) {
      if (String(url).endsWith("safety-prompts.json")) {
        return { ok: true, async json() { return options.prompts || { version: 1, prompts: Array(41).fill({}) }; } };
      }
      if (options.fetchError) throw options.fetchError;
      assert.equal(request.cache, "no-store", "a cached URL must never authorize changed bytes");
      state.imageFetches++;
      let sent = false;
      return { ok: true, url: String(url), headers: { get() { return null; } },
        body: { getReader() { return {
          async read() { if (sent) return { done: true }; sent = true; return { done: false, value: typeof options.bytes === "function" ? options.bytes() : options.bytes || png }; },
          releaseLock() {}
        }; } } };
    },
    async createImageBitmap() {
      state.bitmapCreates++;
      if (options.decodeError) throw options.decodeError;
      return { width: options.width || 600, height: options.height || 200, close() { state.bitmapCloses++; } };
    },
    OffscreenCanvas: class OffscreenCanvas {
      getContext() {
        return { fillRect() {}, drawImage(...args) { draws.push(args); },
          getImageData() { return { data: new Uint8ClampedArray(224 * 224 * 4) }; } };
      }
    }
  });
  vm.runInContext(source, context, { filename: "src/safety-worker.js" });
  return {
    context, state, messages, inputTensors, outputTensors, draws,
    direct() { return context.classifySafetyBytes(options.bytes || png, { sexual: true }); },
    dispatch(requestId = "image-1") {
      const waiter = deferred();
      requests.set(requestId, waiter);
      handlers.message({ source: parent, origin, data: { type: "dcf:safety:request", requestId,
        url: "https://dcimg1.dcinside.com/viewimage.php?id=fixture", referrer: origin + "/board/view/?id=test&no=1" } });
      return waiter.promise;
    },
    async waitForRun(count) {
      for (let attempt = 0; attempt < 30 && state.runs < count; attempt++) await new Promise(setImmediate);
      assert.equal(state.runs, count, "worker reached the expected inference stage");
    }
  };
}

function assertNoCompletion(message) {
  assert.notEqual(message.result.analysisComplete, true);
  assert.equal(Object.hasOwn(message.result, "analysisComplete"), false);
  assert.equal(Object.hasOwn(message, "analysisComplete"), false);
}

test("worker emits uncertain completion only after every image region finishes", async () => {
  const second = deferred(), last = deferred();
  const worker = fixture({ stages: [
    { result: { status: "uncertain", score: .7, reason: "full image ambiguous" } },
    { wait: second }, {}, { wait: last }
  ] });
  const response = worker.dispatch();
  await worker.waitForRun(2);
  assert.equal(worker.messages.length, 0, "an early uncertain region must not expose the image");
  assert.equal(worker.state.bitmapCloses, 0);
  second.resolve();
  await worker.waitForRun(4);
  assert.equal(worker.messages.length, 0, "the last tile still gates completion");
  last.resolve();
  const message = await response;
  assert.equal(message.ok, true);
  assert.equal(message.result.status, "uncertain");
  assert.equal(message.result.analysisComplete, true);
  assert.equal(message.result.reason, "full image ambiguous");
  assert.equal(worker.state.runs, 4);
  assert.equal(worker.state.classifications, 4);
  assert.equal(worker.state.bitmapCloses, 1);
  assert.ok(worker.inputTensors.every((tensor) => tensor.disposed));
  assert.ok(worker.outputTensors.every((tensor) => tensor.disposed));
});

test("later blocked tile takes precedence over uncertain and never claims a complete scan", async () => {
  const worker = fixture({ stages: [
    { result: { status: "uncertain", score: .9, reason: "ambiguous" } },
    {}, { result: { status: "blocked", score: .8, reason: "blocked in edge tile" } }
  ] });
  const message = await worker.dispatch();
  assert.equal(message.ok, true);
  assert.equal(message.result.status, "blocked");
  assert.equal(message.result.reason, "blocked in edge tile");
  assertNoCompletion(message);
  assert.equal(worker.state.runs, 3, "remaining tile need not run after a block");
  assert.equal(worker.state.bitmapCloses, 1);
  assert.ok(worker.inputTensors.every((tensor) => tensor.disposed));
  assert.ok(worker.outputTensors.every((tensor) => tensor.disposed));
});

test("later inference failure discards prior uncertain verdict without a completion marker", async () => {
  const worker = fixture({ stages: [
    { result: { status: "uncertain", score: .8, reason: "ambiguous" } },
    {}, { error: new Error("onnx session failure") }
  ] });
  const message = await worker.dispatch();
  assert.equal(message.ok, false);
  assert.equal(message.result.status, "error");
  assertNoCompletion(message);
  assert.equal(worker.state.runs, 3);
  assert.equal(worker.state.bitmapCloses, 1);
  assert.ok(worker.inputTensors.every((tensor) => tensor.disposed), "failing input tensor is released");
  assert.ok(worker.outputTensors.every((tensor) => tensor.disposed));
});

test("decode, model, malformed model, fetch and unsupported-format failures cannot claim completion", async (t) => {
  const cases = [
    ["decode", { decodeError: new Error("decode failed") }, 1, 0],
    ["model", { modelError: new Error("onnx session failed") }, 1, 1],
    ["malformed model", { prompts: { version: 1, prompts: [] } }, 1, 1],
    ["fetch", { fetchError: new Error("fetch failed") }, 0, 0],
    ["unsupported GIF", { bytes: Uint8Array.from(Buffer.from("GIF89a")) }, 0, 0]
  ];
  for (const [name, options, creates, closes] of cases) await t.test(name, async () => {
    const worker = fixture(options);
    const message = await worker.dispatch();
    assert.equal(message.ok, false);
    assert.equal(message.result.status, name === "unsupported GIF" ? "unsupported" : "error");
    assertNoCompletion(message);
    assert.equal(worker.state.runs, 0);
    assert.equal(worker.state.bitmapCreates, creates);
    assert.equal(worker.state.bitmapCloses, closes);
  });
});

test("invalid later model output follows the failure path and releases output tensors", async () => {
  const worker = fixture({ stages: [
    { result: { status: "uncertain", score: .3, reason: "ambiguous" } },
    { policyError: new Error("invalid model output") }
  ] });
  const message = await worker.dispatch();
  assert.equal(message.ok, false);
  assertNoCompletion(message);
  assert.equal(worker.state.runs, 2);
  assert.ok(worker.inputTensors.every((tensor) => tensor.disposed));
  assert.ok(worker.outputTensors.every((tensor) => tensor.disposed));
});

test("a fully safe scan and a single square-image scan both carry completion", async () => {
  for (const [width, height, expectedRuns] of [[600, 200, 4], [200, 200, 1]]) {
    const worker = fixture({ width, height });
    const result = await worker.direct();
    assert.equal(result.status, "safe");
    assert.equal(result.analysisComplete, true);
    assert.equal(worker.state.runs, expectedRuns);
    assert.equal(worker.state.bitmapCloses, 1);
  }
});

test("ambiguous verdict survives later safe tiles and retains the strongest ambiguous score", async () => {
  const worker = fixture({ stages: [
    { result: { status: "uncertain", score: .4, reason: "first ambiguous" } },
    { result: { status: "uncertain", score: .6, reason: "second ambiguous" } },
    { result: { status: "safe", score: .9, reason: "safe cannot replace ambiguous" } },
    { result: { status: "uncertain", score: .5, reason: "last ambiguous" } }
  ] });
  const result = await worker.direct();
  assert.equal(result.status, "uncertain");
  assert.equal(result.score, .6);
  assert.equal(result.reason, "second ambiguous");
  assert.equal(result.analysisComplete, true);
});

test("persistent permission skips inference only for identical supported bytes and revocation applies", async () => {
  const digest = createHash("sha256").update(png).digest("hex");
  const allowed = new Set([digest]);
  const worker = fixture({ allowed });
  const first = await worker.dispatch("allowed");
  assert.equal(first.result.status, "allowed");
  assert.equal(first.result.contentDigest, digest);
  assert.equal(worker.state.modelLoads, 0);
  assert.equal(worker.state.runs, 0);
  allowed.delete(digest);
  const second = await worker.dispatch("revoked");
  assert.equal(second.result.status, "safe");
  assert.equal(worker.state.runs, 4);
  assert.equal(worker.state.imageFetches, 2);
});

test("same URL with new bytes is classified instead of borrowing remembered permission", async () => {
  const digest = createHash("sha256").update(png).digest("hex");
  // Change the last byte; decoder is mocked, byte identity is real WebCrypto.
  const changed = png.slice(); changed[changed.length - 1] ^= 1;
  let bytes = png;
  const worker = fixture({ allowed: new Set([digest]), bytes: () => bytes,
    stages: [{ result: { status: "blocked", reason: "changed image" } }] });
  assert.equal((await worker.dispatch("first")).result.status, "allowed");
  bytes = changed;
  const replacement = await worker.dispatch("replacement");
  assert.equal(replacement.result.status, "blocked");
  assert.notEqual(replacement.result.contentDigest, digest);
  assert.equal(worker.state.runs, 1);
});

test("transient fetch and model errors can be retried and are never cached", async () => {
  const options = { fetchError: new Error("temporary fetch failure"), modelError: new Error("temporary model failure") };
  const worker = fixture(options);
  assert.equal((await worker.dispatch("fetch-error")).result.status, "error");
  options.fetchError = null;
  assert.equal((await worker.dispatch("model-error")).result.status, "error");
  options.modelError = null;
  const retried = await worker.dispatch("retry");
  assert.equal(retried.result.status, "safe");
  assert.equal(worker.state.modelLoads, 2);
  assert.equal(worker.state.runs, 4);
});

test("allowlist cannot bypass unsupported animated image checks", async () => {
  const bytes = Uint8Array.from(Buffer.from("GIF89a"));
  const worker = fixture({ bytes, allowed: new Set([createHash("sha256").update(bytes).digest("hex")]) });
  const result = await worker.dispatch();
  assert.equal(result.result.status, "unsupported");
  assert.equal(worker.state.modelLoads, 0);
  assert.equal(result.result.contentDigest, undefined);
});
