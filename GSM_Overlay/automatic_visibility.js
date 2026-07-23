const SHOWABLE_WINDOW_STATES = new Set(["active", "background"]);
const OUTPUT_ONLY_WINDOW_STATES = new Set(["unknown", ...SHOWABLE_WINDOW_STATES]);
const STARTUP_HIDDEN_WINDOW_STATES = new Set(["obscured", "minimized", "closed"]);

function shouldShowOverlayOnReady(options = {}) {
  if (options.hideOverlayOnStartup === true) {
    return false;
  }

  const windowState = String(options.windowState || "unknown").trim().toLowerCase();
  return !STARTUP_HIDDEN_WINDOW_STATES.has(windowState);
}

function shouldRevealAutomaticOverlay(options = {}) {
  if (options.manualMode || options.texthookerMode) {
    return false;
  }

  const windowState = String(options.windowState || "unknown").trim().toLowerCase();
  if (SHOWABLE_WINDOW_STATES.has(windowState)) {
    return true;
  }

  return options.outputAvailable === true && OUTPUT_ONLY_WINDOW_STATES.has(windowState);
}

module.exports = {
  shouldShowOverlayOnReady,
  shouldRevealAutomaticOverlay,
};
