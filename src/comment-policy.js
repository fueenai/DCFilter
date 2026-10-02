"use strict";

// Local, explainable text rules. Scores describe matching rules, not the
// probability that a person is a bot. No model, network, or DOM is involved.
(function (root) {
  const MAX_TEXT_LENGTH = 12000;
  const MAX_TEMPLATES = 100;
  const MAX_TEMPLATE_LENGTH = 600;

  function clipText(text, limit) {
    let clipped = text.slice(0, limit);
    if (/[\uD800-\uDBFF]$/.test(clipped)) clipped = clipped.slice(0, -1);
    return clipped;
  }

  function cleanText(text) {
    if (typeof text !== "string") return "";
    return clipText(clipText(text, MAX_TEXT_LENGTH).normalize("NFKC"), MAX_TEXT_LENGTH)
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "")
      .replace(/\r\n?/g, "\n").toLowerCase();
  }

  function normalizeText(text) {
    return cleanText(text).replace(/\s+/g, " ").trim();
  }

  function compactText(text) {
    return normalizeText(text).replace(/[^\p{L}\p{N}]/gu, "");
  }

  function unquotedText(text) {
    return text
      .replace(/```[\s\S]*?(?:```|$)/g, " ")
      .replace(/~~~[\s\S]*?(?:~~~|$)/g, " ")
      .replace(/^\s*>[^\n]*/gm, " ")
      .replace(/`[^`\n]*`/g, " ")
      .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』/g, " ")
      .replace(/(^|\s)'[^'\n]{2,2000}'(?=\s|[.,!?]|$)/g, "$1 ");
  }

  function isDiscussion(text) {
    return /(?:예시|인용|프롬프트|출력\s*예|quote|example|prompt)\s*[:：]/i.test(text) ||
      /(?:챗\s*gpt|챗지피티|chatgpt|llm|ai\s*모델|언어\s*모델)(?:\s*(?:이|가|의|에서|한테|에게)\s*[^.!?\n]{0,100}(?:답|응답|말|출력|프롬프트)|\s*(?:답변|응답|말투|출력|프롬프트))/i.test(text) ||
      /(?:chatgpt|language model|llm|assistant)[^.!?\n]{0,80}\b(?:said|says|replied|response|prompt|output|example|quoted)\b/i.test(text) ||
      /(?:봇|ai|인공지능)\s*(?:댓글|답변|말투)\s*(?:예시|특징|같|인지|구분|판별|패턴)/i.test(text) ||
      /(?:라는|라고)\s*(?:댓글|답변|문장|표현|말|썼|적었|써\s*있|했|하더)/.test(text);
  }

  // Only known style changes are tolerated. General edit-distance matching
  // would also match small, meaning-changing edits such as "있어" -> "없어".
  function templateStyle(text) {
    return normalizeText(text)
      .replace(/(^|\s)(?:진짜|정말)(?=\s)/g, "$1")
      .replace(/찜찜/g, "찝찝")
      .replace(/요(?=[.!?~。！？\s]*$)/g, "")
      .replace(/(^|\s)맞아요(?=[.,!\s])/g, "$1맞아")
      .replace(/[^\p{L}\p{N}]/gu, "");
  }

  function findTemplate(text, templates) {
    if (!Array.isArray(templates) || text.length > MAX_TEMPLATE_LENGTH) return null;
    const compact = compactText(text);
    const styled = templateStyle(text);
    if (compact.length < 8) return null;
    for (const item of templates.slice(0, MAX_TEMPLATES)) {
      if (typeof item !== "string" || item.length > MAX_TEMPLATE_LENGTH) continue;
      const candidate = compactText(item);
      if (candidate.length < 8) continue;
      if (compact === candidate) return "등록한 봇 댓글 예시와 문장 전체가 일치";
      if (compact.length >= 16 && candidate.length >= 16 && styled === templateStyle(item)) {
        return "등록한 봇 댓글 예시와 문장 구성이 거의 동일";
      }
    }
    return null;
  }

  function matchesExact(text, list) {
    // Compare the entire sentence. A longer comment must never inherit an
    // exception from its truncated prefix or from the unquoted portion alone.
    if (typeof text !== "string" || text.length > MAX_TEMPLATE_LENGTH || !Array.isArray(list)) return false;
    const normalized = normalizeText(text);
    return Boolean(normalized && list.slice(0, MAX_TEMPLATES).some((item) =>
      typeof item === "string" && item.length <= MAX_TEMPLATE_LENGTH && normalizeText(item) === normalized
    ));
  }

  function analyze(text, options = {}) {
    options = options && typeof options === "object" ? options : {};
    const cleaned = cleanText(text);
    const normalized = normalizeText(cleaned);
    const result = { hide: false, score: 0, reasons: [], normalized };
    const fullText = typeof options.fullText === "string" ? options.fullText : text;
    if (matchesExact(fullText, options.allowlist)) return { ...result, allowed: true };
    // A deliberately registered complete sentence is explicit user intent,
    // including a quotation or an AI discussion. Similarity rules below retain
    // their quotation/discussion safeguards.
    if (compactText(fullText).length >= 8 && matchesExact(fullText, options.templates)) {
      return { ...result, hide: true, score: 10, reasons: ["등록한 봇 댓글 예시와 문장 전체가 일치"] };
    }
    if (!normalized || isDiscussion(cleaned)) return result;
    const body = unquotedText(cleaned).replace(/\s+/g, " ").trim();
    if (!body) return result;

    // Match the entire original comment. Quoting the example and discussing it
    // must not count as posting it, even when removing quotes leaves a match.
    if (compactText(body) === compactText(cleaned)) {
      const reason = findTemplate(normalized, options.templates);
      if (reason) return { ...result, hide: true, score: 10, reasons: [reason] };
    }
    if (body.length < 45) return result;

    const signals = [];
    const add = (condition, score, reason, kind) => {
      if (condition) signals.push({ score, reason, kind });
    };
    add(/(?:저는|나는|제가)\s*(?:ai|인공지능)\s*(?:입니다|예요|이라|로서|이므로|이기|인데|이고|이며)|(?:ai|인공지능)\s*(?:언어\s*모델|어시스턴트|비서)(?:로서|입니다|이며|이므로)|\bas an ai(?:\s+language model|\s+assistant)?(?=\s*[,.;:!?]|\s+(?:i|my)\b|$)|\bi(?: am|'m) an (?:ai(?:\s+language model|\s+assistant)?|artificial intelligence)(?=\s*[,.;:!?]|\s+(?:and|trained|developed)\b|$)/.test(body), 4,
      "AI 도우미를 자칭하는 문구", "identity");
    add(/개인적인?\s*(?:의견|감정|경험)[^.!?]{0,45}(?:없|않)|(?:감정|경험)을\s*(?:갖고|가지고)\s*있지\s*않|\bi (?:do not|don't) have (?:personal |any )?(?:opinions|feelings|experiences)\b/.test(body), 3,
      "도우미의 감정·경험 제한을 설명하는 상투 문구", "limitation");
    add(/(?:추가(?:적인)?\s*질문|더\s*궁금한\s*점)[^.!?]{0,55}(?:언제든|말씀|알려\s*주세요)|무엇을\s*도와드릴까요|도움이\s*(?:되었|됐|되셨|되길)[^.!?]{0,25}(?:바랍|좋겠)|\b(?:let me know if you (?:have|need)|feel free to (?:ask|reach out)|i hope (?:this|that) helps)\b/.test(body), 3,
      "추가 질문을 유도하는 도우미식 마무리", "service");
    add(/(?:정말\s*|참\s*|아주\s*)?(?:좋은|훌륭한|유익한|흥미로운)\s*(?:글|정보|내용|게시글|질문|주제|정리)|(?:인상\s*깊은|좋은)\s*인사이트|\b(?:great|excellent|insightful|interesting|valuable)\s+(?:post|question|topic|insights?|information|content)\b/.test(body), 2,
      "내용을 특정하지 않는 일반적인 칭찬", "praise");
    add(/(?:여러분|다른\s*분들|다들)(?:은|의)?[^.!?]{0,50}(?:생각|의견|경험)[^.!?]{0,35}(?:어떠|어떤|궁금|공유|들려|남겨)|(?:생각|의견|경험)을\s*(?:댓글로\s*)?(?:공유해|들려|남겨)|\b(?:what do you (?:all )?think|share your (?:thoughts|opinions|experiences)|would love to hear your)\b/.test(body), 2,
      "일반적인 의견 공유를 유도하는 문구", "engagement");
    add(/다양한\s*(?:관점|측면)[^.!?]{0,55}(?:고려|생각|살펴|이해)|(?:균형\s*잡힌|종합적인)\s*(?:시각|접근|관점|이해)|(?:장점과\s*단점|긍정적인\s*측면과\s*부정적인\s*측면)[^.!?]{0,40}(?:고려|균형|존재)|\b(?:balanced perspective|various perspectives|holistic approach|both advantages and disadvantages)\b/.test(body), 2,
      "구체적인 대상을 생략한 포괄적인 설명", "generic");
    add(/(?:결론적으로|종합해\s*보면|요약하자면|정리하자면|in conclusion|in summary|to summarize)/.test(body), 1,
      "정형화된 요약·결론 문구", "summary");
    add((unquotedText(cleaned).match(/^\s*(?:\d{1,2}[.)]|[-*])\s+\S/gm) || []).length >= 2, 1,
      "여러 항목으로 나눈 정형화된 답변", "structure");
    const promptStart = /<\|(?:im_start|start_header_id)\|>\s*assistant/.test(body);
    add(promptStart, 4, "도우미 역할을 나타내는 출력 토큰", "promptStart");
    add(promptStart && /<\|(?:im_end|eot_id)\|>/.test(body), 4,
      "도우미 답변의 시작·종료 토큰이 함께 노출됨", "promptEnd");

    const strict = options.sensitivity === "strict";
    const requiredRepeats = strict ? 2 : 3;
    const repeats = Number.isInteger(options.duplicateCount) ? options.duplicateCount : 0;
    const authors = Number.isInteger(options.distinctAuthors) ? options.distinctAuthors : 0;
    const hasStyleSignal = signals.some(signal => !["structure", "summary"].includes(signal.kind));
    const repeated = body.length >= 60 && hasStyleSignal && repeats >= requiredRepeats && authors >= requiredRepeats;
    add(repeated, 5, "여러 작성자가 같은 긴 상투 문구를 반복", "repetition");
    result.score = signals.reduce((total, signal) => total + signal.score, 0);
    result.reasons = signals.map(signal => signal.reason);
    const strong = signals.some(signal => ["identity", "promptStart", "repetition"].includes(signal.kind));
    result.hide = result.score >= (strict ? 6 : 7) && signals.length >= (strong ? 2 : 3);
    return result;
  }

  function analyzeComments(comments, options = {}) {
    if (!Array.isArray(comments)) return [];
    const groups = new Map();
    const entries = comments.map(comment => {
      const entry = comment && typeof comment === "object" ? comment : {};
      const key = compactText(entry.text);
      let group = groups.get(key);
      if (!group) groups.set(key, group = { count: 0, authors: new Set() });
      group.count++;
      const author = typeof entry.authorKey === "string" ? entry.authorKey.trim() : "";
      if (author) group.authors.add(author);
      return { entry, group };
    });
    return entries.map(({ entry, group }) => {
      const result = analyze(entry.text, { ...options, fullText: entry.fullText ?? entry.text, duplicateCount: group.count, distinctAuthors: group.authors.size });
      return { id: entry.id, blocked: result.hide, allowed: Boolean(result.allowed), score: result.score, reasons: result.reasons };
    });
  }

  const api = Object.freeze({ analyze, analyzeComments, normalizeText, compactText, matchesExact, MAX_TEXT_LENGTH, MAX_TEMPLATE_LENGTH });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    root.DCFBotPolicy = api;
    root.DCFilterCommentPolicy = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
