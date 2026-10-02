"use strict";

const SAFETY_REQUEST = "dcf:safety:request";
const SAFETY_RESPONSE = "dcf:safety:response";
const SAFETY_PARENT_ORIGIN = "https://gall.dcinside.com";
const SAFETY_MODEL_ROOT = new URL("../models/clip-vit-base-patch32/", location.href).href;
const SAFETY_MAX_PENDING = 32;
let safetyModelPromise;
let safetyQueue = Promise.resolve();
const safetyPending = new Set();

window.addEventListener("message", (event) => {
  const message = event.data;
  if (event.source !== parent || event.origin !== SAFETY_PARENT_ORIGIN) return;
  if (!message || message.type !== SAFETY_REQUEST || typeof message.requestId !== "string" ||
      !message.requestId || message.requestId.length > 128 || safetyPending.has(message.requestId)) return;
  if (safetyPending.size >= SAFETY_MAX_PENDING) {
    respondSafety(message.requestId, { status: "uncertain", reason: "검사 대기 이미지가 많아 계속 가립니다." });
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
      respondSafety(message.requestId, { status: "uncertain", reason: safetyErrorMessage(error) }, false);
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
    })();
  }
  return safetyModelPromise;
}

async function fetchSafetyImage(rawUrl, rawReferrer) {
  const url = DCFSafetyPolicy.validateImageUrl(rawUrl);
  const referrer = new URL(String(rawReferrer || ""));
  if (referrer.origin !== SAFETY_PARENT_ORIGIN || referrer.username || referrer.password) throw new Error("게시글 주소를 확인할 수 없습니다.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // Reject redirects rather than sending any request to an unapproved host.
    const response = await fetch(url.href, { credentials: "omit", cache: "force-cache", redirect: "error",
      referrer: referrer.href, referrerPolicy: "unsafe-url", signal: controller.signal });
    if (!response.ok) throw new Error(`이미지를 불러오지 못해 계속 가립니다. (HTTP ${response.status})`);
    DCFSafetyPolicy.validateImageUrl(response.url || url.href);
    if (Number(response.headers.get("content-length")) > DCFSafetyPolicy.MAX_IMAGE_BYTES) throw new Error("12MB가 넘는 이미지는 계속 가립니다.");
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
          throw new Error("12MB가 넘는 이미지는 계속 가립니다.");
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
async function classifySafetyBytes(bytes, options) {
  const format = DCFSafetyPolicy.inspectImageBytes(bytes);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: format.type }));
  try {
    DCFSafetyPolicy.checkDimensions(bitmap.width, bitmap.height);
    const model = await loadSafetyModel();
    const regions = safetyImageRegions(bitmap.width, bitmap.height);
    let finalResult = { status: "safe", score: 0, reason: "로컬 AI 검사 통과" };
    for (const region of regions) {
      const input = safetyImageTensor(bitmap, region);
      let output;
      try {
        output = await model.session.run({ pixel_values: input });
        const result = DCFSafetyPolicy.classifyEmbedding(output.image_embeds.data, model.prompts, options);
        if (result.status === "blocked") return result;
        if ((result.status === "uncertain" && finalResult.status === "safe") ||
            (result.status === finalResult.status && result.score > finalResult.score)) finalResult = result;
      } finally {
        input.dispose();
        if (output) for (const tensor of Object.values(output)) tensor.dispose();
      }
    }
    // Only a completed scan of every region may relax an ambiguous verdict.
    // Decode/model failures and skipped formats never receive this marker.
    return { ...finalResult, analysisComplete: true };
  } finally { bitmap.close(); }
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
