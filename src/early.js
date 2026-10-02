(function () {
  "use strict";

  // Runs at document_start, before the site's own markup is parsed or painted.
  // content.js only starts at document_idle, so without this the page paints
  // as plain DC (white) first and the theme lands a moment later.
  //
  // 1. Replay the last applied settings from a synchronous cache.
  // 2. Re-read the real settings and correct — chrome.storage answers well
  //    before DC's head scripts finish, so in practice also before first paint.
  //    This covers the first visit and settings changed while no gallery tab
  //    was open.

  const storage = window.DCFilterStorage;
  const root = document.documentElement;
  const CACHE_KEY = "dcf:boot:v1";

  // DC ships <html class="darkmode"> to every visitor; the class says nothing.
  // Its night mode is the darkmode=1 cookie, which also makes the server load
  // dark.css (#css-darkmode); the editor pages add that link without reload.
  function isSiteNightMode() {
    return /(?:^|;\s*)darkmode=1(?:;|$)/.test(document.cookie) || Boolean(document.getElementById("css-darkmode"));
  }

  function pageEnv() {
    return {
      siteNight: isSiteNightMode(),
      listPage: /\/board\/lists/i.test(location.pathname),
      systemDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
      now: new Date()
    };
  }

  function apply(settings) {
    const next = storage.rootState(settings, pageEnv());
    // Only a correction after something has painted can animate; freeze
    // transitions for that one swap, as content.js does.
    const swapping = Boolean(document.body) && root.classList.contains("dcf-dark") !== next.classes["dcf-dark"];
    if (swapping) root.classList.add("dcf-theme-changing");
    Object.entries(next.classes).forEach(([name, on]) => root.classList.toggle(name, on));
    Object.entries(next.vars).forEach(([name, value]) => root.style.setProperty(name, value));
    if (swapping) {
      void root.offsetHeight;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => root.classList.remove("dcf-theme-changing")));
    }
    return next;
  }

  function remember(settings) {
    try {
      const picked = Object.fromEntries(storage.BOOT_KEYS.map((key) => [key, settings[key]]));
      localStorage.setItem(CACHE_KEY, JSON.stringify(picked));
    } catch (_error) {
      // Storage blocked or full: the page just themes a moment later.
    }
  }

  function readCache() {
    try {
      const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      return raw && typeof raw === "object" ? storage.normalizeSettings(raw) : null;
    } catch (_error) {
      return null;
    }
  }

  const boot = {
    // content.js sets this once it owns the root state; a late answer from
    // the read below must not overwrite it.
    settled: false,
    isSiteNightMode,
    pageEnv,
    remember
  };
  window.DCFilterBoot = boot;

  const cached = readCache();
  if (cached) apply(cached);

  storage.loadSettings().then((settings) => {
    if (!boot.settled) apply(settings);
    remember(settings);
  }).catch(() => {});
})();
