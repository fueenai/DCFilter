(function () {
  "use strict";
  const api = window.DCFImageAllowlist;
  const count = document.getElementById("allowedImageCount");
  const clear = document.getElementById("clearAllowedImages");
  let busy = false;
  async function render() {
    try {
      const entries = await api.list();
      count.textContent = `${entries.length}개 · 이 브라우저에만 저장 · 최대 ${api.MAX_ENTRIES || 500}개`;
      clear.disabled = busy || !entries.length;
    } catch (_error) { count.textContent = "허용 목록을 읽지 못했습니다."; clear.disabled = true; }
  }
  clear.addEventListener("click", async () => {
    if (busy || !window.confirm("직접 허용한 이미지의 항상 보기를 모두 취소할까요? 다음 검사부터 다시 판별합니다.")) return;
    busy = true; clear.disabled = true;
    try { await api.clear(); } catch (_error) { count.textContent = "허용 목록을 지우지 못했습니다. 다시 시도해 주세요."; }
    finally { busy = false; await render(); }
  });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && api.isChange(changes)) render(); });
  render();
})();
