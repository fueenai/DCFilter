(function () {
  "use strict";

  const releases = window.DCFilterReleaseUpdates;
  const status = document.getElementById("updateStatus");
  const button = document.getElementById("checkUpdates");
  const link = document.getElementById("updateReleaseLink");
  if (!releases || !status || !button || !link) return;

  const installedVersion = chrome.runtime.getManifest().version;
  const MAX_RESPONSE_BYTES = 1024 * 1024;
  const TIMEOUT_MS = 10000;
  let cache = releases.normalizeCache(null, Date.now());
  let busy = false;

  button.addEventListener("click", () => check(true));
  init().catch(() => { status.textContent = "업데이트 정보를 불러오지 못했습니다. 다시 확인해 주세요."; });

  async function init() {
    button.disabled = true;
    try {
      const stored = await chrome.storage.local.get(releases.CACHE_KEY);
      cache = releases.normalizeCache(stored[releases.CACHE_KEY], Date.now());
    } catch (_error) {
      // Checking still works when local caching is unavailable.
    }
    button.disabled = false;
    render();
    await check(false);
  }

  function render(note) {
    const view = releases.describe(cache, installedVersion);
    status.textContent = note ? `${note} ${view.message}` : view.message;
    link.hidden = !view.url;
    link.href = view.url || releases.RELEASES_URL;
    link.textContent = view.label;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }

  async function persist() {
    try { await chrome.storage.local.set({ [releases.CACHE_KEY]: cache }); }
    catch (_error) { /* A cache write failure must not discard a valid result. */ }
  }

  async function readBoundedJSON(response) {
    const length = Number(response.headers.get("content-length"));
    if (length > MAX_RESPONSE_BYTES) throw failure("response");
    const type = response.headers.get("content-type") || "";
    if (!/^application\/(?:json|vnd\.github\+json)(?:\s*;|$)/i.test(type) || !response.body) throw failure("response");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0, text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw failure("response");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw failure("response");
    } finally {
      reader.releaseLock();
    }
  }

  function failure(code, retryAt) {
    const error = new Error(code);
    error.updateCode = code;
    error.retryAt = retryAt || 0;
    return error;
  }

  function rateLimitRetry(response, now) {
    const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
    const retry = Number(response.headers.get("retry-after")) * 1000 + now;
    return Math.min(now + releases.CHECK_INTERVAL, Math.max(now + releases.MANUAL_INTERVAL, Number.isFinite(reset) ? reset : 0, Number.isFinite(retry) ? retry : 0));
  }

  async function check(manual) {
    if (busy) return;
    const now = Date.now();
    if (!releases.shouldCheck(cache, now, manual)) {
      render(manual ? "최근 확인 결과입니다. 잠시 후 다시 확인할 수 있습니다." : "");
      return;
    }
    busy = true;
    button.disabled = true;
    status.textContent = "GitHub에서 새 버전을 확인하는 중…";
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
    cache = { ...cache, lastAttemptAt: now, retryAt: 0 };
    // Persist completed failures too, but not an in-flight request: closing this popup
    // during its first request must not suppress the next check for a whole day.
    try {
      const response = await fetch(releases.API_URL, {
        method: "GET", credentials: "omit", redirect: "error", cache: "no-store",
        referrerPolicy: "no-referrer", signal: controller.signal,
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" }
      });
      if (response.url !== releases.API_URL || response.redirected) throw failure("response");
      if (response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")))) {
        throw failure("rate-limit", rateLimitRetry(response, now));
      }
      if (response.status === 403) throw failure("forbidden");
      if (response.status !== 200) throw failure("unavailable");
      let latest;
      try { latest = releases.selectLatest(await readBoundedJSON(response)); }
      catch (error) { if (error.name === "AbortError") throw error; throw failure("response"); }
      cache = { schema: 1, lastAttemptAt: now, lastSuccessAt: now, retryAt: 0, latest, error: "" };
    } catch (error) {
      cache = { ...cache, error: controller.signal.aborted ? "timeout" : (error.updateCode || "offline"), retryAt: error.retryAt || 0 };
    } finally {
      window.clearTimeout(timeout);
      await persist();
      busy = false;
      button.disabled = false;
      render();
    }
  }
})();
