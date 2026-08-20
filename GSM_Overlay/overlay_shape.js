const INTERACTIVE_ELEMENT_SELECTOR = [
  ".interactive",
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[role='button']",
  "iframe.yomitan-popup",
  "yomitan-popup-tag-name",
].join(", ");

function buildShapeRects(rects, options = {}) {
  const padding = Number.isFinite(options.padding) ? options.padding : 0;
  const viewportWidth = Number.isFinite(options.viewportWidth) ? options.viewportWidth : Infinity;
  const viewportHeight = Number.isFinite(options.viewportHeight) ? options.viewportHeight : Infinity;
  const shapes = [];
  const seen = new Set();

  for (const rect of rects) {
    if (!rect) continue;
    const rawLeft = Number(rect.left ?? rect.x);
    const rawTop = Number(rect.top ?? rect.y);
    const rawRight = Number(rect.right ?? (rect.x + rect.width));
    const rawBottom = Number(rect.bottom ?? (rect.y + rect.height));
    if (![rawLeft, rawTop, rawRight, rawBottom].every(Number.isFinite) || rawRight <= rawLeft || rawBottom <= rawTop) {
      continue;
    }

    const left = Math.max(0, Math.floor(rawLeft - padding));
    const top = Math.max(0, Math.floor(rawTop - padding));
    const right = Math.min(viewportWidth, Math.ceil(rawRight + padding));
    const bottom = Math.min(viewportHeight, Math.ceil(rawBottom + padding));
    if (right <= left || bottom <= top) {
      continue;
    }

    const shape = { x: left, y: top, width: right - left, height: bottom - top };
    const signature = `${shape.x}:${shape.y}:${shape.width}:${shape.height}`;
    if (!seen.has(signature)) {
      seen.add(signature);
      shapes.push(shape);
    }
  }

  return shapes;
}

function pointIntersectsRegions(point, windowBounds, regions) {
  if (!point || !windowBounds || !Array.isArray(regions)) return false;
  const localX = Number(point.x) - Number(windowBounds.x);
  const localY = Number(point.y) - Number(windowBounds.y);
  if (![localX, localY].every(Number.isFinite)) return false;

  return regions.some((region) => {
    if (!region) return false;
    const x = Number(region.x);
    const y = Number(region.y);
    const width = Number(region.width);
    const height = Number(region.height);
    return [x, y, width, height].every(Number.isFinite) &&
      width > 0 && height > 0 &&
      localX >= x && localX < x + width &&
      localY >= y && localY < y + height;
  });
}

function shouldIgnoreOverlayMouseEvents(options = {}) {
  if (!options.windowVisible || !options.interactionAllowed) return true;
  return !pointIntersectsRegions(
    options.cursorPoint,
    options.windowBounds,
    options.regions
  );
}

module.exports = {
  INTERACTIVE_ELEMENT_SELECTOR,
  buildShapeRects,
  pointIntersectsRegions,
  shouldIgnoreOverlayMouseEvents,
};
