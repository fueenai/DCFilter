(function (root) {
  "use strict";

  const API_URL = "https://api.github.com/repos/fueenai/DCFilter/releases?per_page=100";
  const RELEASES_URL = "https://github.com/fueenai/DCFilter/releases";
  const CACHE_KEY = "dcfilter.releaseUpdates.v1";
  const CHECK_INTERVAL = 24 * 60 * 60 * 1000;
  const MANUAL_INTERVAL = 60 * 1000;
  const ERROR_CODES = new Set(["offline", "timeout", "rate-limit", "forbidden", "unavailable", "response"]);

  // Chrome extension versions use one to four numeric components, each <= 65535.
  function parseVersion(value) {
    if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(value)) return null;
    const parts = value.split(".").map(Number);
    if (parts.some((part) => part > 65535) || parts.every((part) => part === 0)) return null;
    return parts.concat(Array(4 - parts.length).fill(0));
  }

  function compareVersions(left, right) {
    const a = parseVersion(left), b = parseVersion(right);
    if (!a || !b) return null;
    for (let index = 0; index < a.length; index++) {
      if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
  }

  function normalizeRelease(value) {
    if (!value || typeof value !== "object" || typeof value.tag !== "string") return null;
    const version = value.tag.replace(/^v/, "");
    if (!parseVersion(version) || value.version !== version || typeof value.prerelease !== "boolean") return null;
    // Exact equality also rejects credentials, foreign repositories, query redirects and fragments.
    const url = `${RELEASES_URL}/tag/${value.tag}`;
    if (value.url !== url) return null;
    return { version, tag: value.tag, url, prerelease: value.prerelease };
  }

  function selectLatest(releases) {
    if (!Array.isArray(releases) || releases.length > 100) throw new Error("Invalid release list");
    let latest = null;
    for (const value of releases) {
      if (!value || typeof value !== "object" || value.draft !== false || typeof value.tag_name !== "string") continue;
      const release = normalizeRelease({
        version: value.tag_name.replace(/^v/, ""), tag: value.tag_name,
        url: value.html_url, prerelease: value.prerelease
      });
      if (!release) continue;
      const order = latest ? compareVersions(release.version, latest.version) : 1;
      if (order > 0 || (order === 0 && latest.prerelease && !release.prerelease)) latest = release;
    }
    return latest;
  }

  function normalizeCache(value, now) {
    const blank = { schema: 1, lastAttemptAt: 0, lastSuccessAt: 0, retryAt: 0, latest: null, error: "" };
    if (!value || value.schema !== 1) return blank;
    const timestamp = (stamp) => Number.isSafeInteger(stamp) && stamp > 0 && stamp <= now ? stamp : 0;
    const lastAttemptAt = timestamp(value.lastAttemptAt);
    const lastSuccessAt = timestamp(value.lastSuccessAt);
    const latest = normalizeRelease(value.latest);
    // A malformed cached link must not suppress a fresh check or appear as "up to date".
    if ((value.latest !== null && !latest) || lastSuccessAt > lastAttemptAt) return blank;
    const retryAt = Number.isSafeInteger(value.retryAt) && value.retryAt > now && value.retryAt <= now + CHECK_INTERVAL ? value.retryAt : 0;
    return { ...blank, lastAttemptAt, lastSuccessAt, retryAt, latest, error: ERROR_CODES.has(value.error) ? value.error : "" };
  }

  function shouldCheck(cache, now, manual) {
    if (cache.retryAt > now) return false;
    const interval = manual ? MANUAL_INTERVAL : CHECK_INTERVAL;
    return !cache.lastAttemptAt || now < cache.lastAttemptAt || now - cache.lastAttemptAt >= interval;
  }

  function describe(cache, installedVersion) {
    let message = "아직 업데이트를 확인하지 않았습니다.";
    let url = "";
    if (cache.lastSuccessAt) {
      if (!cache.latest) message = "설치 가능한 공개 버전을 찾지 못했습니다.";
      else {
        const order = compareVersions(cache.latest.version, installedVersion);
        if (order === 1) {
          message = `새 버전 ${cache.latest.version}${cache.latest.prerelease ? " (시험 버전)" : ""}이 있습니다. 설치 버전 ${installedVersion}.`;
          url = cache.latest.url;
        } else if (order === 0) message = `현재 ${installedVersion}이 공개된 최신 버전입니다.`;
        else if (order === -1) message = `설치 버전 ${installedVersion}이 공개 버전 ${cache.latest.version}보다 새 버전입니다.`;
        else message = "설치 버전 정보를 비교할 수 없습니다.";
      }
    }
    const errors = {
      offline: "연결하지 못했습니다. 인터넷 연결을 확인해 주세요.",
      timeout: "업데이트 확인 시간이 초과되었습니다.",
      "rate-limit": "GitHub 요청 한도에 도달했습니다. 잠시 후 다시 확인해 주세요.",
      forbidden: "GitHub가 요청을 거절했습니다. 잠시 후 다시 확인해 주세요.",
      unavailable: "GitHub 업데이트 정보를 가져오지 못했습니다.",
      response: "GitHub 응답을 확인할 수 없습니다. 잠시 후 다시 확인해 주세요."
    };
    if (cache.error) message = `${errors[cache.error]}${cache.lastSuccessAt ? ` 마지막 확인 결과: ${message}` : ""}`;
    return { message, url, label: cache.latest ? `v${cache.latest.version} 다운로드` : "새 버전 다운로드" };
  }

  const api = { API_URL, RELEASES_URL, CACHE_KEY, CHECK_INTERVAL, MANUAL_INTERVAL, parseVersion, compareVersions, normalizeRelease, selectLatest, normalizeCache, shouldCheck, describe };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DCFilterReleaseUpdates = Object.freeze(api);
})(typeof window === "undefined" ? globalThis : window);
