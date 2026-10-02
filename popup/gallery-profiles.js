(function () {
  "use strict";
  const storage = window.DCFilterStorage;
  const select = document.getElementById("profileGallery");
  const fields = document.getElementById("profileFields");
  const keywords = document.getElementById("profileKeywords");
  const override = document.getElementById("profileKeywordsOverride");
  const save = document.getElementById("profileSave");
  const reset = document.getElementById("profileReset");
  const status = document.getElementById("profileStatus");
  const labels = {
    "minor:ai_utilize": "AI활용", "minor:sff": "SFF",
    "minor:vanced": "리밴스드 (깃허브)", "minor:thesingularity": "특이점이 온다"
  };
  const definitions = [
    ["imageSafety", "혐짤 AI 사전 차단", [["true", "사용"], ["false", "사용 안 함"]]],
    ["imageSafetySexual", "성적 이미지 차단", [["true", "차단"], ["false", "차단 안 함"]]],
    ["imageSafetyHideUncertain", "애매한 이미지", [["false", "검사 완료 후 표시"], ["true", "계속 가리기"]]],
    ["imageSafetySensitivity", "이미지 차단 기준", [["strict", "엄격"], ["balanced", "보통"]]],
    ["botCommentFilter", "봇 의심 댓글 접기", [["true", "사용"], ["false", "사용 안 함"]]],
    ["botCommentSensitivity", "댓글 판별 기준", [["balanced", "뚜렷한 패턴만"], ["strict", "더 넓게 접기"]]]
  ];
  const inputs = new Map();
  let key = "", baseline = "{}", busy = true, revision = 0;
  for (const [name, label, choices] of definitions) {
    const row = document.createElement("label");
    const text = document.createElement("span"); text.textContent = label;
    const input = document.createElement("select"); input.id = `profile-${name}`;
    input.append(new Option("공통 설정 따르기", ""));
    for (const [value, title] of choices) input.append(new Option(title, value));
    row.append(text, input); fields.append(row); inputs.set(name, input);
    input.addEventListener("change", changed);
  }
  function read() {
    const result = {};
    for (const [name, input] of inputs) if (input.value !== "") result[name] = input.value === "true" ? true : input.value === "false" ? false : input.value;
    if (override.checked) result.blockKeywords = keywords.value.split(/\r?\n/);
    return storage.normalizeProfile(result);
  }
  function changed() {
    keywords.disabled = busy || !override.checked;
    const dirty = JSON.stringify(read()) !== baseline;
    save.disabled = busy || !key || !dirty;
    reset.disabled = busy || !key || baseline === "{}";
    if (!busy) status.textContent = dirty ? "이 갤러리에 저장하지 않은 변경이 있습니다." : baseline === "{}" ? "이 갤러리는 공통 설정을 따릅니다." : "이 갤러리 설정이 저장되어 있습니다.";
  }
  function setBusy(value) {
    busy = value;
    for (const control of document.querySelectorAll("#galleryProfileEditor input, #galleryProfileEditor select, #galleryProfileEditor button, #galleryProfileEditor textarea")) control.disabled = value;
    changed();
  }
  function addOption(value) {
    if (!Array.from(select.options).some(option => option.value === value)) select.add(new Option(labels[value] || value, value));
  }
  async function load(value) {
    const current = ++revision;
    setBusy(true);
    try {
      const profile = await storage.loadGalleryProfile(value);
      if (current !== revision) return;
      key = value; addOption(key); select.value = key;
      for (const [name, input] of inputs) input.value = Object.hasOwn(profile, name) ? String(profile[name]) : "";
      override.checked = Object.hasOwn(profile, "blockKeywords");
      keywords.value = (profile.blockKeywords || []).join("\n");
      baseline = JSON.stringify(profile);
    } catch (_error) {
      if (current === revision) { setBusy(false); select.value = key; status.textContent = "갤러리 설정을 읽지 못했습니다. 창을 다시 열어 주세요."; }
      return;
    }
    if (current === revision) setBusy(false);
  }
  async function switchTo(value) {
    if (JSON.stringify(read()) !== baseline && !window.confirm("저장하지 않은 갤러리 설정을 버리고 이동할까요?")) { select.value = key; return; }
    await load(value);
  }
  select.addEventListener("change", () => switchTo(select.value));
  override.addEventListener("change", changed); keywords.addEventListener("input", changed);
  document.getElementById("profileOpen").addEventListener("click", () => {
    const next = storage.galleryKeyFromUrl(document.getElementById("profileUrl").value.trim());
    if (!next) { status.textContent = "디시인사이드 데스크톱 갤러리의 목록 또는 글 주소를 입력하세요."; return; }
    switchTo(next);
  });
  save.addEventListener("click", async () => {
    const patch = read(); setBusy(true);
    try { await storage.saveGalleryProfile(key, patch); baseline = JSON.stringify(patch); setBusy(false); status.textContent = "갤러리 설정 저장 완료"; }
    catch (error) { setBusy(false); status.textContent = error.message || "저장하지 못했습니다. 다시 시도해 주세요."; }
  });
  reset.addEventListener("click", async () => {
    if (!window.confirm("이 갤러리의 개별 설정을 삭제하고 공통 설정을 따를까요?")) return;
    setBusy(true);
    try { await storage.saveGalleryProfile(key, {}); await load(key); }
    catch (error) { setBusy(false); status.textContent = error.message || "복원하지 못했습니다."; }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || busy || !key || !changes[storage.PROFILE_PREFIX + key]) return;
    if (JSON.stringify(read()) === baseline) load(key);
    else status.textContent = "다른 창에서 이 갤러리 설정이 바뀌었습니다. 저장하면 현재 입력을 적용합니다.";
  });
  async function init() {
    setBusy(true);
    const profiles = await storage.listGalleryProfiles();
    for (const value of [...Object.keys(labels), ...Object.keys(profiles)]) addOption(value);
    let current = "";
    try { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); current = storage.galleryKeyFromUrl(tab?.url); } catch (_error) { /* Presets and pasted URLs remain available. */ }
    await load(current || "minor:ai_utilize");
  }
  init().catch(() => { status.textContent = "갤러리 설정을 읽지 못했습니다. 창을 다시 열어 주세요."; });
})();
