// SPDX-License-Identifier: GPL-3.0-or-later
export function applyPageTheme(document, options) {
  document.documentElement.dataset.hoshidictsTheme = options.popupTheme;
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
