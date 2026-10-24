/* global window, document */
// Runs before first paint (CSP: script-src 'self', so this is a file, not inline).
(function () {
  try {
    var t = window.localStorage.getItem("acs-theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch {
    /* storage unavailable: fall back to the system preference via CSS */
  }
})();
