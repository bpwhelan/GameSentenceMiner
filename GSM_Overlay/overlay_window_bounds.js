function normalizeDisplayBounds(display) {
  const bounds = (display && display.bounds) || { x: 0, y: 0, width: 1920, height: 1080 };
  return {
    x: Math.floor(Number(bounds.x) || 0),
    y: Math.floor(Number(bounds.y) || 0),
    width: Math.max(1, Math.floor(Number(bounds.width) || 0)),
    height: Math.max(1, Math.floor(Number(bounds.height) || 0)),
  };
}

function getOverlayWindowBoundsForDisplay(display, options = {}) {
  const bounds = normalizeDisplayBounds(display);
  if (options.fullDisplayBounds) {
    return bounds;
  }

  return {
    ...bounds,
    height: bounds.height > 1 ? bounds.height - 1 : bounds.height,
  };
}

function getOverlayWindowBoundsForCapability(display, capabilityEnabled) {
  return getOverlayWindowBoundsForDisplay(display, {
    fullDisplayBounds: capabilityEnabled === true,
  });
}

module.exports = {
  getOverlayWindowBoundsForCapability,
  getOverlayWindowBoundsForDisplay,
};
