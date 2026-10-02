"use strict";
importScripts("storage.js", "comment-policy.js");

// Serialize comment edits across tabs; each operation reads the latest rules.
let commentWrites = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "dcf:comment-rule") return false;
  commentWrites = commentWrites.then(async () => {
    const { text, action } = message;
    if (typeof text !== "string" || text.length > 600 || !["allow", "block", "removeAllow", "removeBlock"].includes(action)) throw new Error("댓글은 1~600자 전체 문장으로 등록하세요.");
    const normalized = DCFBotPolicy.normalizeText(text);
    if (!normalized || normalized.length > 600) throw new Error("댓글은 1~600자 전체 문장으로 등록하세요.");
    if (action === "block" && normalized.replace(/[^\p{L}\p{N}]/gu, "").length < 8) throw new Error("차단 예시는 글자·숫자 8자 이상으로 등록하세요.");
    const settings = await DCFilterStorage.loadGlobalSettings();
    const same = item => DCFBotPolicy.normalizeText(item) === normalized;
    let allowed = settings.botCommentAllowlist;
    let examples = settings.botCommentExamples;
    if (action === "allow" || action === "removeAllow" || action === "block") allowed = allowed.filter(item => !same(item));
    if (action === "block" || action === "removeBlock" || action === "allow") examples = examples.filter(item => !same(item));
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (action === "allow") allowed.push(cleaned);
    if (action === "block") examples.push(cleaned);
    if (allowed.length > 100 || examples.length > 100) throw new Error("댓글 규칙은 목록마다 100개까지 저장할 수 있습니다. 설정에서 기존 항목을 지워 주세요.");
    await DCFilterStorage.savePatch({ botCommentAllowlist: allowed, botCommentExamples: examples });
    respond({ ok: true });
  }).catch(error => respond({ ok: false, error: error.message || "댓글 규칙을 저장하지 못했습니다." }));
  return true;
});
