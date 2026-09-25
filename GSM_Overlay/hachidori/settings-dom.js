// SPDX-License-Identifier: GPL-3.0-or-later
const PAGE_THEMES = new WeakMap();

export function applyPageTheme(document, options) {
  let state = PAGE_THEMES.get(document);
  if (!state) {
    const media = document.defaultView?.matchMedia?.("(prefers-color-scheme: dark)")
      ?? { matches: false, addEventListener() {} };
    state = { media, theme: options.popupTheme };
    media.addEventListener("change", () => {
      if (state.theme === "auto") document.documentElement.dataset.hoshidictsTheme = media.matches ? "dark" : "light";
    });
    PAGE_THEMES.set(document, state);
  }
  state.theme = options.popupTheme;
  let resolvedTheme = state.theme;
  if (resolvedTheme === "auto") resolvedTheme = state.media.matches ? "dark" : "light";
  document.documentElement.dataset.hoshidictsTheme = resolvedTheme;
}

const STATUS_CLASSES = {
  working: "is-working",
  ready: "is-ready",
  error: "is-error",
};

export function setStatusOutput(output, message, tone) {
  if (output.textContent !== message) output.textContent = message;
  for (const [state, className] of Object.entries(STATUS_CLASSES)) {
    const enabled = tone === state;
    if (output.classList.contains(className) !== enabled) output.classList.toggle(className, enabled);
  }
}

export function reorderSettingsRows(container, ordered) {
  if (ordered.length === container.children.length && ordered.every((row, index) => container.children[index] === row)) return;
  const focused = ordered.find(row => row.contains(container.ownerDocument.activeElement));
  const focusIndex = ordered.indexOf(focused);
  ordered.forEach((row, index) => {
    if (focused && index < focusIndex) focused.before(row);
    else if (row !== focused) container.append(row);
  });
}
