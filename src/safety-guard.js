(function () {
  "use strict";

  // This runs at document_start. safety.css covers unknown media before any
  // asynchronous settings read or model request has had a chance to finish.
  const MEDIA_SELECTOR = [
    ".write_div :is(img, video, iframe, object, embed, svg)",
    ".writing_view_box :is(img, video, iframe, object, embed, svg)",
    ".view_content :is(img, video, iframe, object, embed, svg)",
    ".appending_cap_box :is(img, video)",
    ".comment_dccon img", ".comment_wrap .usertxt img",
    ".comment_wrap .comment_txt :is(img, video, iframe)",
    ".gall_list .gall_tit img", ".gall_list .thumb img",
    ".dcf-image-preview img"
  ].join(",");
  const REQUEST = "dcf:safety:request";
  const RESPONSE = "dcf:safety:response";
  const records = new Map();
  const cache = new Map();
  const queue = [];
  const storage = window.DCFilterStorage;
  const root = document.documentElement;
  let settings = storage.DEFAULTS;
  let ready = false;
  let active = true;
  let running = false;
  let epoch = 0;
  let serial = 0;
  let frame = null;
  let frameReady = null;
  let cancelFrameLoad = null;
  let pending = null;
  let layoutFrame = 0;
  let settingsError = false;
  const initialChanges = {};
  const workerUrl = chrome.runtime.getURL("src/safety-worker.html");
  const workerOrigin = new URL(workerUrl).origin;

  const observer = new MutationObserver((changes) => {
    let relevant = false;
    for (const change of changes) {
      if (change.target instanceof Element && change.target.closest("[data-dcf-safety-ui]")) continue;
      if (change.type === "attributes") {
        const target = change.target;
        if (change.attributeName === "style" || change.attributeName === "class") {
          if (change.attributeName === "class") discover(target);
          if (target.matches(".dcf-image-preview") || target.closest(".writing_view_box, .write_div, .view_content, .comment_wrap")) relevant = true;
          continue;
        }
        relevant = true;
        if (records.has(target)) reset(records.get(target));
        if (target.tagName === "SOURCE") {
          const media = target.closest("video") || target.closest("picture")?.querySelector("img");
          if (records.has(media)) reset(records.get(media));
        }
      }
      if (change.type === "childList" && change.target instanceof Element && change.target.matches("picture, video")) {
        const media = change.target.matches("video") ? change.target : change.target.querySelector("img");
        if (records.has(media)) reset(records.get(media));
      }
      for (const node of change.addedNodes || []) {
        if (!(node instanceof Element) || node.closest("[data-dcf-safety-ui]")) continue;
        relevant = true;
        discover(node);
        const image = node.closest("picture")?.querySelector("img");
        if (records.has(image)) reset(records.get(image));
      }
      if (Array.from(change.removedNodes || []).some((node) => node instanceof Element && !node.matches("[data-dcf-safety-ui]"))) relevant = true;
    }
    if (!relevant) return;
    prune();
    scheduleLayout();
    pump();
  });
  observer.observe(root, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["src", "srcset", "sizes", "poster", "data", "media", "type", "style", "class"]
  });

  // load also catches responsive currentSrc changes without a src mutation.
  document.addEventListener("load", (event) => {
    const record = records.get(event.target);
    if (!record) return;
    if (record.source !== sourceOf(record.media)) reset(record);
    enqueue(record);
    scheduleLayout();
  }, true);
  document.addEventListener("error", (event) => {
    const record = records.get(event.target);
    if (!active || !record) return;
    record.generation += 1;
    settle(record, { status: "uncertain", reason: "이미지를 불러오지 못해 가렸습니다." });
  }, true);
  document.addEventListener("loadeddata", (event) => {
    const record = records.get(event.target);
    if (record && record.source !== sourceOf(record.media)) reset(record);
  }, true);
  document.addEventListener("play", (event) => {
    const record = records.get(event.target);
    if (active && record && !record.revealed && (record.status !== "safe" || record.userHidden)) record.media.pause();
  }, true);
  window.addEventListener("resize", refreshLayout, { passive: true });
  document.addEventListener("scroll", refreshLayout, { passive: true, capture: true });
  document.addEventListener("visibilitychange", refreshLayout);
  window.addEventListener("pageshow", refreshLayout);
  document.addEventListener("dcf:bot-comments-layout", refreshLayout);
  window.addEventListener("message", onWorkerMessage);
  document.addEventListener("DOMContentLoaded", () => { discover(root); refreshLayout(); }, { once: true });
  discover(root);

  storage.loadSettings().then((initial) => configure(storage.normalizeSettings({ ...initial, ...initialChanges }))).catch(() => {
    const latest = storage.normalizeSettings({ ...settings, ...initialChanges });
    if (!latest.enabled || !latest.imageSafety) { configure(latest); return; }
    settings = latest;
    settingsError = true;
    ready = true;
    root.classList.add("dcf-safety-on", "dcf-safety-ready");
    for (const record of records.values()) {
      record.settingsError = true;
      settle(record, { status: "uncertain", reason: "설정을 읽지 못해 가렸습니다." });
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (!ready) {
      for (const [key, value] of Object.entries(changes)) initialChanges[key] = value.newValue;
      return;
    }
    const next = { ...settings };
    for (const [key, value] of Object.entries(changes)) next[key] = value.newValue;
    configure(storage.normalizeSettings(next));
  });

  function configure(next) {
    const wasActive = active;
    const classifierChanged = settings.imageSafetySexual !== next.imageSafetySexual || settings.imageSafetySensitivity !== next.imageSafetySensitivity;
    settings = next;
    settingsError = false;
    active = Boolean(settings.enabled && settings.imageSafety);
    ready = true;
    if (classifierChanged) {
      epoch += 1;
      queue.length = 0;
      for (const record of records.values()) record.queued = false;
      stopWorker();
    }
    // Add the chosen state before releasing the initial CSS guard.
    root.classList.toggle("dcf-safety-on", active);
    root.classList.add("dcf-safety-ready");
    if (!active) {
      epoch += 1;
      queue.length = 0;
      for (const record of records.values()) {
        record.queued = false;
        record.media.removeAttribute("data-dcf-safety-state");
        removeOverlay(record);
      }
      stopWorker();
    } else {
      discover(root);
      for (const record of records.values()) {
        if (!wasActive || classifierChanged || record.status === "uncertain" && record.settingsError) reset(record);
        else { applyRecord(record); enqueue(record); }
      }
    }
    refreshLayout();
  }

  function discover(scope) {
    if (!active) return;
    if (scope.matches?.(MEDIA_SELECTOR)) track(scope);
    scope.querySelectorAll?.(MEDIA_SELECTOR).forEach(track);
  }

  function track(media) {
    if (records.has(media)) return;
    const record = { media, generation: 0, source: "", status: "pending", reason: "", revealed: false, userHidden: false, queued: false, overlay: null };
    records.set(media, record);
    reset(record);
  }

  function sourceOf(media) {
    if (media.tagName === "IMG") return media.currentSrc || media.src || "";
    return media.currentSrc || media.src || media.getAttribute("data") || media.getAttribute("poster") || "";
  }

  function reset(record) {
    record.generation += 1;
    record.source = sourceOf(record.media);
    record.status = "pending";
    record.analysisComplete = false;
    record.reason = "로컬 AI로 확인 중입니다.";
    record.revealed = false;
    record.userHidden = false;
    record.settingsError = settingsError;
    if (!active) return;
    if (settingsError) {
      record.status = "uncertain";
      record.reason = "설정을 읽지 못해 가렸습니다.";
    }
    applyRecord(record);
    enqueue(record);
  }

  function enqueue(record) {
    if (!active || !ready || settingsError || record.status !== "pending" || record.queued || !record.media.isConnected) return;
    if (document.visibilityState === "hidden") return;
    // currentSrc can still point to the previous resource just after a src or
    // picture/source change. Keep the cover until the replacement has loaded.
    if (record.media.tagName === "IMG" && !record.media.complete) return;
    const rect = record.media.getBoundingClientRect();
    if (rect.bottom < -300 || rect.top > innerHeight + 600) return;
    record.queued = true;
    queue.push(record);
    pump();
  }

  async function pump() {
    if (running || !active || !ready || settingsError) return;
    running = true;
    try {
      while (queue.length && active && document.visibilityState !== "hidden") {
        const record = queue.shift();
        record.queued = false;
        if (!record.media.isConnected || records.get(record.media) !== record || record.status !== "pending") continue;
        if (record.media.tagName === "IMG" && !record.media.complete) continue;
        if (record.source !== sourceOf(record.media)) { reset(record); continue; }
        const generation = record.generation;
        const taskEpoch = epoch;
        const source = record.source;
        const cacheKey = `${settings.imageSafetySexual}:${settings.imageSafetySensitivity}:${source}`;
        let result;
        if (record.media.tagName !== "IMG") {
          result = { status: "uncertain", reason: "영상·외부 콘텐츠는 자동 검사하지 않아 가렸습니다." };
        } else if (!source || /\.(?:gif|svg)(?:[?#]|$)/i.test(source)) {
          result = { status: "uncertain", reason: "움짤·벡터 이미지 또는 출처를 확인할 수 없어 가렸습니다." };
        } else {
          try {
            result = cache.get(cacheKey) || await classify(source);
            if (taskEpoch === epoch && !cache.has(cacheKey)) {
              if (cache.size >= 180) cache.delete(cache.keys().next().value);
              cache.set(cacheKey, result);
            }
          } catch (_error) {
            result = { status: "uncertain", reason: "검사에 실패해 가렸습니다. 직접 볼 수 있습니다." };
          }
        }
        if (!active || taskEpoch !== epoch || records.get(record.media) !== record || generation !== record.generation || source !== sourceOf(record.media)) continue;
        settle(record, result);
      }
    } finally { running = false; }
  }

  function settle(record, result) {
    const status = result && ["safe", "blocked", "uncertain"].includes(result.status) ? result.status : "uncertain";
    record.status = status;
    record.analysisComplete = result?.status === status && result?.analysisComplete === true;
    record.reason = typeof result?.reason === "string" ? result.reason.slice(0, 160) : "판단하지 못해 가렸습니다.";
    applyRecord(record);
  }

  function applyRecord(record) {
    if (!active) return;
    const shown = record.revealed || automaticallyShown(record) && !record.userHidden;
    record.media.dataset.dcfSafetyState = shown ? "visible" : "covered";
    if (!shown && record.media.tagName === "VIDEO") record.media.pause();
    if (shown && !record.revealed) removeOverlay(record);
    else updateOverlay(record);
    scheduleLayout();
  }

  function automaticallyShown(record) {
    return record.status === "safe" ||
      record.media.tagName === "IMG" && record.status === "uncertain" &&
      record.analysisComplete && !settings.imageSafetyHideUncertain;
  }

  function updateOverlay(record) {
    if (!document.body) return;
    const preview = Boolean(record.media.closest(".dcf-image-preview"));
    if (!record.overlay) {
      const node = document.createElement("div");
      node.className = "dcf-safety-cover";
      node.dataset.dcfOwned = "1";
      node.dataset.dcfSafetyUi = "1";
      record.overlay = node;
      document.body.appendChild(node);
    }
    const node = record.overlay;
    node.classList.toggle("dcf-safety-preview", preview);
    node.classList.toggle("dcf-safety-revealed", record.revealed);
    node.replaceChildren();
    if (!record.revealed) {
      const label = document.createElement("strong");
      label.textContent = record.userHidden ? "이미지 가림" : record.status === "pending" ? "이미지 검사 중" : record.status === "blocked" ? "유해 이미지 의심 · 가림" : "확인할 수 없어 가림";
      const detail = document.createElement("small");
      detail.textContent = record.status === "pending" ? "처음 검사할 때 잠시 걸릴 수 있습니다." : record.reason;
      node.append(label, detail);
    }
    if (preview) {
      const detail = document.createElement("small");
      detail.textContent = "글을 열어 직접 확인할 수 있습니다.";
      node.append(detail);
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = record.revealed ? "다시 가리기" : "이번만 보기";
      button.addEventListener("click", (event) => {
        event.preventDefault(); event.stopPropagation();
        record.revealed = !record.revealed;
        record.userHidden = !record.revealed;
        applyRecord(record);
        record.overlay?.querySelector("button")?.focus({ preventScroll: true });
      });
      node.append(button);
    }
  }

  function removeOverlay(record) { record.overlay?.remove(); record.overlay = null; }
  function prune() {
    for (const [media, record] of records) {
      if (!media.isConnected || !media.matches(MEDIA_SELECTOR)) {
        record.generation += 1;
        media.removeAttribute("data-dcf-safety-state");
        removeOverlay(record);
        records.delete(media);
      }
    }
  }
  function refreshLayout() {
    if (!active) return;
    for (const record of records.values()) {
      if (record.source !== sourceOf(record.media)) reset(record);
      enqueue(record);
    }
    scheduleLayout();
    pump();
  }
  function scheduleLayout() {
    if (!layoutFrame) layoutFrame = requestAnimationFrame(positionOverlays);
  }
  function positionOverlays() {
    layoutFrame = 0;
    if (!active) return;
    for (const record of records.values()) {
      if (!record.overlay && (!automaticallyShown(record) || record.revealed || record.userHidden)) updateOverlay(record);
      const node = record.overlay;
      if (!node) continue;
      const box = record.media.getBoundingClientRect();
      const hiddenElsewhere = settings.hideImages && record.media.tagName === "IMG" || Boolean(record.media.closest(".dcf-image-fingerprint-blocked")) || settings.signatureImageBlock && (Boolean(record.media.closest("#zzbang_div")) || record.media.matches("#auto_zzal_img, [data-azno]:not([data-fileno]), [src*='/viewimage.php'][src*='no=29bcc427']:not([data-fileno])"));
      node.hidden = hiddenElsewhere || !record.media.isConnected || box.width < 1 || box.height < 1 || box.bottom < 0 || box.top > innerHeight;
      if (node.hidden) continue;
      node.classList.toggle("dcf-safety-small", box.width < 180 || box.height < 95);
      node.style.left = `${box.left}px`;
      const visibleTop = Math.max(0, box.top);
      const visibleBottom = Math.min(innerHeight, box.bottom);
      node.style.top = `${visibleTop}px`;
      node.style.width = `${box.width}px`;
      node.style.height = `${Math.max(0, visibleBottom - visibleTop)}px`;
    }
  }

  function ensureWorker() {
    if (frame?.isConnected && frameReady) return frameReady;
    const next = document.createElement("iframe");
    next.hidden = true;
    next.dataset.dcfOwned = "1";
    next.dataset.dcfSafetyUi = "1";
    next.setAttribute("aria-hidden", "true");
    next.tabIndex = -1;
    next.src = workerUrl;
    frame = next;
    frameReady = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("로컬 검사 준비 시간 초과")), 20000);
      cancelFrameLoad = () => { clearTimeout(timeout); reject(new Error("검사 취소")); };
      next.addEventListener("load", () => { clearTimeout(timeout); cancelFrameLoad = null; resolve(next); }, { once: true });
      next.addEventListener("error", () => { clearTimeout(timeout); cancelFrameLoad = null; reject(new Error("로컬 검사 준비 실패")); }, { once: true });
      (document.body || root).appendChild(next);
    }).catch((error) => {
      if (frame === next) { next.remove(); frame = null; frameReady = null; }
      throw error;
    });
    return frameReady;
  }

  async function classify(url) {
    const taskEpoch = epoch;
    const worker = await ensureWorker();
    if (!active || taskEpoch !== epoch) throw new Error("검사 취소");
    const requestId = `safety-${Date.now().toString(36)}-${++serial}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending = null;
        // A timed-out inference must not keep running beside the next one.
        worker.remove(); frame = null; frameReady = null;
        reject(new Error("검사 시간 초과"));
      }, 120000);
      pending = { requestId, resolve, reject, timeout };
      worker.contentWindow.postMessage({ type: REQUEST, requestId, url, referrer: location.href, sexual: settings.imageSafetySexual !== false, sensitivity: settings.imageSafetySensitivity === "balanced" ? "balanced" : "strict" }, workerOrigin);
    });
  }

  function onWorkerMessage(event) {
    if (event.origin !== workerOrigin || event.source !== frame?.contentWindow || !pending) return;
    const message = event.data;
    if (message?.type !== RESPONSE || message.requestId !== pending.requestId) return;
    const request = pending;
    pending = null;
    clearTimeout(request.timeout);
    if (message.ok) request.resolve(message.result);
    else request.reject(new Error("로컬 검사 실패"));
  }
  function stopWorker() {
    if (cancelFrameLoad) { cancelFrameLoad(); cancelFrameLoad = null; }
    if (pending) { clearTimeout(pending.timeout); pending.reject(new Error("검사 취소")); pending = null; }
    frame?.remove(); frame = null; frameReady = null;
  }
})();
