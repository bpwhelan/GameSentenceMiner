function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getRect(rect) {
  if (!rect || typeof rect !== 'object') return null;

  const x = toFiniteNumber(rect.x);
  const y = toFiniteNumber(rect.y);
  const width = toFiniteNumber(rect.width);
  const height = toFiniteNumber(rect.height);
  if (x === null || y === null || !(width > 0) || !(height > 0)) return null;

  return { x, y, width, height };
}

function getLegacyViewportRect(x1, y1, x3, y3, offsetX, offsetY, viewportWidth, viewportHeight) {
  const left = ((x1 + offsetX) / 100) * viewportWidth;
  const top = ((y1 + offsetY) / 100) * viewportHeight;
  const right = ((x3 + offsetX) / 100) * viewportWidth;
  const bottom = ((y3 + offsetY) / 100) * viewportHeight;
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    usedFallback: true,
  };
}

function hasPlausibleOverlayBounds(displayBounds, overlayWindowBounds) {
  // Accept up to a 2x size mismatch because a stale scale-factor conversion can
  // briefly report half/double DIP geometry during monitor transitions. Anything
  // beyond that cannot be GSM's full-display overlay and is safer to reject.
  const widthRatio = overlayWindowBounds.width / displayBounds.width;
  const heightRatio = overlayWindowBounds.height / displayBounds.height;
  if (widthRatio < 0.5 || widthRatio > 2 || heightRatio < 0.5 || heightRatio > 2) {
    return false;
  }

  return (
    overlayWindowBounds.x < displayBounds.x + displayBounds.width &&
    overlayWindowBounds.x + overlayWindowBounds.width > displayBounds.x &&
    overlayWindowBounds.y < displayBounds.y + displayBounds.height &&
    overlayWindowBounds.y + overlayWindowBounds.height > displayBounds.y
  );
}

function shouldUseWindowRelativeCoordinateMapping(displayInfo) {
  return !!displayInfo &&
    displayInfo.xwaylandOverlayFeatures === true &&
    displayInfo.coordinateMapping === 'linux-x11-window';
}

/**
 * Maps screen-relative OCR percentages to renderer viewport CSS pixels.
 *
 * Electron `Display.bounds` and `BrowserWindow.getBounds()` are both DIP
 * rectangles. `window.innerWidth`/`innerHeight` are renderer CSS/DIP pixels,
 * so desktop coordinates can be converted directly and then scaled by the
 * actual viewport-to-window ratio as a defensive guard for any mismatch.
 */
function mapPercentBoundsToViewport(options = {}) {
  const x1 = toFiniteNumber(options.x1);
  const y1 = toFiniteNumber(options.y1);
  const x3 = toFiniteNumber(options.x3);
  const y3 = toFiniteNumber(options.y3);
  const offsetX = toFiniteNumber(options.offsetX) || 0;
  const offsetY = toFiniteNumber(options.offsetY) || 0;
  const viewportWidth = toFiniteNumber(options.viewportWidth);
  const viewportHeight = toFiniteNumber(options.viewportHeight);

  if (
    x1 === null || y1 === null || x3 === null || y3 === null ||
    !(viewportWidth > 0) || !(viewportHeight > 0)
  ) {
    return null;
  }

  const fallback = getLegacyViewportRect(x1, y1, x3, y3, offsetX, offsetY, viewportWidth, viewportHeight);
  if (!shouldUseWindowRelativeCoordinateMapping(options.displayInfo)) {
    return fallback;
  }
  const displayBounds = getRect(options.displayInfo && options.displayInfo.bounds);
  const overlayWindowBounds = getRect(options.displayInfo && options.displayInfo.overlayWindowBounds);
  if (!displayBounds || !overlayWindowBounds || !hasPlausibleOverlayBounds(displayBounds, overlayWindowBounds)) {
    return fallback;
  }

  const scaleX = viewportWidth / overlayWindowBounds.width;
  const scaleY = viewportHeight / overlayWindowBounds.height;
  const toLocalX = (percent) => (
    (((percent / 100) * displayBounds.width) + displayBounds.x - overlayWindowBounds.x) * scaleX
  );
  const toLocalY = (percent) => (
    (((percent / 100) * displayBounds.height) + displayBounds.y - overlayWindowBounds.y) * scaleY
  );

  const left = toLocalX(x1 + offsetX);
  const top = toLocalY(y1 + offsetY);
  const right = toLocalX(x3 + offsetX);
  const bottom = toLocalY(y3 + offsetY);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    usedFallback: false,
  };
}

module.exports = {
  getLegacyViewportRect,
  mapPercentBoundsToViewport,
  shouldUseWindowRelativeCoordinateMapping,
};
