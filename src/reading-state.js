(function (root) {
  "use strict";

  const READ_PREFIX = "dcf.read.v1:";
  const RESET_KEY = "dcf.read.resetAt";
  const POSITION_KEY = "dcf.list-returns.v1";
  const HISTORY_TTL = 30 * 24 * 60 * 60 * 1000;
  const MAX_RECORDS = 3000;
  const POSITION_TTL = 12 * 60 * 60 * 1000;
  const MAX_POSITIONS = 20;
  const RECORD_KEY_RE = /^dcf\.read\.v1:(?:main|gallery|mgallery|mini|person):[a-z0-9_]{1,80}:[1-9]\d{0,15}$/;

  function parsePage(raw, base) {
    try {
      const url = new URL(raw, base || "https://gall.dcinside.com/");
      if (url.protocol !== "https:" || url.hostname !== "gall.dcinside.com") return null;
      const match = url.pathname.match(/^\/(?:(gallery|mgallery|mini|person)\/)?board\/(lists|view)\/?$/i);
      const gallery = (url.searchParams.get("id") || "").toLowerCase();
      if (!match || !/^[a-z0-9_]{1,80}$/.test(gallery)) return null;
      const scope = match[1] ? match[1].toLowerCase() : "main";
      const kind = match[2].toLowerCase();
      const no = (url.searchParams.get("no") || "").replace(/^0+(?=\d)/, "");
      if (kind === "view" && !/^[1-9]\d{0,15}$/.test(no)) return null;
      return { scope, gallery, kind, no: kind === "view" ? no : "", key: kind === "view" ? `${READ_PREFIX}${scope}:${gallery}:${no}` : "" };
    } catch (_error) {
      return null;
    }
  }

  function listKey(raw) {
    const page = parsePage(raw);
    if (!page || page.kind !== "lists") return "";
    const url = new URL(raw, "https://gall.dcinside.com/");
    url.hash = "";
    url.searchParams.delete("no");
    url.searchParams.set("id", page.gallery);
    if (!url.searchParams.has("page")) url.searchParams.set("page", "1");
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/?$/, "/");
    return url.href;
  }

  function normalizeRecord(value, now, resetAt) {
    if (!value || typeof value !== "object") return null;
    const visitedAt = value.visitedAt;
    if (!Number.isSafeInteger(visitedAt) || visitedAt <= (resetAt || 0) || visitedAt <= now - HISTORY_TTL || visitedAt > now + 60000) return null;
    const comments = value.comments;
    if (comments !== null && (!Number.isSafeInteger(comments) || comments < 0 || comments > 10000000)) return null;
    return { visitedAt, comments };
  }

  function selectHistory(raw, now) {
    const source = raw && typeof raw === "object" ? raw : {};
    const time = now === undefined ? Date.now() : now;
    const resetAt = Number.isSafeInteger(source[RESET_KEY]) ? source[RESET_KEY] : 0;
    const valid = [];
    const removeKeys = [];
    Object.entries(source).forEach(([key, value]) => {
      if (!key.startsWith(READ_PREFIX)) return;
      const record = RECORD_KEY_RE.test(key) ? normalizeRecord(value, time, resetAt) : null;
      if (record) valid.push([key, record]);
      else removeKeys.push(key);
    });
    valid.sort((a, b) => b[1].visitedAt - a[1].visitedAt);
    removeKeys.push(...valid.slice(MAX_RECORDS).map(([key]) => key));
    return { records: new Map(valid.slice(0, MAX_RECORDS)), resetAt, removeKeys };
  }

  function commentDelta(record, current) {
    if (!record || !Number.isSafeInteger(record.comments) || !Number.isSafeInteger(current) || current < 0) return 0;
    return Math.max(0, current - record.comments);
  }

  function normalizePosition(value, now) {
    if (!value || typeof value !== "object") return null;
    const url = listKey(value.url);
    const page = parsePage(url);
    const time = now === undefined ? Date.now() : now;
    if (!page || !RECORD_KEY_RE.test(value.rowKey || "") || !value.rowKey.startsWith(`${READ_PREFIX}${page.scope}:${page.gallery}:`)) return null;
    if (!Number.isSafeInteger(value.savedAt) || value.savedAt < time - POSITION_TTL || value.savedAt > time + 60000) return null;
    if (![value.x, value.y, value.rowTop].every(Number.isFinite)) return null;
    if (value.x < 0 || value.y < 0 || value.x > 1000000 || value.y > 50000000 || Math.abs(value.rowTop) > 50000000) return null;
    return { url, rowKey: value.rowKey, x: value.x, y: value.y, rowTop: value.rowTop, savedAt: value.savedAt, pending: value.pending === true };
  }

  function selectPositions(value, now) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value.map((entry) => normalizePosition(entry, now)).filter(Boolean)
      .sort((a, b) => b.savedAt - a.savedAt).filter((entry) => {
        if (seen.has(entry.url)) return false;
        seen.add(entry.url);
        return true;
      }).slice(0, MAX_POSITIONS);
  }

  const api = Object.freeze({ READ_PREFIX, RESET_KEY, POSITION_KEY, HISTORY_TTL, MAX_RECORDS, POSITION_TTL, MAX_POSITIONS, parsePage, listKey, normalizeRecord, selectHistory, commentDelta, normalizePosition, selectPositions });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DCFilterReadingState = api;
})(typeof window !== "undefined" ? window : globalThis);
