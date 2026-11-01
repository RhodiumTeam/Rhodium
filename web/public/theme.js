// The theme chosen on this device (#286), set before the page is drawn, so it never shows the other
// first: a plain script in the head, as the page runs no inline script. web/src/common.tsx has the rest.
try {
  var theme = localStorage.getItem("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch (e) {}
