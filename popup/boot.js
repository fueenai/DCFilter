// Loaded synchronously in <head>, before popup.css paints: replay the theme
// and accent the popup last showed for saved settings, so a dark popup never
// opens white while popup.js waits for chrome.storage.
try {
  const last = JSON.parse(localStorage.getItem("dcf:popup-theme") || "null");
  if (last) {
    document.documentElement.dataset.theme = last.theme === "dark" ? "dark" : "light";
    if (/^#[0-9a-f]{6}$/i.test(last.accent)) document.documentElement.style.setProperty("--popup-accent", last.accent);
  }
} catch (_error) {
  // No cache yet: popup.js applies the theme as soon as settings load.
}
