(function () {
  "use strict";

  const DEFAULTS = Object.freeze({
    enabled: true,
    autoRefresh: false,
    refreshInterval: 5,
    openInNewTab: true,
    showReadPosts: true,
    showCommentDelta: true,
    restoreListPosition: true,
    showFullTime: true,
    showNonFixedId: true,
    keyboardNavigation: true,
    showIpInfo: true,
    blockCarrierIp: false,
    hideDcBlockedPosts: true,
    hideRealtimeBest: true,
    hideDcMedia: true,
    hideConceptPanels: true,
    hideIssueRows: true,
    hideGnbPromo: true,
    expandCleanLayout: true,
    imagePreview: true,
    previewDelay: 350,
    previewMaxImages: 3,
    signatureImageBlock: true,
    imageSafety: true,
    imageSafetySexual: true,
    imageSafetyHideUncertain: false,
    imageSafetySensitivity: "strict",
    darkMode: false,
    autoDark: false,
    systemTheme: false,
    accentColor: "#3b4890",
    fontFamily: "default",
    fontScale: 1,
    compactMode: false,
    hideImages: false,
    hideAds: false,
    blockKeywords: [],
    blockUsers: [],
    botCommentFilter: true,
    botCommentSensitivity: "balanced",
    botCommentAllowlist: [],
    botCommentExamples: [
      "맞아. 요즘같은 AI시대에서 커뮤니티 실명제는 꽤나 합리적인 제도일 수 있어.",
      "목소리 복제 진짜 정교해져서 찝찝하긴 하네",
      "목소리 복제 기술 진짜 무섭게 발전하긴 했네",
      "도구 제대로 갖춰서 자동화 돌리면 이런 노가다 좀 줄어들 텐데."
    ],
    showAuthorButton: true,
    showRatioBadge: true,
    authorPages: 2,
    popupWidth: 720,
    popupMaxItems: 30
  });

  const LEGACY_DEFAULT_ACCENT = "#3b82f6";
  const PROFILE_PREFIX = "galleryProfile:";
  const PROFILE_KEYS = Object.freeze(["imageSafety", "imageSafetySexual", "imageSafetyHideUncertain", "imageSafetySensitivity", "botCommentFilter", "botCommentSensitivity", "blockKeywords"]);

  const FONT_OPTIONS = Object.freeze([
    { id: "default", label: "기본" },
    { id: "pretendard", label: "Pretendard" },
    { id: "noto", label: "Noto Sans KR" },
    { id: "system", label: "System UI" }
  ]);

  const FONT_STACKS = Object.freeze({
    default: "inherit",
    pretendard: '"Pretendard","Malgun Gothic","Apple SD Gothic Neo",sans-serif',
    noto: '"Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo",sans-serif',
    system: 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic",sans-serif'
  });

  // Settings that decide the <html> classes and variables. early.js caches
  // exactly these so the page can be themed before its first paint.
  const BOOT_KEYS = Object.freeze([
    "enabled", "darkMode", "autoDark", "systemTheme", "compactMode", "hideImages", "signatureImageBlock",
    "hideAds", "hideRealtimeBest", "hideDcMedia", "hideConceptPanels", "hideGnbPromo", "showFullTime",
    "expandCleanLayout", "accentColor", "fontScale", "fontFamily"
  ]);

  // DC night mode always wins: the site is dark, so a light palette would
  // leave light boxes with dark ink on it.
  function prefersDarkTheme(settings, env) {
    if (env.siteNight) return true;
    if (settings.systemTheme) return Boolean(env.systemDark);
    if (!settings.autoDark) return Boolean(settings.darkMode);
    const hour = env.now.getHours();
    return hour >= 19 || hour < 7;
  }

  // The single source of the root classes/variables, shared by early.js
  // (before first paint) and content.js (after the page settles).
  function rootState(settings, env) {
    const on = Boolean(settings.enabled);
    const flag = (value) => on && Boolean(value);
    return {
      classes: {
        "dcf-active": on,
        "dcf-dark": on && prefersDarkTheme(settings, env),
        "dcf-compact": flag(settings.compactMode),
        "dcf-hide-images": flag(settings.hideImages),
        "dcf-hide-auto-zzal": flag(settings.signatureImageBlock),
        "dcf-hide-ads": flag(settings.hideAds),
        "dcf-hide-timebest": flag(settings.hideRealtimeBest),
        "dcf-hide-dcmedia": flag(settings.hideDcMedia),
        "dcf-hide-concept": flag(settings.hideConceptPanels),
        "dcf-hide-gnb-promo": flag(settings.hideGnbPromo),
        "dcf-full-time": flag(settings.showFullTime),
        // The rail keeps the login panel; this only clears the boxes around it.
        "dcf-clean-rail": flag(env.listPage && settings.expandCleanLayout && settings.hideRealtimeBest && settings.hideDcMedia && settings.hideConceptPanels)
      },
      vars: {
        "--dcf-accent": settings.accentColor,
        "--dcf-font-scale": String(settings.fontScale),
        "--dcf-font-family": FONT_STACKS[settings.fontFamily] || "inherit"
      }
    };
  }

  function normalizeList(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .filter((item, index, array) => array.findIndex((other) => other.toLowerCase() === item.toLowerCase()) === index)
      .slice(0, 500);
  }

  function normalizeSettings(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const merged = Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [key, source[key] === undefined ? fallback : source[key]]));
    merged.enabled = Boolean(merged.enabled);
    merged.autoRefresh = Boolean(merged.autoRefresh);
    merged.openInNewTab = Boolean(merged.openInNewTab);
    merged.showReadPosts = Boolean(merged.showReadPosts);
    merged.showCommentDelta = Boolean(merged.showCommentDelta);
    merged.restoreListPosition = Boolean(merged.restoreListPosition);
    merged.showFullTime = Boolean(merged.showFullTime);
    merged.showNonFixedId = Boolean(merged.showNonFixedId);
    merged.keyboardNavigation = Boolean(merged.keyboardNavigation);
    merged.showIpInfo = Boolean(merged.showIpInfo);
    merged.blockCarrierIp = Boolean(merged.blockCarrierIp);
    merged.hideDcBlockedPosts = Boolean(merged.hideDcBlockedPosts);
    merged.hideRealtimeBest = Boolean(merged.hideRealtimeBest);
    merged.hideDcMedia = Boolean(merged.hideDcMedia);
    merged.hideConceptPanels = Boolean(merged.hideConceptPanels);
    merged.hideIssueRows = Boolean(merged.hideIssueRows);
    merged.hideGnbPromo = Boolean(merged.hideGnbPromo);
    merged.expandCleanLayout = Boolean(merged.expandCleanLayout);
    merged.imagePreview = Boolean(merged.imagePreview);
    merged.signatureImageBlock = Boolean(merged.signatureImageBlock);
    merged.imageSafety = Boolean(merged.imageSafety);
    merged.botCommentFilter = Boolean(merged.botCommentFilter);
    merged.botCommentSensitivity = ["balanced", "strict"].includes(merged.botCommentSensitivity) ? merged.botCommentSensitivity : DEFAULTS.botCommentSensitivity;
    merged.imageSafetySexual = Boolean(merged.imageSafetySexual);
    merged.imageSafetyHideUncertain = Boolean(merged.imageSafetyHideUncertain);
    merged.imageSafetySensitivity = ["strict", "balanced"].includes(merged.imageSafetySensitivity) ? merged.imageSafetySensitivity : DEFAULTS.imageSafetySensitivity;
    merged.darkMode = Boolean(merged.darkMode);
    merged.autoDark = Boolean(merged.autoDark);
    merged.systemTheme = Boolean(merged.systemTheme);
    merged.compactMode = Boolean(merged.compactMode);
    merged.hideImages = Boolean(merged.hideImages);
    merged.hideAds = Boolean(merged.hideAds);
    merged.showAuthorButton = Boolean(merged.showAuthorButton);
    merged.showRatioBadge = Boolean(merged.showRatioBadge);
    merged.accentColor = /^#[0-9a-f]{6}$/i.test(merged.accentColor) ? merged.accentColor : DEFAULTS.accentColor;
    // Pre-0.5.2 default. Older versions saved every key, so it sits in storage for users who never picked it.
    if (merged.accentColor.toLowerCase() === LEGACY_DEFAULT_ACCENT) merged.accentColor = DEFAULTS.accentColor;
    merged.fontFamily = FONT_OPTIONS.some((font) => font.id === merged.fontFamily) ? merged.fontFamily : DEFAULTS.fontFamily;
    merged.fontScale = clampNumber(Number(merged.fontScale), 0.85, 1.25, DEFAULTS.fontScale);
    merged.refreshInterval = Math.round(clampNumber(Number(merged.refreshInterval), 3, 60, DEFAULTS.refreshInterval));
    merged.previewDelay = Math.round(clampNumber(Number(merged.previewDelay), 150, 1500, DEFAULTS.previewDelay));
    merged.previewMaxImages = Math.round(clampNumber(Number(merged.previewMaxImages), 1, 4, DEFAULTS.previewMaxImages));
    merged.authorPages = Math.round(clampNumber(Number(merged.authorPages), 1, 5, DEFAULTS.authorPages));
    merged.popupWidth = Math.round(clampNumber(Number(merged.popupWidth), 480, 960, DEFAULTS.popupWidth));
    merged.popupMaxItems = Math.round(clampNumber(Number(merged.popupMaxItems), 10, 100, DEFAULTS.popupMaxItems));
    merged.blockKeywords = normalizeList(merged.blockKeywords);
    merged.blockUsers = normalizeList(merged.blockUsers);
    merged.botCommentExamples = normalizeList(merged.botCommentExamples).slice(0, 100);
    merged.botCommentAllowlist = normalizeList(merged.botCommentAllowlist).slice(0, 100);
    return merged;
  }

  function clampNumber(value, min, max, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }

  function loadGlobalSettings() {
    return chrome.storage.sync.get(DEFAULTS).then((raw) => normalizeSettings(raw));
  }

  function validGalleryKey(key) {
    return typeof key === "string" && /^(major|minor|mini|person):[a-z0-9_-]{1,80}$/.test(key);
  }

  function galleryKeyFromUrl(raw) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.hostname !== "gall.dcinside.com" || url.username || url.password || url.port) return "";
      const match = url.pathname.match(/^\/(?:(mgallery|mini|person)\/)?board\/(?:lists|view)\/?$/);
      if (!match) return "";
      const type = { mgallery: "minor", mini: "mini", person: "person" }[match[1]] || "major";
      const key = `${type}:${url.searchParams.get("id") || ""}`;
      return validGalleryKey(key) ? key : "";
    } catch (_error) { return ""; }
  }

  function normalizeProfile(raw) {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const normalized = normalizeSettings(source);
    return Object.fromEntries(PROFILE_KEYS.filter(key => Object.hasOwn(source, key) && source[key] !== undefined).map(key => [key, normalized[key]]));
  }

  async function loadGalleryProfile(key) {
    if (!validGalleryKey(key)) return {};
    const name = PROFILE_PREFIX + key;
    return normalizeProfile((await chrome.storage.sync.get({ [name]: {} }))[name]);
  }

  async function loadSettings(key) {
    const gallery = key === undefined ? galleryKeyFromUrl(globalThis.location?.href || globalThis.window?.location?.href) : key;
    const [common, profile] = await Promise.all([loadGlobalSettings(), loadGalleryProfile(gallery)]);
    return normalizeSettings({ ...common, ...profile });
  }

  function isSettingsChange(changes) {
    return Object.keys(changes).some(key => Object.hasOwn(DEFAULTS, key) || key.startsWith(PROFILE_PREFIX));
  }

  async function listGalleryProfiles() {
    const raw = await chrome.storage.sync.get(null);
    return Object.fromEntries(Object.entries(raw).filter(([key]) => key.startsWith(PROFILE_PREFIX) && validGalleryKey(key.slice(PROFILE_PREFIX.length))).map(([key, value]) => [key.slice(PROFILE_PREFIX.length), normalizeProfile(value)]));
  }

  async function saveGalleryProfile(key, patch) {
    if (!validGalleryKey(key)) throw new Error("갤러리 주소를 확인하세요.");
    const profile = normalizeProfile(patch);
    const name = PROFILE_PREFIX + key;
    if (new TextEncoder().encode(name + JSON.stringify(profile)).length > 7800) throw new Error("이 갤러리 설정이 너무 큽니다. 키워드를 줄여 주세요.");
    if (Object.keys(profile).length) await chrome.storage.sync.set({ [name]: profile });
    else await chrome.storage.sync.remove(name);
    return profile;
  }

  function validateSettings(settings) {
    for (const key of ["botCommentExamples", "botCommentAllowlist"]) {
      if (settings[key].some(text => text.length > 600)) throw new Error(`${key === "botCommentExamples" ? "봇 댓글 예시" : "댓글 허용"}는 문장 하나당 600자 이하로 입력하세요.`);
    }
    for (const key of ["blockKeywords", "blockUsers", "botCommentExamples", "botCommentAllowlist"]) {
      if (new TextEncoder().encode(key + JSON.stringify(settings[key])).length > 7800) {
        const label = key === "botCommentAllowlist" ? "댓글 허용" : key === "botCommentExamples" ? "봇 댓글 예시" : key === "blockKeywords" ? "키워드 차단" : "사용자 차단";
        throw new Error(`${label} 목록이 너무 큽니다. 항목을 줄인 뒤 다시 저장하세요.`);
      }
    }
    return settings;
  }

  function saveSettings(settings) {
    const normalized = normalizeSettings(settings);
    validateSettings(normalized);
    return chrome.storage.sync.set(normalized).then(() => normalized);
  }

  async function savePatch(patch, profiles = null) {
    const latest = await loadGlobalSettings();
    const normalized = validateSettings(normalizeSettings(Object.assign({}, latest, patch)));
    const changed = Object.fromEntries(Object.keys(patch).filter((key) => Object.hasOwn(DEFAULTS, key)).map((key) => [key, normalized[key]]));
    if (profiles !== null) {
      for (const [key, profile] of Object.entries(validateProfiles(profiles))) changed[PROFILE_PREFIX + key] = profile;
    }
    await chrome.storage.sync.set(changed);
    return normalized;
  }

  function parseBackup(text) {
    if (text.length > 100000) throw new Error("설정 파일은 100KB 이하만 불러올 수 있습니다.");
    const data = JSON.parse(text);
    if (data?.app !== "DCFilter" || data.schema !== 1 || !data.settings || Array.isArray(data.settings) || typeof data.settings !== "object") throw new Error("DCFilter에서 내보낸 설정 파일을 선택하세요.");
    for (const [key, value] of Object.entries(data.settings)) {
      if (!Object.hasOwn(DEFAULTS, key)) continue;
      if (Array.isArray(DEFAULTS[key]) ? !Array.isArray(value) || value.some((item) => typeof item !== "string") : typeof value !== typeof DEFAULTS[key]) throw new Error("설정 파일의 값 형식이 올바르지 않습니다.");
    }
    return validateSettings(normalizeSettings(data.settings));
  }

  function validateProfiles(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 512) throw new Error("갤러리별 설정 형식이 올바르지 않습니다.");
    const entries = [];
    for (const [key, value] of Object.entries(raw)) {
      if (!validGalleryKey(key) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("갤러리별 설정 형식이 올바르지 않습니다.");
      for (const name of PROFILE_KEYS) if (Object.hasOwn(value, name)) {
        const item = value[name];
        if (Array.isArray(DEFAULTS[name]) ? !Array.isArray(item) || item.some(word => typeof word !== "string") : typeof item !== typeof DEFAULTS[name]) throw new Error("갤러리 설정의 값 형식이 올바르지 않습니다.");
      }
      const profile = normalizeProfile(value);
      if (new TextEncoder().encode(PROFILE_PREFIX + key + JSON.stringify(profile)).length > 7800) throw new Error("갤러리 설정의 키워드 목록이 너무 큽니다.");
      entries.push([key, profile]);
    }
    return Object.fromEntries(entries);
  }

  async function createBackup() {
    const [settings, galleryProfiles] = await Promise.all([loadGlobalSettings(), listGalleryProfiles()]);
    return { app: "DCFilter", schema: 2, settings, galleryProfiles };
  }

  function parseBackupBundle(text) {
    if (text.length > 100000) throw new Error("설정 파일은 100KB 이하만 불러올 수 있습니다.");
    const data = JSON.parse(text);
    if (data?.schema === 1) return { settings: parseBackup(text), galleryProfiles: null };
    if (data?.schema !== 2) throw new Error("DCFilter에서 내보낸 설정 파일을 선택하세요.");
    const settings = parseBackup(JSON.stringify({ ...data, schema: 1 }));
    return { settings, galleryProfiles: validateProfiles(data.galleryProfiles) };
  }

  async function updateCommentRule(text, action) {
    const response = await chrome.runtime.sendMessage({ type: "dcf:comment-rule", text, action });
    if (!response?.ok) throw new Error(response?.error || "댓글 규칙을 저장하지 못했습니다.");
    return loadSettings();
  }

  const root = typeof window === "object" ? window : globalThis;
  root.DCFilterStorage = {
    DEFAULTS,
    FONT_OPTIONS,
    FONT_STACKS,
    BOOT_KEYS,
    prefersDarkTheme,
    rootState,
    normalizeList,
    normalizeSettings,
    loadSettings,
    loadGlobalSettings,
    PROFILE_KEYS,
    PROFILE_PREFIX,
    validGalleryKey,
    galleryKeyFromUrl,
    normalizeProfile,
    loadGalleryProfile,
    listGalleryProfiles,
    saveGalleryProfile,
    isSettingsChange,
    updateCommentRule,
    createBackup,
    parseBackupBundle,
    saveSettings,
    savePatch,
    parseBackup
  };
})();
