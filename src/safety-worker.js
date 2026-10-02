"use strict";

const SAFETY_REQUEST = "dcf:safety:request";
const SAFETY_RESPONSE = "dcf:safety:response";
const SAFETY_PARENT_ORIGIN = "https://gall.dcinside.com";
const SAFETY_MODEL_ROOT = new URL("../models/clip-vit-base-patch32/", location.href).href;
const SAFETY_MAX_PENDING = 32;
let safetyModelPromise;
let safetyQueue = Promise.resolve();
const safetyPending = new Set();
const safetyVerdicts = new Map();

function unsupportedSafety(reason) {
  const error = new Error(reason);
  error.safetyUnsupported = true;
  return error;
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (event.source !== parent || event.origin !== SAFETY_PARENT_ORIGIN) return;
  if (!message || message.type !== SAFETY_REQUEST || typeof message.requestId !== "string" ||
      !message.requestId || message.requestId.length > 128 || safetyPending.has(message.requestId)) return;
  if (safetyPending.size >= SAFETY_MAX_PENDING) {
    respondSafety(message.requestId, { status: "error", reason: "검사 대기 이미지가 많습니다. 잠시 뒤 다시 검사해 주세요." }, false);
    return;
  }
  safetyPending.add(message.requestId);
  const queuedAt = Date.now();
  safetyQueue = safetyQueue.catch(() => {}).then(async () => {
    try {
      if (Date.now() - queuedAt > 100000) throw new Error("검사 대기 시간이 길어 계속 가립니다.");
      const result = await classifySafetyImage(message.url, message.referrer, message);
      respondSafety(message.requestId, result);
    } catch (error) {
      respondSafety(message.requestId, { status: error?.safetyUnsupported ? "unsupported" : "error", reason: safetyErrorMessage(error) }, false);
    } finally {
      safetyPending.delete(message.requestId);
    }
  });
});

function respondSafety(requestId, result, ok = true) {
  parent.postMessage({ type: SAFETY_RESPONSE, requestId, ok, result,
    verdict: result.status, score: result.score, reason: result.reason }, SAFETY_PARENT_ORIGIN);
}

function safetyErrorMessage(error) {
  if (error?.name === "AbortError") return "이미지 검사 시간이 초과되어 계속 가립니다.";
  if (error?.message && !/onnx|wasm|backend|fetch|session/i.test(error.message)) return error.message.slice(0, 180);
  return "로컬 AI 또는 이미지를 불러오지 못해 계속 가립니다.";
}

function loadSafetyModel() {
  if (!safetyModelPromise) {
    safetyModelPromise = (async () => {
      // Every executable/model asset is packaged. There is no remote model fallback.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = new URL("../vendor/onnxruntime-web/", location.href).href;
      const response = await fetch(SAFETY_MODEL_ROOT + "safety-prompts.json", { credentials: "omit" });
      if (!response.ok) throw new Error("로컬 AI 판별 기준이 설치되지 않았습니다.");
      const data = await response.json();
      if (data.version !== 1 || !Array.isArray(data.prompts) || data.prompts.length !== 41) throw new Error("로컬 AI 자료가 손상되었습니다.");
      const session = await ort.InferenceSession.create(SAFETY_MODEL_ROOT + "vision_model_quantized.onnx", {
        executionProviders: ["wasm"], graphOptimizationLevel: "all"
      });
      return { session, prompts: data.prompts };
    })().catch((error) => { safetyModelPromise = null; throw error; });
  }
  return safetyModelPromise;
}

