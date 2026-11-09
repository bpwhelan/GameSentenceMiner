// SPDX-License-Identifier: GPL-3.0-or-later
import { DEBUG_LOG, formatDebugErrorReport, recordUserError } from "./debug-log.js";

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
  if (globalThis.HDReaderOptions.popupRenderer(resolvedTheme) !== "default") resolvedTheme = "default";
  document.documentElement.dataset.hoshidictsTheme = resolvedTheme;
}

const STATUS_CLASSES = {
  working: "is-working",
  ready: "is-ready",
  error: "is-error",
};

const COPY_LABEL = "Copy error details";
const COPY_FEEDBACK_MS = 2000;
const errorCopies = new WeakMap();

async function copyErrorDetails(copy) {
  const { button, entry } = copy;
  const window = button.ownerDocument.defaultView;
  const log = window[DEBUG_LOG];
  let label = "Copied";
  try {
    await window.navigator.clipboard.writeText(formatDebugErrorReport(log, entry, { userAgent: window.navigator.userAgent }));
  } catch (error) {
    log.record("warn", "could not copy error details:", error);
    label = "Could not copy";
  }
  button.textContent = label;
  window.clearTimeout(copy.timer);
  copy.timer = window.setTimeout(() => { button.textContent = COPY_LABEL; }, COPY_FEEDBACK_MS);
}

// While `output` shows the error kept as `entry`, a "Copy error details"
// button after `anchor` puts it on the clipboard with its stack and what the
// page did before it (debug-log.js). A null entry hides the button.
export function showErrorCopy(output, entry, anchor = output) {
  let copy = errorCopies.get(output);
  if (!copy) {
    if (entry === null) return;
    const button = output.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "ghost copy-error-details";
    button.textContent = COPY_LABEL;
    if (output.id) button.setAttribute("aria-describedby", output.id);
    copy = { button, entry, timer: null };
    button.addEventListener("click", () => { void copyErrorDetails(copy); });
    anchor.after(button);
    errorCopies.set(output, copy);
  }
  copy.entry = entry;
  const hide = entry === null;
  // Hiding the focused button would drop keyboard focus to the page. Give it to
  // the status the button described, which now says what changed.
  if (hide && !copy.button.hidden && copy.button.ownerDocument.activeElement === copy.button) {
    if (!output.hasAttribute("tabindex")) output.tabIndex = -1;
    output.focus({ preventScroll: true });
  }
  copy.button.hidden = hide;
}

// An error is kept in the page's debug log once, when it is first shown;
// `error` is what it describes, for its stack and cause.
export function setStatusOutput(output, message, tone, error = null) {
  const shown = output.textContent === message && output.classList.contains(STATUS_CLASSES.error);
  if (output.textContent !== message) output.textContent = message;
  for (const [state, className] of Object.entries(STATUS_CLASSES)) {
    const enabled = tone === state;
    if (output.classList.contains(className) !== enabled) output.classList.toggle(className, enabled);
  }
  if (tone !== "error") showErrorCopy(output, null);
  else if (!shown) showErrorCopy(output, recordUserError(output.ownerDocument.defaultView, output.id, message, error));
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
