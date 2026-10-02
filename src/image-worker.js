"use strict";

const IMAGE_WORKER_REQUEST = "dcf:image-fingerprint:request";
const IMAGE_WORKER_RESPONSE = "dcf:image-fingerprint:response";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const HASH_SAMPLE_SIZE = 9;
const ALLOWED_IMAGE_HOST = /(^|\.)dcinside\.(?:com|co\.kr)$/i;
const ALLOWED_PARENT_ORIGIN = "https://gall.dcinside.com";

window.addEventListener("message", (event) => {
  const message = event.data;
  if (event.source !== parent || event.origin !== ALLOWED_PARENT_ORIGIN) return;
  if (!message || message.type !== IMAGE_WORKER_REQUEST || typeof message.requestId !== "string") return;

  fingerprintImage(message.url, message.referrer)
    .then((fingerprint) => respond(message.requestId, { ok: true, fingerprint }))
    .catch((error) => respond(message.requestId, { ok: false, error: normalizeError(error) }));
});

function respond(requestId, result) {
  parent.postMessage(Object.assign({ type: IMAGE_WORKER_RESPONSE, requestId }, result), ALLOWED_PARENT_ORIGIN);
}

async function fingerprintImage(rawUrl, rawReferrer) {
  const url = validateImageUrl(rawUrl);
  const referrer = validatePageReferrer(rawReferrer);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url.href, {
      credentials: "omit",
      cache: "force-cache",
      redirect: "follow",
      referrer,
      referrerPolicy: "unsafe-url",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`이미지 HTTP ${response.status}`);
    validateImageUrl(response.url || url.href);

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_IMAGE_BYTES) throw new Error("이미지가 25MB를 초과합니다.");

    const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (contentType && !contentType.startsWith("image/") && contentType !== "application/octet-stream") {
      throw new Error("이미지 응답이 아닙니다.");
    }

    const blob = await response.blob();
    if (!blob.size || blob.size > MAX_IMAGE_BYTES) throw new Error("이미지 크기를 처리할 수 없습니다.");
    const bitmap = await createImageBitmap(blob);
    try {
      if (!bitmap.width || !bitmap.height) throw new Error("이미지를 해석하지 못했습니다.");
      return createVisualFingerprint(bitmap);
    } finally {
      bitmap.close();
    }
  } finally {
    clearTimeout(timeout);
  }
}

function createVisualFingerprint(bitmap) {
  const canvas = new OffscreenCanvas(HASH_SAMPLE_SIZE, HASH_SAMPLE_SIZE);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("이미지 분석 캔버스를 만들지 못했습니다.");

  context.fillStyle = "#808080";
  context.fillRect(0, 0, HASH_SAMPLE_SIZE, HASH_SAMPLE_SIZE);
  context.drawImage(bitmap, 0, 0, HASH_SAMPLE_SIZE, HASH_SAMPLE_SIZE);

  const pixels = context.getImageData(0, 0, HASH_SAMPLE_SIZE, HASH_SAMPLE_SIZE).data;
  const luminance = [];
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index];
    const g = pixels[index + 1];
    const b = pixels[index + 2];
    red += r;
    green += g;
    blue += b;
    luminance.push((r * 299 + g * 587 + b * 114) / 1000);
  }

  const bits = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const offset = y * HASH_SAMPLE_SIZE + x;
      bits.push(luminance[offset] > luminance[offset + 1] ? 1 : 0);
    }
  }
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const offset = y * HASH_SAMPLE_SIZE + x;
      bits.push(luminance[offset] > luminance[offset + HASH_SAMPLE_SIZE] ? 1 : 0);
    }
  }

  const pixelCount = HASH_SAMPLE_SIZE * HASH_SAMPLE_SIZE;
  return {
    version: 1,
    hash: bitsToHex(bits),
    color: [red, green, blue].map((sum) => Math.round(sum / pixelCount).toString(16).padStart(2, "0")).join(""),
    width: bitmap.width,
    height: bitmap.height,
    aspect: Number((bitmap.width / bitmap.height).toFixed(6))
  };
}

function bitsToHex(bits) {
  let output = "";
  for (let index = 0; index < bits.length; index += 4) {
    const value = bits[index] * 8 + bits[index + 1] * 4 + bits[index + 2] * 2 + bits[index + 3];
    output += value.toString(16);
  }
  return output;
}

function validateImageUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch (_error) {
    throw new Error("이미지 주소가 올바르지 않습니다.");
  }
  if (url.protocol !== "https:" || !ALLOWED_IMAGE_HOST.test(url.hostname)) {
    throw new Error("허용되지 않은 이미지 주소입니다.");
  }
  return url;
}

function validatePageReferrer(rawReferrer) {
  let url;
  try {
    url = new URL(String(rawReferrer || ""));
  } catch (_error) {
    throw new Error("게시글 주소가 올바르지 않습니다.");
  }
  if (url.protocol !== "https:" || url.origin !== ALLOWED_PARENT_ORIGIN) {
    throw new Error("허용되지 않은 게시글 주소입니다.");
  }
  return url.href;
}

function normalizeError(error) {
  if (error && error.name === "AbortError") return "이미지 분석 시간이 초과됐습니다.";
  return error && error.message ? error.message : "이미지 지문을 만들지 못했습니다.";
}