async function fetchSafetyImage(rawUrl, rawReferrer) {
  let url;
  try { url = DCFSafetyPolicy.validateImageUrl(rawUrl); }
  catch (error) { throw unsupportedSafety(error.message); }
  const referrer = new URL(String(rawReferrer || ""));
  if (referrer.origin !== SAFETY_PARENT_ORIGIN || referrer.username || referrer.password) throw new Error("게시글 주소를 확인할 수 없습니다.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // Reject redirects rather than sending any request to an unapproved host.
    // A URL can serve different bytes later. Re-read before using any hash-based
    // permission or verdict; URL-only decisions would expose a replacement.
    const response = await fetch(url.href, { credentials: "omit", cache: "no-store", redirect: "error",
      referrer: referrer.href, referrerPolicy: "unsafe-url", signal: controller.signal });
    if (!response.ok) throw new Error(`이미지를 불러오지 못해 계속 가립니다. (HTTP ${response.status})`);
    DCFSafetyPolicy.validateImageUrl(response.url || url.href);
    if (Number(response.headers.get("content-length")) > DCFSafetyPolicy.MAX_IMAGE_BYTES) throw unsupportedSafety("12MB가 넘는 이미지는 자동 검사하지 않습니다.");
    if (!response.body) throw new Error("이미지 데이터가 없습니다.");
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > DCFSafetyPolicy.MAX_IMAGE_BYTES) {
          controller.abort();
          throw unsupportedSafety("12MB가 넘는 이미지는 자동 검사하지 않습니다.");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { clearTimeout(timer); }
}

async function classifySafetyImage(rawUrl, rawReferrer, options) {
  const bytes = await fetchSafetyImage(rawUrl, rawReferrer);
  return classifySafetyBytes(bytes, options);
}

// A normal lexical function for browser verification, not an extra public message API.
async function classifySafetyBytes(bytes, options = {}) {
  let format;
  try { format = DCFSafetyPolicy.inspectImageBytes(bytes); }
  catch (error) { throw unsupportedSafety(error.message); }
  const bitmap = await createImageBitmap(new Blob([bytes], { type: format.type }));
  try {
    try { DCFSafetyPolicy.checkDimensions(bitmap.width, bitmap.height); }
    catch (error) { throw unsupportedSafety(error.message); }
    const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const contentDigest = Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    // A missing/unreadable allowlist must never grant permission.
    let allowed = false;
    try { allowed = await DCFImageAllowlist.has(contentDigest); } catch (_error) {}
    if (allowed) return { status: "allowed", contentDigest, reason: "이 PC에서 항상 보기로 허용한 이미지입니다." };
    const cacheKey = `${options.sexual !== false}:${options.sensitivity === "balanced" ? "balanced" : "strict"}:${contentDigest}`;
    if (safetyVerdicts.has(cacheKey)) return safetyVerdicts.get(cacheKey);
    const model = await loadSafetyModel();
    const regions = safetyImageRegions(bitmap.width, bitmap.height);
    let finalResult = { status: "safe", score: 0, reason: "로컬 AI 검사 통과" };
    for (const region of regions) {
      const input = safetyImageTensor(bitmap, region);
      let output;
      try {
        output = await model.session.run({ pixel_values: input });
        const result = DCFSafetyPolicy.classifyEmbedding(output.image_embeds.data, model.prompts, options);
        if (result.status === "blocked") return rememberSafetyVerdict(cacheKey, { ...result, contentDigest });
        if ((result.status === "uncertain" && finalResult.status === "safe") ||
            (result.status === finalResult.status && result.score > finalResult.score)) finalResult = result;
      } finally {
        input.dispose();
        if (output) for (const tensor of Object.values(output)) tensor.dispose();
      }
    }
    // Only a completed scan of every region may relax an ambiguous verdict.
    // Decode/model failures and skipped formats never receive this marker.
    return rememberSafetyVerdict(cacheKey, { ...finalResult, contentDigest, analysisComplete: true });
  } finally { bitmap.close(); }
}

function rememberSafetyVerdict(key, result) {
  if (safetyVerdicts.size >= 180) safetyVerdicts.delete(safetyVerdicts.keys().next().value);
  safetyVerdicts.set(key, result);
  return result;
}

function safetyImageRegions(width, height) {
  const regions = [{ x: 0, y: 0, width, height, contain: true }];
  const side = Math.min(width, height);
  if (Math.max(width / height, height / width) > 1.2) {
    // Overlapping tiles retain image edges that CLIP's default center crop loses.
    const count = Math.min(5, Math.ceil(Math.max(width, height) / side));
    for (let index = 0; index < count; index++) {
      const fraction = count === 1 ? 0 : index / (count - 1);
      regions.push({ x: (width - side) * fraction, y: (height - side) * fraction, width: side, height: side, contain: false });
    }
  }
  return regions;
}

function safetyImageTensor(bitmap, region) {
  const size = 224;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("이미지 검사 화면을 만들지 못했습니다.");
  context.fillStyle = "rgb(123,117,104)";
  context.fillRect(0, 0, size, size);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const scale = Math.min(size / region.width, size / region.height);
  const width = region.width * scale, height = region.height * scale;
  context.drawImage(bitmap, region.x, region.y, region.width, region.height, (size - width) / 2, (size - height) / 2, width, height);
  const pixels = context.getImageData(0, 0, size, size).data;
  const input = new Float32Array(3 * size * size);
  const mean = [0.48145466, 0.4578275, 0.40821073];
  const std = [0.26862954, 0.26130258, 0.27577711];
  for (let channel = 0; channel < 3; channel++) {
    for (let index = 0; index < size * size; index++) input[channel * size * size + index] = (pixels[index * 4 + channel] / 255 - mean[channel]) / std[channel];
  }
  return new ort.Tensor("float32", input, [1, 3, size, size]);
}
