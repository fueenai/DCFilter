(function () {
  "use strict";

  const model = window.DCFilterReadingState;
  const ROWS = "tbody.listwrap2 tr.ub-content, tbody.listwrap2 tr.us-post, tbody.listwrap2 tr[data-no]";
  const state = {
    settings: {}, ready: false, initialized: false, records: new Map(), resetAt: 0,
    load: null, changesDuringLoad: [], timer: 0, observer: null, observed: [],
    recordedKey: "", recordedComments: undefined, suppressVisit: false,
    restoring: null, restoreTimer: 0, highlightTimer: 0, pendingReturn: null, leftDocument: false,
    private: Boolean(chrome.extension && chrome.extension.inIncognitoContext)
  };

  function init(settings) {
    if (state.initialized) return Promise.resolve();
    state.initialized = true;
    state.settings = settings;
    document.addEventListener("click", captureNavigation, true);
    document.addEventListener("auxclick", captureNavigation, true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("wheel", cancelRestore, { passive: true });
    window.addEventListener("touchstart", cancelRestore, { passive: true });
    window.addEventListener("pointerdown", cancelRestore, { passive: true });
    window.addEventListener("keydown", (event) => {
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " ", "j", "k", "J", "K"].includes(event.key)) cancelRestore();
    }, true);
    chrome.storage.onChanged.addListener(onStorageChanged);
    return reloadHistory().then(() => {
      state.ready = true;
      enhance();
      restoreSavedList();
    });
  }

  function configure(settings) {
    const wasReading = canRead();
    state.settings = settings;
    if (!settings.enabled || !settings.restoreListPosition) {
      cancelRestore();
      clearHighlight();
      if (state.pendingReturn) writePosition(Object.assign({}, state.pendingReturn, { pending: false }));
      state.pendingReturn = null;
    }
    if (!canRead()) clearReadMarkers();
    else if (!wasReading) {
      state.recordedKey = "";
      state.recordedComments = undefined;
    }
    if (state.ready) enhance();
  }

  function canRead() {
    return state.settings.enabled && state.settings.showReadPosts && !state.private;
  }

  function currentPage() {
    return model.parsePage(location.href);
  }

  function warn(error) {
    console.warn("[DCFilter] 읽음 기록 처리 실패", error);
  }

  function reloadHistory() {
    if (state.load) return state.load;
    if (state.private) return Promise.resolve();
    state.changesDuringLoad = [];
    state.load = chrome.storage.local.get(null).then((raw) => {
      const snapshot = model.selectHistory(raw);
      if (state.ready && snapshot.resetAt > state.resetAt) state.suppressVisit = true;
      state.records = snapshot.records;
      state.resetAt = snapshot.resetAt;
      const buffered = state.changesDuringLoad.splice(0);
      const changedKeys = new Set(buffered.flatMap((changes) => Object.keys(changes)));
      buffered.forEach(applyHistoryChanges);
      const obsolete = snapshot.removeKeys.filter((key) => !changedKeys.has(key));
      if (obsolete.length) chrome.storage.local.remove(obsolete).catch(warn);
    }).catch(warn).finally(() => { state.load = null; });
    return state.load;
  }

  function applyHistoryChanges(changes) {
    if (changes[model.RESET_KEY]) {
      state.resetAt = Number(changes[model.RESET_KEY].newValue) || 0;
      state.suppressVisit = true;
      state.records.forEach((record, key) => {
        if (record.visitedAt <= state.resetAt) state.records.delete(key);
      });
    }
    Object.entries(changes).forEach(([key, change]) => {
      if (!key.startsWith(model.READ_PREFIX)) return;
      const record = model.normalizeRecord(change.newValue, Date.now(), state.resetAt);
      if (record) state.records.set(key, record);
      else state.records.delete(key);
    });
  }

  function onStorageChanged(changes, area) {
    if (area !== "local" || state.private) return;
    if (!Object.keys(changes).some((key) => key === model.RESET_KEY || key.startsWith(model.READ_PREFIX))) return;
    if (state.load) state.changesDuringLoad.push(changes);
    applyHistoryChanges(changes);
    scheduleEnhance();
    if (state.records.size > model.MAX_RECORDS) reloadHistory();
  }

  function numberFromText(value) {
    const match = String(value || "").replace(/,/g, "").match(/\d+/);
    return match ? Number(match[0]) : null;
  }

  function currentComments() {
    const count = document.querySelector(".gallview_head .gall_comment, .view_head .gall_comment");
    return count ? numberFromText(count.textContent) : null;
  }

  function recordCurrentPost() {
    if (!state.ready || !canRead() || state.suppressVisit || document.visibilityState !== "visible") return;
    const page = currentPage();
    if (!page || page.kind !== "view") return;
    // 미리보기용으로 파싱한 HTML이나 삭제/오류 페이지는 방문 기록으로 남기지 않는다.
    if (!document.querySelector(".gallview_head .title_subject, .view_head .title_subject") || !document.querySelector(".writing_view_box")) return;
    const comments = currentComments();
    if (state.recordedKey === page.key && state.recordedComments === comments) return;
    state.recordedKey = page.key;
    state.recordedComments = comments;
    const record = { visitedAt: Date.now(), comments };
    if (record.visitedAt <= state.resetAt) return;
    state.records.set(page.key, record);
    // 게시글별 키로 저장해야 동시에 연 서로 다른 탭의 기록이 덮어써지지 않는다.
    chrome.storage.local.set({ [page.key]: record }).catch((error) => {
      state.recordedKey = "";
      warn(error);
    });
  }

  function rowData(row) {
    if (!/^\d+$/.test((row.querySelector("td.gall_num")?.textContent || "").trim())) return null;
    const link = row.querySelector("td.gall_tit a[href]");
    const page = link && model.parsePage(link.href);
    return page && page.kind === "view" ? { link, page, row } : null;
  }

  function renderReadRows() {
    if (!canRead()) return;
    document.querySelectorAll(ROWS).forEach((row) => {
      const data = rowData(row);
      const record = data && model.normalizeRecord(state.records.get(data.page.key), Date.now(), state.resetAt);
      const existing = row.querySelector(".dcf-reading-status");
      if (!data || !record) {
        row.classList.remove("dcf-read-row");
        row.querySelectorAll(".dcf-read-link").forEach((link) => link.classList.remove("dcf-read-link"));
        if (existing) existing.remove();
        return;
      }
      row.classList.add("dcf-read-row");
      data.link.classList.add("dcf-read-link");
      const reply = row.querySelector(".reply_num");
      const comments = reply ? numberFromText(reply.textContent) : 0;
      const delta = state.settings.showCommentDelta ? model.commentDelta(record, comments) : 0;
      const indicator = existing || document.createElement("span");
      if (!existing) {
        indicator.dataset.dcfOwned = "1";
        indicator.className = "dcf-reading-status";
        const label = document.createElement("span");
        label.className = "dcf-read-label";
        label.textContent = "읽음";
        indicator.appendChild(label);
        row.querySelector("td.gall_tit").appendChild(indicator);
      }
      indicator.title = `마지막 열람 ${new Date(record.visitedAt).toLocaleString("ko-KR")}`;
      let badge = indicator.querySelector(".dcf-comment-delta");
      if (delta > 0) {
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "dcf-comment-delta";
          indicator.appendChild(badge);
        }
        const text = `+${delta}`;
        if (badge.textContent !== text) badge.textContent = text;
        badge.title = `지난 열람 대비 댓글 ${delta}개 증가 (${record.comments} → ${comments}). 삭제된 댓글은 증가분에 포함되지 않습니다.`;
        badge.setAttribute("aria-label", `지난 열람 대비 댓글 ${delta}개 증가`);
      } else if (badge) badge.remove();
    });
  }

  function clearReadMarkers() {
    document.querySelectorAll(".dcf-reading-status").forEach((node) => node.remove());
    document.querySelectorAll(".dcf-read-row").forEach((row) => row.classList.remove("dcf-read-row"));
    document.querySelectorAll(".dcf-read-link").forEach((link) => link.classList.remove("dcf-read-link"));
  }

  function scheduleEnhance() {
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(enhance, 80);
  }

  function observeCounts() {
    const targets = Array.from(document.querySelectorAll("tbody.listwrap2, .gallview_head"));
    if (targets.length === state.observed.length && targets.every((node, index) => node === state.observed[index])) return;
    if (state.observer) state.observer.disconnect();
    state.observed = targets;
    state.observer = new MutationObserver((changes) => {
      if (changes.some((change) => {
        const target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
        if (target && target.closest("[data-dcf-owned]")) return false;
        if (change.type === "characterData") return true;
        return [...change.addedNodes, ...change.removedNodes].some((node) => node.nodeType !== 1 || !node.matches("[data-dcf-owned]"));
      })) scheduleEnhance();
    });
    targets.forEach((node) => state.observer.observe(node, { childList: true, characterData: true, subtree: true }));
  }

  function enhance() {
    if (!state.ready) return;
    if (!state.settings.enabled) {
      clearReadMarkers();
      if (state.observer) state.observer.disconnect();
      state.observed = [];
      return;
    }
    recordCurrentPost();
    renderReadRows();
    observeCounts();
  }

  function readPositions() {
    try {
      return model.selectPositions(JSON.parse(sessionStorage.getItem(model.POSITION_KEY) || "[]"));
    } catch (_error) {
      return [];
    }
  }

  function writePosition(position) {
    const entry = model.normalizePosition(position);
    if (!entry) return;
    try {
      sessionStorage.setItem(model.POSITION_KEY, JSON.stringify(model.selectPositions([entry, ...readPositions().filter((item) => item.url !== entry.url)])));
    } catch (_error) {
      // 사이트 저장소가 비활성화되어 있으면 브라우저 기본 뒤로가기를 그대로 쓴다.
    }
  }

  function findRow(key) {
    return Array.from(document.querySelectorAll(ROWS)).find((row) => rowData(row)?.page.key === key) || null;
  }

  function rememberLink(link) {
    if (!state.settings.enabled || !state.settings.restoreListPosition) return;
    const list = currentPage();
    const target = link && model.parsePage(link.href);
    if (!list || list.kind !== "lists" || !target || target.kind !== "view" || list.gallery !== target.gallery || list.scope !== target.scope) return;
    const row = link.closest("tr");
    if (!row || !rowData(row)) return;
    const position = {
      url: model.listKey(location.href), rowKey: target.key,
      x: window.scrollX, y: window.scrollY, rowTop: row.getBoundingClientRect().top,
      savedAt: Date.now(), pending: true
    };
    state.pendingReturn = position;
    writePosition(position);
  }

  function captureNavigation(event) {
    if (event.button !== 0 && event.button !== 1) return;
    const link = event.target instanceof Element && event.target.closest("td.gall_tit a[href]");
    if (link) rememberLink(link);
  }

  function onPageHide() {
    state.leftDocument = true;
    if (!state.settings.enabled || !state.settings.restoreListPosition) return;
    const pending = state.pendingReturn;
    if (pending && pending.pending && pending.url === model.listKey(location.href)) {
      const row = findRow(pending.rowKey);
      writePosition(Object.assign({}, pending, { x: window.scrollX, y: window.scrollY, rowTop: row ? row.getBoundingClientRect().top : pending.rowTop }));
    }
    window.clearTimeout(state.restoreTimer);
    state.restoring = null;
  }

  function restoreSavedList(fromHistory) {
    if (!state.ready || !state.settings.enabled || !state.settings.restoreListPosition || state.restoring || document.visibilityState !== "visible" || location.hash) return;
    const url = model.listKey(location.href);
    if (!url) return;
    const position = readPositions().find((item) => item.url === url && item.pending);
    if (!position) return;
    const referrer = model.parsePage(document.referrer);
    const navigation = performance.getEntriesByType("navigation")[0];
    const fromPost = referrer && referrer.kind === "view" && referrer.key === position.rowKey;
    if (!fromHistory && navigation?.type !== "back_forward" && !fromPost) return;
    startRestore(position);
  }

  function startRestore(position) {
    state.restoring = { position, startedAt: Date.now() };
    const tick = () => {
      const active = state.restoring;
      if (!active || !state.settings.enabled || !state.settings.restoreListPosition) return;
      const row = findRow(position.rowKey);
      const visibleRow = row && row.getBoundingClientRect().height > 0;
      const top = visibleRow ? window.scrollY + row.getBoundingClientRect().top - position.rowTop : position.y;
      const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const y = Math.max(0, Math.min(top, maxY));
      if (Math.abs(window.scrollY - y) > 2 || Math.abs(window.scrollX - position.x) > 2) window.scrollTo({ top: y, left: position.x, behavior: "instant" });
      if (Date.now() - active.startedAt >= 1200) finishRestore(position);
      else state.restoreTimer = window.setTimeout(tick, 120);
    };
    state.restoreTimer = window.setTimeout(tick, 0);
  }

  function finishRestore(position) {
    window.clearTimeout(state.restoreTimer);
    state.restoring = null;
    state.pendingReturn = null;
    writePosition(Object.assign({}, position, { pending: false }));
    highlightRow(position.rowKey);
  }

  function cancelRestore() {
    if (!state.restoring) return;
    const position = state.restoring.position;
    window.clearTimeout(state.restoreTimer);
    state.restoring = null;
    state.pendingReturn = null;
    writePosition(Object.assign({}, position, { pending: false }));
  }

  function clearHighlight() {
    window.clearTimeout(state.highlightTimer);
    document.querySelectorAll(".dcf-return-row").forEach((row) => row.classList.remove("dcf-return-row"));
  }

  function highlightRow(key) {
    clearHighlight();
    const row = findRow(key);
    if (!row || row.getBoundingClientRect().height <= 0) return;
    row.classList.add("dcf-return-row");
    state.highlightTimer = window.setTimeout(clearHighlight, 3200);
  }

  function onVisibilityChange() {
    if (document.visibilityState !== "visible") return;
    reloadHistory().then(() => {
      enhance();
      // 새 탭에서 읽고 원래 목록으로 돌아오면 스크롤을 움직이지 않고 행만 강조한다.
      const pending = state.pendingReturn;
      const record = pending && state.records.get(pending.rowKey);
      if (!state.leftDocument && !state.restoring && state.settings.enabled && state.settings.restoreListPosition && pending && record && record.visitedAt >= pending.savedAt) finishRestore(pending);
    });
  }

  function onPageShow(event) {
    if (!event.persisted) return;
    reloadHistory().then(() => {
      enhance();
      restoreSavedList(true);
      state.leftDocument = false;
    });
  }

  window.DCFilterReading = Object.freeze({ init, configure, enhance, rememberLink });
})();
