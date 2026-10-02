(function () {
  "use strict";

  const storage = window.DCFilterStorage;
  const reading = window.DCFilterReadingState;
  const controls = {
    enabled: document.getElementById("enabled"),
    enabledStatus: document.getElementById("enabledStatus"),
    version: document.getElementById("version"),
    autoRefresh: document.getElementById("autoRefresh"),
    refreshInterval: document.getElementById("refreshInterval"),
    openInNewTab: document.getElementById("openInNewTab"),
    showReadPosts: document.getElementById("showReadPosts"),
    showCommentDelta: document.getElementById("showCommentDelta"),
    restoreListPosition: document.getElementById("restoreListPosition"),
    readHistoryCount: document.getElementById("readHistoryCount"),
    clearReadHistory: document.getElementById("clearReadHistory"),
    showFullTime: document.getElementById("showFullTime"),
    showNonFixedId: document.getElementById("showNonFixedId"),
    keyboardNavigation: document.getElementById("keyboardNavigation"),
    showIpInfo: document.getElementById("showIpInfo"),
    blockCarrierIp: document.getElementById("blockCarrierIp"),
    hideDcBlockedPosts: document.getElementById("hideDcBlockedPosts"),
    hideRealtimeBest: document.getElementById("hideRealtimeBest"),
    hideDcMedia: document.getElementById("hideDcMedia"),
    hideConceptPanels: document.getElementById("hideConceptPanels"),
    hideIssueRows: document.getElementById("hideIssueRows"),
    hideGnbPromo: document.getElementById("hideGnbPromo"),
    expandCleanLayout: document.getElementById("expandCleanLayout"),
    imagePreview: document.getElementById("imagePreview"),
    previewDelay: document.getElementById("previewDelay"),
    previewMaxImages: document.getElementById("previewMaxImages"),
    signatureImageBlock: document.getElementById("signatureImageBlock"),
    imageSafety: document.getElementById("imageSafety"),
    imageSafetySexual: document.getElementById("imageSafetySexual"),
    imageSafetyHideUncertain: document.getElementById("imageSafetyHideUncertain"),
    imageSafetySensitivity: document.getElementById("imageSafetySensitivity"),
    blockedImageCount: document.getElementById("blockedImageCount"),
    clearBlockedImages: document.getElementById("clearBlockedImages"),
    themeModes: Array.from(document.querySelectorAll('input[name="themeMode"]')),
    compactMode: document.getElementById("compactMode"),
    hideImages: document.getElementById("hideImages"),
    hideAds: document.getElementById("hideAds"),
    accentColor: document.getElementById("accentColor"),
    accentValue: document.getElementById("accentValue"),
    fontFamily: document.getElementById("fontFamily"),
    fontScale: document.getElementById("fontScale"),
    fontScaleValue: document.getElementById("fontScaleValue"),
    showAuthorButton: document.getElementById("showAuthorButton"),
    showRatioBadge: document.getElementById("showRatioBadge"),
    authorPages: document.getElementById("authorPages"),
    popupWidth: document.getElementById("popupWidth"),
    popupMaxItems: document.getElementById("popupMaxItems"),
    blockKeywords: document.getElementById("blockKeywords"),
    blockUsers: document.getElementById("blockUsers"),
    botCommentFilter: document.getElementById("botCommentFilter"),
    botCommentSensitivity: document.getElementById("botCommentSensitivity"),
    botCommentExamples: document.getElementById("botCommentExamples"),
    botCommentAllowlist: document.getElementById("botCommentAllowlist"),
    save: document.getElementById("save"),
    reset: document.getElementById("reset"),
    saveStatus: document.getElementById("saveStatus"),
    saveState: document.querySelector(".save-state"),
    navButtons: Array.from(document.querySelectorAll(".section-nav button[data-target]")),
    sections: Array.from(document.querySelectorAll(".section[id]"))
  };

  let baseline = "";
  let statusTimer = 0;
  let scrollFrame = 0;
  let blockedImageCount = 0;
  let readHistoryCount = 0;
  let readCountTimer = 0;
  let clearingReadHistory = false;
  let saving = false;
  let pendingProfiles = null;
  let activeSection = "settings-list";
  const search = document.getElementById("settingsSearch");
  const discard = document.getElementById("discard");

  init().catch((error) => {
    controls.saveStatus.textContent = "설정을 불러오지 못했습니다. 창을 닫고 다시 열어 주세요.";
    controls.saveState.classList.remove("is-success");
    controls.save.disabled = true;
    console.error("DCFilter popup init failed", error);
  });

  async function init() {
    history.scrollRestoration = "manual";
    fillFontOptions();
    renderVersion();
    bindEvents();
    const [settings] = await Promise.all([storage.loadSettings(), loadBlockedImageCount(), loadReadHistoryCount()]);
    render(settings, { setBaseline: true });
    syncActiveNavigation();
    window.scrollTo(0, 0);
  }

  function bindEvents() {
    controls.save.addEventListener("click", save);
    controls.reset.addEventListener("click", reset);
    controls.clearBlockedImages.addEventListener("click", clearBlockedImages);
    controls.clearReadHistory.addEventListener("click", clearReadHistory);
    discard.addEventListener("click", () => { pendingProfiles = null; render(JSON.parse(baseline), { setBaseline: true }); });
    search.addEventListener("input", filterSections);
    document.getElementById("clearSearch").addEventListener("click", () => { search.value = ""; filterSections(); search.focus(); });
    document.getElementById("exportSettings").addEventListener("click", exportSettings);
    document.getElementById("importSettings").addEventListener("click", () => document.getElementById("importFile").click());
    document.getElementById("importFile").addEventListener("change", importSettings);
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (event.target.closest?.("#galleryProfileEditor")) {
          const profileSave = document.getElementById("profileSave");
          if (!profileSave.disabled) profileSave.click();
        } else if (!controls.save.disabled) save();
      }
      if (event.key === "Escape" && search.value) { search.value = ""; filterSections(); search.focus(); }
    });

    document.querySelectorAll("input:not([type='search']):not([type='file']), select, textarea").forEach((control) => {
      if (control.closest("#galleryProfileEditor")) return;
      control.addEventListener("input", handleFormInput);
      control.addEventListener("change", handleFormInput);
    });

    controls.navButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const section = document.getElementById(button.dataset.target);
        if (!section) return;
        activeSection = button.dataset.target;
        search.value = "";
        filterSections();
        window.scrollTo(0, 0);
      });
    });

    window.addEventListener("scroll", () => {
      if (scrollFrame) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0;
        syncActiveNavigation();
      });
    }, { passive: true });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && Object.keys(changes).some((key) => key === reading.RESET_KEY || key.startsWith(reading.READ_PREFIX))) {
        window.clearTimeout(readCountTimer);
        readCountTimer = window.setTimeout(() => loadReadHistoryCount().catch(console.error), 80);
      }
      if (areaName !== "local" || !changes.blockedImageFingerprints) return;
      const next = changes.blockedImageFingerprints.newValue;
      blockedImageCount = Array.isArray(next) ? next.length : 0;
      renderBlockedImageCount();
    });
  }

  function fillFontOptions() {
    controls.fontFamily.innerHTML = storage.FONT_OPTIONS
      .map((font) => `<option value="${font.id}">${font.label}</option>`)
      .join("");
  }

  function renderVersion() {
    try {
      const manifest = chrome.runtime.getManifest();
      controls.version.textContent = manifest && manifest.version ? `v${manifest.version}` : "";
    } catch (_error) {
      controls.version.textContent = "";
    }
  }

  function render(settings, options) {
    const normalized = storage.normalizeSettings(settings);
    controls.enabled.checked = normalized.enabled;
    controls.autoRefresh.checked = normalized.autoRefresh;
    controls.refreshInterval.value = normalized.refreshInterval;
    controls.openInNewTab.checked = normalized.openInNewTab;
    controls.showReadPosts.checked = normalized.showReadPosts;
    controls.showCommentDelta.checked = normalized.showCommentDelta;
    controls.restoreListPosition.checked = normalized.restoreListPosition;
    controls.showFullTime.checked = normalized.showFullTime;
    controls.showNonFixedId.checked = normalized.showNonFixedId;
    controls.keyboardNavigation.checked = normalized.keyboardNavigation;
    controls.showIpInfo.checked = normalized.showIpInfo;
    controls.blockCarrierIp.checked = normalized.blockCarrierIp;
    controls.hideDcBlockedPosts.checked = normalized.hideDcBlockedPosts;
    controls.hideRealtimeBest.checked = normalized.hideRealtimeBest;
    controls.hideDcMedia.checked = normalized.hideDcMedia;
    controls.hideConceptPanels.checked = normalized.hideConceptPanels;
    controls.hideIssueRows.checked = normalized.hideIssueRows;
    controls.hideGnbPromo.checked = normalized.hideGnbPromo;
    controls.expandCleanLayout.checked = normalized.expandCleanLayout;
    controls.imagePreview.checked = normalized.imagePreview;
    controls.previewDelay.value = normalized.previewDelay;
    controls.previewMaxImages.value = normalized.previewMaxImages;
    controls.signatureImageBlock.checked = normalized.signatureImageBlock;
    controls.imageSafety.checked = normalized.imageSafety;
    controls.imageSafetySexual.checked = normalized.imageSafetySexual;
    controls.imageSafetyHideUncertain.checked = normalized.imageSafetyHideUncertain;
    controls.imageSafetySensitivity.value = normalized.imageSafetySensitivity;
    setThemeMode(normalized.systemTheme ? "system" : normalized.autoDark ? "auto" : normalized.darkMode ? "dark" : "light");
    controls.compactMode.checked = normalized.compactMode;
    controls.hideImages.checked = normalized.hideImages;
    controls.hideAds.checked = normalized.hideAds;
    controls.accentColor.value = normalized.accentColor;
    controls.fontFamily.value = normalized.fontFamily;
    controls.fontScale.value = normalized.fontScale;
    controls.showAuthorButton.checked = normalized.showAuthorButton;
    controls.showRatioBadge.checked = normalized.showRatioBadge;
    controls.authorPages.value = normalized.authorPages;
    controls.popupWidth.value = normalized.popupWidth;
    controls.popupMaxItems.value = normalized.popupMaxItems;
    controls.blockKeywords.value = normalized.blockKeywords.join("\n");
    controls.blockUsers.value = normalized.blockUsers.join("\n");
    controls.botCommentFilter.checked = normalized.botCommentFilter;
    controls.botCommentSensitivity.value = normalized.botCommentSensitivity;
    controls.botCommentExamples.value = normalized.botCommentExamples.join("\n");
    controls.botCommentAllowlist.value = normalized.botCommentAllowlist.join("\n");

    if (options && options.setBaseline) baseline = serialize(normalized);
    syncUiState();
    filterSections();
  }

  function handleFormInput() {
    clearStatusTimer();
    syncUiState();
  }

  function syncUiState() {
    syncThemePreview();
    syncDependentControls();
    syncValueLabels();
    syncEnabledStatus();
    syncDirtyState();
  }

  function syncThemePreview() {
    const mode = getThemeMode();
    const hour = new Date().getHours();
    const useDark = mode === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches : mode === "auto" ? hour >= 19 || hour < 7 : mode === "dark";
    const changingTheme = document.documentElement.dataset.theme !== (useDark ? "dark" : "light");
    if (changingTheme) document.documentElement.classList.add("theme-changing");
    document.documentElement.dataset.theme = useDark ? "dark" : "light";
    // popup.css derives fill/ink/tint from this and clamps lightness so white text on fills stays legible.
    document.documentElement.style.setProperty("--popup-accent", controls.accentColor.value || "#3b4890");
    if (changingTheme) {
      void document.documentElement.offsetHeight;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => document.documentElement.classList.remove("theme-changing")));
    }
  }

  function syncDependentControls() {
    setDependentRows("autoRefresh", controls.autoRefresh.checked);
    setDependentRows("imagePreview", controls.imagePreview.checked);
    setDependentRows("imageSafety", controls.imageSafety.checked);
    setDependentRows("botCommentFilter", controls.botCommentFilter.checked);
    setDependentRows("showReadPosts", controls.showReadPosts.checked);
  }

  function setDependentRows(controlId, enabled) {
    document.querySelectorAll(`[data-depends-on="${controlId}"]`).forEach((row) => {
      row.classList.toggle("is-disabled", !enabled);
      row.querySelectorAll("input, select, textarea").forEach((control) => {
        control.disabled = !enabled;
      });
    });
  }

  function syncValueLabels() {
    controls.accentValue.textContent = (controls.accentColor.value || "#3b4890").toUpperCase();
    controls.fontScaleValue.textContent = `${Math.round(Number(controls.fontScale.value || 1) * 100)}%`;
  }

  function syncEnabledStatus() {
    const enabled = controls.enabled.checked;
    document.documentElement.dataset.enabled = String(enabled);
    const savedEnabled = baseline ? JSON.parse(baseline).enabled : enabled;
    controls.enabledStatus.textContent = enabled !== savedEnabled ? (enabled ? "저장하면 사용 재개" : "저장하면 일시 정지") : enabled ? "갤러리에 적용 중" : "확장 기능 일시 정지";
  }

  function syncDirtyState() {
    const dirty = serialize(readForm()) !== baseline || pendingProfiles !== null;
    document.documentElement.classList.toggle("is-dirty", dirty);
    controls.save.disabled = saving || !dirty;
    discard.disabled = saving || !dirty;
    controls.saveState.classList.remove("is-success");
    controls.saveStatus.textContent = dirty ? "저장하지 않은 공통 설정" : "공통 설정 저장됨";
    // boot.js replays this on the next open. Only a saved state is worth
    // replaying; an unsaved preview would open the popup in the wrong theme.
    if (!dirty) rememberTheme();
  }

  function rememberTheme() {
    try {
      localStorage.setItem("dcf:popup-theme", JSON.stringify({
        theme: document.documentElement.dataset.theme,
        accent: controls.accentColor.value
      }));
    } catch (_error) {
      // Storage unavailable: the popup themes once settings load, as before.
    }
  }

  function getThemeMode() {
    const selected = controls.themeModes.find((control) => control.checked);
    return selected ? selected.value : "light";
  }

  function setThemeMode(mode) {
    controls.themeModes.forEach((control) => {
      control.checked = control.value === mode;
    });
  }

  function readForm() {
    return storage.normalizeSettings({
      enabled: controls.enabled.checked,
      autoRefresh: controls.autoRefresh.checked,
      refreshInterval: Number(controls.refreshInterval.value),
      openInNewTab: controls.openInNewTab.checked,
      showReadPosts: controls.showReadPosts.checked,
      showCommentDelta: controls.showCommentDelta.checked,
      restoreListPosition: controls.restoreListPosition.checked,
      showFullTime: controls.showFullTime.checked,
      showNonFixedId: controls.showNonFixedId.checked,
      keyboardNavigation: controls.keyboardNavigation.checked,
      showIpInfo: controls.showIpInfo.checked,
      blockCarrierIp: controls.blockCarrierIp.checked,
      hideDcBlockedPosts: controls.hideDcBlockedPosts.checked,
      hideRealtimeBest: controls.hideRealtimeBest.checked,
      hideDcMedia: controls.hideDcMedia.checked,
      hideConceptPanels: controls.hideConceptPanels.checked,
      hideIssueRows: controls.hideIssueRows.checked,
      hideGnbPromo: controls.hideGnbPromo.checked,
      expandCleanLayout: controls.expandCleanLayout.checked,
      imagePreview: controls.imagePreview.checked,
      previewDelay: Number(controls.previewDelay.value),
      previewMaxImages: Number(controls.previewMaxImages.value),
      signatureImageBlock: controls.signatureImageBlock.checked,
      imageSafety: controls.imageSafety.checked,
      imageSafetySexual: controls.imageSafetySexual.checked,
      imageSafetyHideUncertain: controls.imageSafetyHideUncertain.checked,
      imageSafetySensitivity: controls.imageSafetySensitivity.value,
      darkMode: getThemeMode() === "dark",
      autoDark: getThemeMode() === "auto",
      systemTheme: getThemeMode() === "system",
      compactMode: controls.compactMode.checked,
      hideImages: controls.hideImages.checked,
      hideAds: controls.hideAds.checked,
      accentColor: controls.accentColor.value,
      fontFamily: controls.fontFamily.value,
      fontScale: Number(controls.fontScale.value),
      showAuthorButton: controls.showAuthorButton.checked,
      showRatioBadge: controls.showRatioBadge.checked,
      authorPages: Number(controls.authorPages.value),
      popupWidth: Number(controls.popupWidth.value),
      popupMaxItems: Number(controls.popupMaxItems.value),
      blockKeywords: controls.blockKeywords.value.split(/\r?\n/),
      botCommentFilter: controls.botCommentFilter.checked,
      botCommentSensitivity: controls.botCommentSensitivity.value,
      botCommentExamples: controls.botCommentExamples.value.split(/\r?\n/),
      botCommentAllowlist: controls.botCommentAllowlist.value.split(/\r?\n/),
      blockUsers: controls.blockUsers.value.split(/\r?\n/)
    });
  }

  function serialize(settings) {
    return JSON.stringify(storage.normalizeSettings(settings));
  }

  async function loadBlockedImageCount() {
    const result = await chrome.storage.local.get({ blockedImageFingerprints: [] });
    blockedImageCount = Array.isArray(result.blockedImageFingerprints) ? result.blockedImageFingerprints.length : 0;
    renderBlockedImageCount();
  }

  async function loadReadHistoryCount() {
    const snapshot = reading.selectHistory(await chrome.storage.local.get(null));
    readHistoryCount = snapshot.records.size;
    controls.readHistoryCount.textContent = `${readHistoryCount.toLocaleString("ko-KR")}개 · 30일 보관 · 로컬 전용`;
    controls.clearReadHistory.disabled = clearingReadHistory || readHistoryCount === 0;
  }

  async function clearReadHistory() {
    if (clearingReadHistory || !readHistoryCount || !window.confirm("읽음 기록과 댓글 비교 기준을 모두 비울까요? 자짤 차단 목록과 다른 설정은 유지됩니다.")) return;
    clearingReadHistory = true;
    controls.clearReadHistory.disabled = true;
    clearStatusTimer();
    try {
      const raw = await chrome.storage.local.get(null);
      const keys = Object.keys(raw).filter((key) => key.startsWith(reading.READ_PREFIX));
      await chrome.storage.local.set({ [reading.RESET_KEY]: Date.now() });
      if (keys.length) await chrome.storage.local.remove(keys);
      flashStatus("읽음 기록 비움");
    } catch (error) {
      controls.saveStatus.textContent = "읽음 기록을 비우지 못했습니다";
      console.error("DCFilter read history reset failed", error);
    } finally {
      clearingReadHistory = false;
      await loadReadHistoryCount();
    }
  }

  function renderBlockedImageCount() {
    controls.blockedImageCount.textContent = `${blockedImageCount}개 · 이 브라우저에만 저장`;
    controls.clearBlockedImages.disabled = blockedImageCount === 0;
  }

  async function clearBlockedImages() {
    if (!blockedImageCount || !window.confirm(`저장된 자짤 ${blockedImageCount}개를 모두 해제할까요?`)) return;
    controls.clearBlockedImages.disabled = true;
    controls.clearBlockedImages.textContent = "해제 중";
    try {
      await chrome.storage.local.set({ blockedImageFingerprints: [] });
      blockedImageCount = 0;
      renderBlockedImageCount();
      flashStatus("자짤 차단 목록 비움");
    } catch (error) {
      controls.saveStatus.textContent = "차단 목록을 비우지 못했습니다";
      console.error("DCFilter image block list reset failed", error);
    } finally {
      controls.clearBlockedImages.textContent = "모두 해제";
      renderBlockedImageCount();
    }
  }

  async function save() {
    if (saving) return;
    const invalid = Array.from(document.querySelectorAll("input[type='number']")).find((input) => !input.disabled && (!input.value || !input.checkValidity()));
    if (invalid) {
      activeSection = invalid.closest(".section").id;
      search.value = ""; filterSections();
      invalid.focus(); invalid.reportValidity();
      controls.saveStatus.textContent = `값을 ${invalid.min}–${invalid.max} 범위로 입력하세요.`;
      return;
    }
    saving = true;
    clearStatusTimer();
    const draft = readForm();
    const submittedProfiles = pendingProfiles;
    const previous = JSON.parse(baseline);
    const patch = Object.fromEntries(Object.entries(draft).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key])));
    controls.save.disabled = true;
    controls.save.textContent = "저장 중";
    try {
      const saved = await storage.savePatch(patch, submittedProfiles);
      if (pendingProfiles === submittedProfiles) pendingProfiles = null;
      // 저장 대기 중 바뀐 입력은 그대로 남겨 다음 저장에서 반영한다.
      if (serialize(readForm()) === serialize(draft)) render(saved, { setBaseline: true });
      else baseline = serialize(saved);
      flashStatus("저장 완료");
    } catch (error) {
      controls.saveStatus.textContent = error.message || "저장하지 못했습니다. 다시 저장해 주세요.";
      controls.save.disabled = false;
      console.error("DCFilter settings save failed", error);
    } finally {
      controls.save.textContent = "저장";
      saving = false;
      controls.save.disabled = serialize(readForm()) === baseline && pendingProfiles === null;
      discard.disabled = controls.save.disabled;
    }
  }

  async function reset() {
    if (!window.confirm("화면 설정과 키워드·사용자 차단 목록을 기본값으로 되돌릴까요? 읽음 기록과 자짤 지문은 유지됩니다. 저장 전에는 되돌릴 수 있습니다.")) return;
    clearStatusTimer();
    pendingProfiles = null;
    render(storage.DEFAULTS);
    controls.saveStatus.textContent = "기본값을 확인한 뒤 저장하세요";
  }

  function flashStatus(message) {
    controls.saveState.classList.add("is-success");
    controls.saveStatus.textContent = message;
    statusTimer = window.setTimeout(() => {
      statusTimer = 0;
      syncDirtyState();
    }, 1200);
  }

  function clearStatusTimer() {
    if (!statusTimer) return;
    window.clearTimeout(statusTimer);
    statusTimer = 0;
  }

  function syncActiveNavigation() {
    setActiveNavigation(search.value.trim() ? "" : activeSection);
  }

  function filterSections() {
    const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    let count = 0;
    controls.sections.forEach((section) => {
      const rows = Array.from(section.children).filter((node) => node.matches(".setting-row, .text-field, .theme-field, .data-actions, .management-note, .utility-button, .field-hint"));
      rows.forEach((row) => {
        const text = (section.querySelector("h2").textContent + " " + row.textContent).toLocaleLowerCase();
        row.hidden = terms.length > 0 && !terms.every((term) => text.includes(term));
      });
      const matches = rows.filter((row) => !row.hidden).length;
      section.hidden = terms.length ? matches === 0 : section.id !== activeSection;
      if (terms.length) count += matches;
    });
    const status = document.getElementById("searchStatus");
    status.hidden = !terms.length;
    status.textContent = count ? `${count}개 항목` : "일치하는 설정이 없습니다. 다른 단어로 검색하거나 검색을 지워 주세요.";
    document.getElementById("clearSearch").hidden = !terms.length;
    syncActiveNavigation();
  }

  async function exportSettings() {
    try {
      const backup = await storage.createBackup();
      const text = JSON.stringify({ ...backup, version: chrome.runtime.getManifest().version }, null, 2);
      if (new TextEncoder().encode(text).length > 100000) throw new Error("설정 파일이 100KB를 넘습니다. 목록을 줄인 뒤 다시 내보내세요.");
      const blob = new Blob([text], {type: "application/json"});
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = "DCFilter-settings.json"; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      flashStatus("저장된 설정을 내보냈습니다");
    } catch (error) { controls.saveStatus.textContent = error.message || "내보내지 못했습니다. 다시 시도해 주세요."; }
  }

  async function importSettings(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 100000) throw new Error("설정 파일은 100KB 이하만 불러올 수 있습니다.");
      const backup = storage.parseBackupBundle(await file.text());
      if ((serialize(readForm()) !== baseline || pendingProfiles !== null) && !window.confirm("저장하지 않은 변경을 불러온 설정으로 바꿀까요?")) return;
      pendingProfiles = backup.galleryProfiles;
      render(backup.settings);
      controls.saveStatus.textContent = pendingProfiles === null ? "불러온 설정을 확인한 뒤 저장하세요" : `저장하면 공통 설정과 갤러리 설정 ${Object.keys(pendingProfiles).length}개를 적용합니다`;
    } catch (error) { controls.saveStatus.textContent = error instanceof SyntaxError ? "JSON 파일을 읽지 못했습니다. DCFilter 백업 파일을 선택하세요." : error.message; }
    finally { event.target.value = ""; }
  }

  function setActiveNavigation(sectionId) {
    controls.navButtons.forEach((button) => {
      const active = button.dataset.target === sectionId;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    });
  }
})();
