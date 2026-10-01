const SHOWABLE_WINDOW_STATES = new Set(["active", "background"]);

function shouldShowOverlayOnReady(options = {}) {
  if (options.hideOverlayOnStartup === true) {
    return false;
  }

  const windowState = String(options.windowState || "unknown").trim().toLowerCase();
  return SHOWABLE_WINDOW_STATES.has(windowState);
}

function shouldRevealAutomaticOverlay(options = {}) {
  if (options.manualMode || options.texthookerMode) {
    return false;
  }

  const windowState = String(options.windowState || "unknown").trim().toLowerCase();
  return SHOWABLE_WINDOW_STATES.has(windowState);
}

module.exports = {
  shouldShowOverlayOnReady,
  shouldRevealAutomaticOverlay,
};
