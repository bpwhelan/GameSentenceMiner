// Partial desktop coverage uses the existing window-state and display-info buses.
// No observer or polling: the renderer also refreshes after creating OCR/notation.
(() => {
  const hiddenClass = 'gsm-window-occluded';
  const selectors = '.text-box, .nav-char-box, .big-interactive-area, .line-box, '
    + '.recycled-indicator, .furigana-box, .gsm-jiten-hl, .block-translation, '
    + '#translation-display:not(:has(.block-translation))';
  const style = document.createElement('style');
  style.textContent = `.${hiddenClass} { visibility: hidden !important; pointer-events: none !important; user-select: none !important; }`;
  document.head.appendChild(style);

  let displayInfo = null;
  let physicalRects = [];
  let viewportRects = [];
  let signature = '';
  const hiddenElements = new Set();

  function refresh(root = document) {
    // The usual uncovered case doesn't even query the DOM or read layout.
    if (viewportRects.length === 0) {
      for (const node of hiddenElements) node.classList.remove(hiddenClass);
      hiddenElements.clear();
      return;
    }
    for (const node of hiddenElements) {
      if (!node.isConnected) hiddenElements.delete(node);
    }
    // Batch every geometry read before changing styles to avoid layout thrashing.
    const changes = [];
    for (const node of root.querySelectorAll(selectors)) {
      const rect = node.getBoundingClientRect();
      const covered = rect.right > rect.left && rect.bottom > rect.top
        && viewportRects.some(cover => rect.left < cover.right && rect.right > cover.left
          && rect.top < cover.bottom && rect.bottom > cover.top);
      if (covered !== node.classList.contains(hiddenClass)) changes.push({ node, covered });
    }
    let coveredHover = false;
    for (const { node, covered } of changes) {
      if (covered && node.matches(':hover')) coveredHover = true;
      node.classList.toggle(hiddenClass, covered);
      if (covered) hiddenElements.add(node);
      else hiddenElements.delete(node);
    }
    if (coveredHover) window.dispatchEvent(new CustomEvent('gsm-occluded-hover'));
  }

  function remap() {
    const bounds = displayInfo?.physicalBounds;
    const nextSignature = JSON.stringify([physicalRects, bounds, window.innerWidth, window.innerHeight]);
    if (nextSignature === signature) return;
    signature = nextSignature;
    viewportRects = [];
    if (bounds?.width > 0 && bounds?.height > 0) {
      const scaleX = window.innerWidth / bounds.width;
      const scaleY = window.innerHeight / bounds.height;
      viewportRects = physicalRects.map(rect => ({
        left: (rect.left - bounds.x) * scaleX,
        top: (rect.top - bounds.y) * scaleY,
        right: (rect.right - bounds.x) * scaleX,
        bottom: (rect.bottom - bounds.y) * scaleY,
      })).filter(rect => rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight);
    }
    refresh();
  }

  window.GSMWindowOcclusion = {
    update(payload) {
      physicalRects = (Array.isArray(payload?.occlusion_rects) ? payload.occlusion_rects : [])
        .filter(rect => rect && [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)
          && rect.right > rect.left && rect.bottom > rect.top);
      remap();
    },
    setDisplayInfo(info) { displayInfo = info; remap(); },
    refresh,
  };
  window.addEventListener('gsm-window-state-update', event => window.GSMWindowOcclusion.update(event.detail));
  window.addEventListener('resize', remap);
})();
