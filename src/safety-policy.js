"use strict";

// Kept independent of the DOM so the fail-closed decision rules are testable.
(function (root) {
  const POLICY_VERSION = "clip-local-v1";
  const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
  const MAX_IMAGE_PIXELS = 24 * 1024 * 1024;
  const MAX_IMAGE_EDGE = 10000;

  function normalizeOptions(options = {}) {
    return { sexual: options.sexual !== false, sensitivity: options.sensitivity === "balanced" ? "balanced" : "strict" };
  }

  function validateImageUrl(rawUrl) {
    if (typeof rawUrl !== "string" || rawUrl.length > 8192) throw new Error("이미지 주소를 확인할 수 없습니다.");
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || !/(^|\.)dcinside\.(?:com|co\.kr)$/i.test(url.hostname) ||
        url.username || url.password || (url.port && url.port !== "443")) {
      throw new Error("디시인사이드 HTTPS 이미지만 자동 검사합니다.");
    }
    url.hash = "";
    return url;
  }

  function checkDimensions(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_IMAGE_PIXELS) {
      throw new Error("이미지 해상도가 검사 범위를 벗어나 계속 가립니다.");
    }
    if (Math.max(width / height, height / width) > 4) {
      throw new Error("너무 긴 이미지는 전체를 확인하기 어려워 계속 가립니다.");
    }
  }

  function inspectImageBytes(bytes) {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) {
      throw new Error("이미지 크기를 처리할 수 없습니다.");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ascii = (at, size) => String.fromCharCode(...bytes.subarray(at, at + size));
    if (ascii(0, 3) === "GIF") throw new Error("GIF는 움직이는 장면을 모두 검사할 수 없어 계속 가립니다.");

    if (bytes.length >= 24 && bytes[0] === 137 && ascii(1, 3) === "PNG" &&
        bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) {
      if (ascii(12, 4) !== "IHDR") throw new Error("PNG 형식을 확인할 수 없습니다.");
      const width = view.getUint32(16), height = view.getUint32(20);
      checkDimensions(width, height);
      let offset = 8, ended = false;
      while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset);
        const type = ascii(offset + 4, 4);
        if (length > bytes.length - offset - 12) throw new Error("PNG 데이터가 불완전합니다.");
        if (type === "acTL" || type === "fcTL" || type === "fdAT") throw new Error("움직이는 PNG는 계속 가립니다.");
        offset += length + 12;
        if (type === "IEND") { ended = true; break; }
      }
      if (!ended) throw new Error("PNG 데이터를 끝까지 확인할 수 없습니다.");
      return { type: "image/png", width, height };
    }

    if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
      if (view.getUint32(4, true) + 8 !== bytes.length) throw new Error("WebP 데이터가 불완전합니다.");
      let offset = 12, width = 0, height = 0, hasImage = false;
      const u24 = (at) => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
      while (offset + 8 <= bytes.length) {
        const type = ascii(offset, 4), length = view.getUint32(offset + 4, true), data = offset + 8;
        if (length > bytes.length - data) throw new Error("WebP 데이터를 확인할 수 없습니다.");
        if (type === "ANIM" || type === "ANMF" || (type === "VP8X" && length >= 10 && (bytes[data] & 2))) {
          throw new Error("움직이는 WebP는 계속 가립니다.");
        }
        if (type === "VP8X" && length >= 10) { width = u24(data + 4) + 1; height = u24(data + 7) + 1; }
        if (type === "VP8 " && length >= 10) {
          if (bytes[data + 3] !== 157 || bytes[data + 4] !== 1 || bytes[data + 5] !== 42) throw new Error("WebP 프레임을 확인할 수 없습니다.");
          width = view.getUint16(data + 6, true) & 16383; height = view.getUint16(data + 8, true) & 16383; hasImage = true;
        }
        if (type === "VP8L" && length >= 5 && bytes[data] === 47) {
          const bits = view.getUint32(data + 1, true);
          width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1; hasImage = true;
        }
        offset = data + length + (length % 2);
      }
      if (!hasImage || offset !== bytes.length) throw new Error("정지 WebP를 확인할 수 없습니다.");
      checkDimensions(width, height);
      return { type: "image/webp", width, height };
    }

    if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
      let offset = 2;
      while (offset + 4 <= bytes.length) {
        if (bytes[offset++] !== 255) break;
        while (bytes[offset] === 255) offset++;
        const marker = bytes[offset++];
        if (marker === 218 || marker === 217) break;
        if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
        if (offset + 2 > bytes.length) break;
        const length = view.getUint16(offset);
        if (length < 2 || offset + length > bytes.length) break;
        if ([192, 193, 194].includes(marker) && length >= 8) {
          const height = view.getUint16(offset + 3), width = view.getUint16(offset + 5);
          checkDimensions(width, height);
          return { type: "image/jpeg", width, height };
        }
        offset += length;
      }
      throw new Error("JPEG 해상도를 확인할 수 없습니다.");
    }
    throw new Error("정지 JPEG·PNG·WebP만 자동 검사하며 다른 형식은 계속 가립니다.");
  }

  function classifyEmbedding(embedding, prompts, rawOptions) {
    const options = normalizeOptions(rawOptions);
    let norm = 0;
    for (const value of embedding) {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("AI 분석 값이 올바르지 않습니다.");
      norm += value * value;
    }
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm <= 0) throw new Error("AI 분석 결과를 확인할 수 없습니다.");
    let safe = -1, unsafe = -1, category = "blocked";
    for (const entry of prompts) {
      if (entry.category === "sexual" && !options.sexual) continue;
      if (!Array.isArray(entry.embedding) || entry.embedding.length !== embedding.length || entry.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("AI 모델 자료가 일치하지 않습니다.");
      let similarity = 0;
      for (let index = 0; index < embedding.length; index++) similarity += embedding[index] * entry.embedding[index] / norm;
      if (!Number.isFinite(similarity)) throw new Error("AI 분석 점수가 올바르지 않습니다.");
      if (entry.category === "safe") safe = Math.max(safe, similarity);
      else if (similarity > unsafe) { unsafe = similarity; category = entry.category; }
    }
    if (safe < 0 || unsafe < 0) throw new Error("AI 판별 기준을 확인할 수 없습니다.");
    // Similarity-derived indicator only; this is NOT a calibrated probability.
    const score = Number((1 / (1 + Math.exp((safe - unsafe) * 50))).toFixed(4));
    const margin = safe - unsafe;
    if (unsafe >= 0.2 && margin <= -0.015) {
      return { status: "blocked", score, reason: category === "sexual" ? "선정적 이미지 의심" : "혐오·유혈 이미지 의심" };
    }
    const safeFloor = options.sensitivity === "strict" ? 0.23 : 0.20;
    const safeMargin = options.sensitivity === "strict" ? 0.055 : 0.035;
    if (safe >= safeFloor && margin >= safeMargin) return { status: "safe", score, reason: "로컬 AI 검사 통과" };
    return { status: "uncertain", score, reason: "로컬 AI가 확실히 판별하지 못해 계속 가립니다." };
  }

  const api = { POLICY_VERSION, MAX_IMAGE_BYTES, normalizeOptions, validateImageUrl, checkDimensions, inspectImageBytes, classifyEmbedding };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DCFSafetyPolicy = Object.freeze(api);
})(typeof globalThis !== "undefined" ? globalThis : this);
