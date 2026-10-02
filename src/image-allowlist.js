(function (root) {
  "use strict";

  // Store only content hashes, never image bytes, URLs or browsing history.
  // Separate keys make additions from different tabs independent.
  const PREFIX = "dcf:image-allowed:v1:";
  const MAX_ENTRIES = 500;
  const validDigest = (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest);
  const keyFor = (digest) => {
    if (!validDigest(digest)) throw new TypeError("이미지 확인 정보가 올바르지 않습니다.");
    return PREFIX + digest;
  };
  function entries(values) {
    return Object.entries(values).flatMap(([key, value]) => {
      const digest = key.slice(PREFIX.length);
      return key.startsWith(PREFIX) && validDigest(digest) && Number.isSafeInteger(value?.addedAt) && value.addedAt > 0
        ? [{ digest, addedAt: value.addedAt }] : [];
    }).sort((a, b) => b.addedAt - a.addedAt || a.digest.localeCompare(b.digest));
  }
  async function list() { return entries(await chrome.storage.local.get(null)); }
  async function has(digest) {
    const key = keyFor(digest);
    return entries(await chrome.storage.local.get(key)).length === 1;
  }
  async function add(digest) {
    await chrome.storage.local.set({ [keyFor(digest)]: { addedAt: Date.now() } });
    const records = await list();
    if (records.length > MAX_ENTRIES) await chrome.storage.local.remove(records.slice(MAX_ENTRIES).map(({ digest: item }) => keyFor(item)));
    return has(digest);
  }
  async function remove(digest) { await chrome.storage.local.remove(keyFor(digest)); }
  async function clear() {
    const values = await chrome.storage.local.get(null);
    const keys = Object.keys(values).filter((key) => key.startsWith(PREFIX));
    if (keys.length) await chrome.storage.local.remove(keys);
  }
  function isChange(changes) { return Object.keys(changes).some((key) => key.startsWith(PREFIX)); }
  root.DCFImageAllowlist = Object.freeze({ PREFIX, MAX_ENTRIES, validDigest, list, has, add, remove, clear, isChange });
})(typeof globalThis === "object" ? globalThis : window);
