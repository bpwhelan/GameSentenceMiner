function magpiePointerToViewport(point, display, viewport) {
  const bounds = display?.physicalBounds;
  const size = display?.physicalSize;
  if (!bounds || !(size?.width > 0 && size?.height > 0)) return null;
  const x = (point.x - bounds.x) / size.width * viewport.innerWidth;
  const y = (point.y - bounds.y) / size.height * viewport.innerHeight;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.innerWidth || y >= viewport.innerHeight) return null;
  return { ...point, x, y };
}

module.exports = { magpiePointerToViewport };
