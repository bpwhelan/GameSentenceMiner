function hitTestMagpiePointer(point, display, viewport, document) {
  const bounds = display?.physicalBounds;
  const size = display?.physicalSize;
  if (!bounds || !(size?.width > 0 && size?.height > 0)) return false;
  const x = (point.x - bounds.x) / size.width * viewport.innerWidth;
  const y = (point.y - bounds.y) / size.height * viewport.innerHeight;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.innerWidth || y >= viewport.innerHeight) return false;
  // elementFromPoint honors display, visibility, pointer-events, clipping and
  // occlusion. Don't use OCR bounds: font fitting/offsets may have changed them.
  const target = document.elementFromPoint(x, y);
  return !!target?.closest('.interactive, .text-box, .nav-char-box, button, input, select, textarea, a[href]');
}

module.exports = { hitTestMagpiePointer };
