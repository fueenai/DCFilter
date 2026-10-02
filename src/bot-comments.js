(function () {
  "use strict";

  const storage = window.DCFilterStorage;
  const policy = window.DCFBotPolicy;
  if (!storage || !policy) return;

  const BODY_SELECTOR = ".comment_wrap .usertxt, .comment_wrap .comment_txt";
  const EDITOR_SELECTOR = 'textarea, input, [contenteditable]:not([contenteditable="false"]), .comment_write, .cmt_write_box, .reply_write';
  const IGNORE_TEXT_SELECTOR = 'script, style, noscript, button, input, textarea, select, iframe, object, embed, [data-dcf-owned], [contenteditable]:not([contenteditable="false"])';
  const QUOTE_SELECTOR = "blockquote, q, pre, code";
  const DELETED_SELECTOR = '.cmt_del_txt, .del_comment, .deleted_comment, [data-deleted="true"]';
  const SETTING_KEYS = ["enabled", "botCommentFilter", "botCommentSensitivity", "botCommentExamples", "botCommentAllowlist"];
  const records = new Map();
  let settings = storage.DEFAULTS;
  let ready = false;
  let active = false;
  let timer = 0;
  let serial = 0;
  let settingsSignature = "";
  let settingsRead = 0;

  const observer = new MutationObserver((changes) => {
    if (changes.some(isCommentMutation)) scheduleScan();
  });

  // Resolve the current gallery again after changes. Sequence reads so an old
  // async response cannot overwrite a newer profile or rule update.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (typeof storage.isSettingsChange === "function" ? !storage.isSettingsChange(changes) : !SETTING_KEYS.some(key => Object.hasOwn(changes, key))) return;
    refreshSettings();
  });
  refreshSettings();

  async function refreshSettings() {
    const read = ++settingsRead;
    try {
      const next = await storage.loadSettings();
      if (read === settingsRead) configure(next);
    } catch (_) {
      if (read === settingsRead && !ready) configure(storage.DEFAULTS);
    }
  }

  function observe() {
    if (!active || !document.documentElement) return;
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "id", "contenteditable", "data-uid", "data-nick", "data-ip", "data-deleted"]
    });
  }

  function configure(next) {
    settings = next;
    ready = true;
    const signature = JSON.stringify(SETTING_KEYS.map((key) => settings[key]));
    if (signature === settingsSignature) return;
    settingsSignature = signature;
    active = Boolean(settings.enabled && settings.botCommentFilter);
    if (!active) {
      clearTimeout(timer);
      timer = 0;
      observer.disconnect();
      let changed = false;
      for (const record of records.values()) changed = restore(record) || changed;
      records.clear();
      if (changed) notifyLayout();
      return;
    }
    observe();
    scheduleScan();
  }

  function isCommentMutation(change) {
    const target = change.target.nodeType === Node.ELEMENT_NODE ? change.target : change.target.parentElement;
    if (target?.closest("[data-dcf-owned]")) return false;
    if (target?.closest(".comment_wrap")) return true;
    if (change.type !== "childList" && change.type !== "attributes") return false;
    if (change.type === "attributes") return Boolean(target?.matches(".comment_wrap"));
    return [...change.addedNodes, ...change.removedNodes].some((node) =>
      node.nodeType === Node.ELEMENT_NODE && !node.matches("[data-dcf-owned]") &&
      (node.matches(".comment_wrap") || node.querySelector(".comment_wrap"))
    );
  }

  function scheduleScan() {
    if (!active || timer) return;
    // A comment page often arrives as many adjacent mutations; analyze it as
    // one batch so duplicate evidence is consistent across the whole page.
    timer = window.setTimeout(scan, 45);
  }

  function bodyText(element, omitQuotes = true) {
    const pieces = [];
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        pieces.push(node.nodeValue || "");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || node.matches(IGNORE_TEXT_SELECTOR) || (omitQuotes && node.matches(QUOTE_SELECTOR))) return;
      if (node.tagName === "BR") {
        pieces.push("\n");
        return;
      }
      const block = /^(?:P|DIV|LI|SECTION|ARTICLE|BLOCKQUOTE|PRE)$/.test(node.tagName);
      if (block) pieces.push("\n");
      for (const child of node.childNodes) visit(child);
      if (block) pieces.push("\n");
    };
    visit(element);
    return pieces.join("").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function candidate(element) {
    if (element.closest(EDITOR_SELECTOR) || element.closest("[data-dcf-owned]") || element.closest(DELETED_SELECTOR)) return null;
    // Some layouts use comment_txt as the container around usertxt. Only a
    // leaf body may be collapsed; never its author, controls, or child replies.
    if (element.querySelector(".usertxt, .comment_txt, .cmt_info, .reply_info, .gall_writer")) return null;
    const text = bodyText(element);
    const fingerprint = bodyText(element, false);
    if (!fingerprint || /^(?:삭제된\s*댓글(?:입니다)?|작성자(?:에\s*의해|가)\s*삭제한\s*댓글(?:입니다)?|관리자(?:에\s*의해|가)\s*삭제한\s*댓글(?:입니다)?)[.!\s]*$/.test(fingerprint)) return null;
    return { text, fingerprint };
  }

  function authorKey(element) {
    const scope = element.closest(".addbox, .cmt_info, .reply_info") || element.closest("li") || element.parentElement;
    const writer = scope?.querySelector(".gall_writer");
    const uid = writer?.getAttribute("data-uid")?.trim();
    if (uid) return `uid:${uid}`;
    const nick = writer?.getAttribute("data-nick")?.trim() || "";
    const ip = writer?.getAttribute("data-ip")?.trim() || "";
    // Unknown authors must not be treated as one account. Keys live only in
    // this page's batch and are neither persisted nor sent anywhere.
    return nick || ip ? `anon:${JSON.stringify([nick, ip])}` : "";
  }

  function scan() {
    timer = 0;
    if (!active) return;
    observer.disconnect();
    let changed = false;
    try {
      const current = new Set();
      const comments = [];
      for (const element of document.querySelectorAll(BODY_SELECTOR)) {
        const value = candidate(element);
        if (!value) continue;
        current.add(element);
        let record = records.get(element);
        if (!record) {
          record = { element, id: `dcf-bot-comment-${++serial}`, fingerprint: value.fingerprint, revealed: false, control: null, ownedId: null, pending: false, menuOpen: false };
          records.set(element, record);
        } else if (record.fingerprint !== value.fingerprint) {
          record.fingerprint = value.fingerprint;
          record.revealed = false;
          record.menuOpen = false;
          if (record.status) record.status.textContent = "";
        }
        comments.push({ id: record.id, text: value.text, fullText: value.fingerprint, authorKey: authorKey(element) });
      }
      for (const [element, record] of records) {
        if (current.has(element)) continue;
        changed = restore(record) || changed;
        records.delete(element);
      }
      const results = new Map(policy.analyzeComments(comments, {
        sensitivity: settings.botCommentSensitivity,
        templates: settings.botCommentExamples,
        allowlist: settings.botCommentAllowlist
      }).map((result) => [result.id, result]));
      for (const record of records.values()) {
        const result = results.get(record.id);
        changed = render(record, result) || changed;
      }
    } catch (error) {
      // A classifier failure must not leave unreadable text behind.
      for (const record of records.values()) changed = restore(record) || changed;
      console.warn("[DCFilter] 봇 댓글 필터를 적용하지 못했습니다.", error);
    } finally {
      observe();
      if (changed) notifyLayout();
    }
  }

  function ensureTextId(record) {
    if (!record.element.id) {
      let id = `${record.id}-text`;
      while (document.getElementById(id)) id += "-body";
      record.element.id = id;
      record.ownedId = id;
    }
    return record.element.id;
  }

  function render(record, result) {
    let changed = false;
    if (!record.control?.isConnected || record.control.parentElement !== record.element.parentElement) {
      record.control?.remove();
      const control = document.createElement("span");
      control.className = "dcf-bot-control";
      control.setAttribute("data-dcf-owned", "bot-comment");
      const label = document.createElement("span");
      label.className = "dcf-bot-label";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dcf-bot-toggle";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        record.revealed = !record.revealed;
        updateVisibility(record);
        notifyLayout();
      });
      const menuButton = document.createElement("button");
      menuButton.type = "button";
      menuButton.className = "dcf-bot-menu-toggle";
      menuButton.textContent = "필터";
      menuButton.setAttribute("aria-label", "이 댓글의 필터 설정");
      const panel = document.createElement("span");
      panel.className = "dcf-bot-menu";
      panel.id = `${record.id}-menu`;
      menuButton.setAttribute("aria-controls", panel.id);
      menuButton.addEventListener("click", (event) => {
        event.preventDefault();
        record.menuOpen = !record.menuOpen;
        updateMenu(record);
        notifyLayout();
      });
      const allowButton = document.createElement("button");
      allowButton.type = "button";
      allowButton.addEventListener("click", () => saveRule(record, record.allowed ? "removeAllow" : "allow"));
      const blockButton = document.createElement("button");
      blockButton.type = "button";
      blockButton.addEventListener("click", () => saveRule(record, record.example ? "removeBlock" : "block"));
      const status = document.createElement("span");
      status.className = "dcf-bot-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      panel.append(allowButton, blockButton, status);
      // The surrounding native comment body is also a reply click target.
      control.addEventListener("click", (event) => event.stopPropagation());
      control.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && record.menuOpen) {
          event.preventDefault();
          event.stopPropagation();
          record.menuOpen = false;
          updateMenu(record);
          menuButton.focus();
          notifyLayout();
        }
      });
      control.append(label, button, menuButton, panel);
      record.element.insertAdjacentElement("beforebegin", control);
      record.control = control;
      record.label = label;
      record.button = button;
      record.menuButton = menuButton;
      record.panel = panel;
      record.allowButton = allowButton;
      record.blockButton = blockButton;
      record.status = status;
      changed = true;
    }
    record.blocked = Boolean(result?.blocked);
    record.allowed = policy.matchesExact(record.fingerprint, settings.botCommentAllowlist);
    record.example = policy.matchesExact(record.fingerprint, settings.botCommentExamples);
    record.button.setAttribute("aria-controls", ensureTextId(record));
    const reason = Array.isArray(result?.reasons) && typeof result.reasons[0] === "string" ? result.reasons[0] : "정형적인 답변 패턴";
    const label = `봇 의심 댓글 · ${reason}`;
    if (record.label.textContent !== label) {
      record.label.textContent = label;
      changed = true;
    }
    record.label.hidden = !record.blocked;
    record.button.hidden = !record.blocked;
    record.control.classList.toggle("dcf-bot-plain", !record.blocked);
    updateMenu(record);
    return updateVisibility(record) || changed;
  }

  function updateMenu(record) {
    record.panel.hidden = !record.menuOpen;
    record.menuButton.setAttribute("aria-expanded", String(record.menuOpen));
    record.control.classList.toggle("dcf-bot-menu-open", record.menuOpen);
    record.allowButton.textContent = record.allowed ? "항상 표시 취소" : "이 문장은 항상 표시";
    record.blockButton.textContent = record.example ? "차단 예시에서 삭제" : "차단 예시로 추가";
    record.allowButton.disabled = record.pending;
    record.blockButton.disabled = record.pending;
  }

  function feedback(record, message) {
    if (record.control?.isConnected && record.menuOpen) {
      record.status.textContent = message;
      return;
    }
    // The site may replace a comment page while an async save is pending.
    const toast = document.createElement("div");
    toast.className = "dcf-bot-toast";
    toast.setAttribute("data-dcf-owned", "bot-comment");
    toast.setAttribute("role", "status");
    toast.textContent = message;
    (document.body || document.documentElement).append(toast);
    window.setTimeout(() => toast.remove(), 6000);
  }

  async function saveRule(record, action) {
    if (record.pending) return;
    const current = record.element.isConnected ? candidate(record.element) : null;
    if (!current || current.fingerprint !== record.fingerprint) {
      feedback(record, "댓글 내용이 바뀌었습니다. 다시 선택해 주세요.");
      scheduleScan();
      return;
    }
    const text = current.fingerprint;
    if (text.length > policy.MAX_TEMPLATE_LENGTH) {
      feedback(record, "600자 이하의 댓글만 문장 규칙으로 등록할 수 있습니다.");
      return;
    }
    if (action === "block" && policy.compactText(text).length < 8) {
      feedback(record, "너무 짧은 문장은 차단 예시로 등록할 수 없습니다. 문자·숫자 8자 이상이 필요합니다.");
      return;
    }
    record.pending = true;
    updateMenu(record);
    feedback(record, "저장 중…");
    try {
      await storage.updateCommentRule(text, action);
      await refreshSettings();
      feedback(record, ({ allow: "이 문장을 항상 표시합니다.", block: "차단 예시에 추가했습니다.", removeAllow: "항상 표시를 취소했습니다.", removeBlock: "차단 예시에서 삭제했습니다." })[action]);
      scheduleScan();
    } catch (error) {
      feedback(record, `저장하지 못했습니다. ${error?.message || "잠시 후 다시 시도해 주세요."}`);
    } finally {
      record.pending = false;
      if (record.control?.isConnected) updateMenu(record);
    }
  }

  function updateVisibility(record) {
    const collapsed = record.blocked && !record.revealed;
    const changed = record.element.classList.contains("dcf-bot-collapsed") !== collapsed;
    record.element.classList.toggle("dcf-bot-collapsed", collapsed);
    record.control.classList.toggle("dcf-bot-revealed", !collapsed);
    const label = collapsed ? "댓글 보기" : "다시 접기";
    if (record.button.textContent !== label) record.button.textContent = label;
    if (record.button.getAttribute("aria-expanded") !== String(!collapsed)) record.button.setAttribute("aria-expanded", String(!collapsed));
    return changed;
  }

  function restore(record) {
    const changed = Boolean(record.control || record.element.classList.contains("dcf-bot-collapsed"));
    record.element.classList.remove("dcf-bot-collapsed");
    record.control?.remove();
    record.control = null;
    record.label = null;
    record.button = null;
    if (record.ownedId && record.element.id === record.ownedId) record.element.removeAttribute("id");
    record.ownedId = null;
    return changed;
  }

  function notifyLayout() {
    document.dispatchEvent(new CustomEvent("dcf:bot-comments-layout"));
  }
})();
