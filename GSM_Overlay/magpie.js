const MAGPIE_SOURCE_KEYS = Object.freeze({
  left: "sourceWindowLeftEdgePosition",
  top: "sourceWindowTopEdgePosition",
  right: "sourceWindowRightEdgePosition",
  bottom: "sourceWindowBottomEdgePosition",
});

const MAGPIE_DESTINATION_KEYS = Object.freeze({
  left: "magpieWindowLeftEdgePosition",
  top: "magpieWindowTopEdgePosition",
  right: "magpieWindowRightEdgePosition",
  bottom: "magpieWindowBottomEdgePosition",
});

function toFiniteNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeRect(rawInfo, keys) {
  const left = toFiniteNumber(rawInfo[keys.left]);
  const top = toFiniteNumber(rawInfo[keys.top]);
  const right = toFiniteNumber(rawInfo[keys.right]);
  const bottom = toFiniteNumber(rawInfo[keys.bottom]);

  if (left === null || top === null || right === null || bottom === null) {
    return null;
  }

  if (right <= left || bottom <= top) {
    return null;
  }

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function buildMagpieSignature(sourceRect, destinationRect) {
  return [
    sourceRect.left,
    sourceRect.top,
    sourceRect.right,
    sourceRect.bottom,
    destinationRect.left,
    destinationRect.top,
    destinationRect.right,
    destinationRect.bottom,
  ].join(":");
}

function normalizeMagpieInfo(rawInfo) {
  if (!rawInfo || typeof rawInfo !== "object") {
    return null;
  }

  const sourceRect = normalizeRect(rawInfo, MAGPIE_SOURCE_KEYS);
  const destinationRect = normalizeRect(rawInfo, MAGPIE_DESTINATION_KEYS);
  if (!sourceRect || !destinationRect) {
    return null;
  }

  return {
    source_hwnd: toFiniteNumber(rawInfo.source_hwnd),
    scaling_hwnd: toFiniteNumber(rawInfo.scaling_hwnd),
    windowed: rawInfo.windowed === true,
    magpieWindowTopEdgePosition: destinationRect.top,
    magpieWindowBottomEdgePosition: destinationRect.bottom,
    magpieWindowLeftEdgePosition: destinationRect.left,
    magpieWindowRightEdgePosition: destinationRect.right,
    sourceWindowLeftEdgePosition: sourceRect.left,
    sourceWindowTopEdgePosition: sourceRect.top,
    sourceWindowRightEdgePosition: sourceRect.right,
    sourceWindowBottomEdgePosition: sourceRect.bottom,
    sourceRect,
    destinationRect,
    scaleX: destinationRect.width / sourceRect.width,
    scaleY: destinationRect.height / sourceRect.height,
    signature: [rawInfo.source_hwnd || 0, rawInfo.scaling_hwnd || 0, buildMagpieSignature(sourceRect, destinationRect)].join(":"),
  };
}

function createMagpieState(rawInfo) {
  const info = normalizeMagpieInfo(rawInfo);
  return {
    active: !!info,
    info,
    signature: info ? info.signature : null,
  };
}

function resolvePhysicalDisplaySize(displayInfo) {
  const physicalSize = displayInfo && displayInfo.physicalSize ? displayInfo.physicalSize : null;
  const width = physicalSize ? toFiniteNumber(physicalSize.width) : null;
  const height = physicalSize ? toFiniteNumber(physicalSize.height) : null;
  if (width && width > 0 && height && height > 0) {
    return { width, height };
  }

  if (typeof window !== "undefined") {
    const pixelRatio = window.devicePixelRatio || 1;
    const windowWidth = toFiniteNumber(window.screen && window.screen.width);
    const windowHeight = toFiniteNumber(window.screen && window.screen.height);
    if (windowWidth && windowWidth > 0 && windowHeight && windowHeight > 0) {
      return {
        width: windowWidth * pixelRatio,
        height: windowHeight * pixelRatio,
      };
    }
  }

  return null;
}

function mapPercentToMagpie(pX, pY, magpieState, displayInfo) {
  const state = magpieState && typeof magpieState.active === "boolean"
    ? magpieState
    : createMagpieState(magpieState);
  if (!state.active || !state.info) {
    return { x: pX, y: pY };
  }

  const displaySize = resolvePhysicalDisplaySize(displayInfo);
  if (!displaySize) {
    return { x: pX, y: pY };
  }

  // Backend percentages are monitor-relative; Magpie's rectangles are physical
  // desktop coordinates. Include the origin on both sides of the transform.
  const originX = toFiniteNumber(displayInfo?.physicalBounds?.x) ?? 0;
  const originY = toFiniteNumber(displayInfo?.physicalBounds?.y) ?? 0;
  const absoluteX = originX + (pX / 100) * displaySize.width;
  const absoluteY = originY + (pY / 100) * displaySize.height;
  const mapped = mapPointToMagpie({ x: absoluteX, y: absoluteY }, state.info);

  return {
    x: ((mapped.x - originX) / displaySize.width) * 100,
    y: ((mapped.y - originY) / displaySize.height) * 100,
  };
}

// All transforms operate in physical desktop pixels, including negative monitor
// origins. Percentages/CSS pixels are converted only at the renderer boundary.
function mapPointToMagpie(point, rawInfo) {
  const info = normalizeMagpieInfo(rawInfo);
  if (!info) return { ...point };
  const { sourceRect: src, destinationRect: dst } = info;
  return {
    x: dst.left + (point.x - src.left) * info.scaleX,
    y: dst.top + (point.y - src.top) * info.scaleY,
  };
}

function mapRectToMagpie(rect, rawInfo) {
  if (!rect) return rect;
  const tl = mapPointToMagpie({ x: rect.left, y: rect.top }, rawInfo);
  const br = mapPointToMagpie({ x: rect.right, y: rect.bottom }, rawInfo);
  return { left: tl.x, top: tl.y, right: br.x, bottom: br.y, width: br.x - tl.x, height: br.y - tl.y };
}

function mapCursorToMagpie(point, rawInfo) {
  const info = normalizeMagpieInfo(rawInfo);
  if (!info) return { ...point };
  const { sourceRect: src, destinationRect: dst } = info;
  // CursorManager maps first/last pixel centers, unlike rectangle edges. Ignore
  // border-exit samples: Magpie itself handles warping across letterboxing and
  // gaps between monitors, for which it has additional renderer geometry.
  if (point.x < src.left || point.x >= src.right || point.y < src.top || point.y >= src.bottom) return null;
  return {
    x: dst.left + Math.round((point.x - src.left) / Math.max(1, src.width - 1) * (dst.width - 1)),
    y: dst.top + Math.round((point.y - src.top) / Math.max(1, src.height - 1) * (dst.height - 1)),
  };
}

function createMagpieRendererController(options = {}) {
  const {
    restoreMouseIgnore = () => {},
    isYomitanShowing = () => false,
    isManualHotkeyPressed = () => false,
    logger = console,
  } = options;

  let state = createMagpieState(null);

  function applyInfo(rawInfo, reason = "magpie-update") {
    const nextState = createMagpieState(rawInfo);
    const activeChanged = nextState.active !== state.active;
    const signatureChanged = nextState.signature !== state.signature;
    state = nextState;

    if (activeChanged || signatureChanged) {
      logger.log(
        `[Magpie] Renderer state -> active=${state.active} signature=${state.signature || "inactive"} (${reason})`
      );
    }

    return {
      activeChanged,
      signatureChanged,
      state,
    };
  }

  function restorePassThrough(reason = "overlay-pass-through") {
    if (!isYomitanShowing() && !isManualHotkeyPressed()) restoreMouseIgnore(reason);
  }

  function getState() {
    return state;
  }

  return {
    applyInfo,
    getState,
    isActive() {
      return state.active;
    },
    getInfo() {
      return state.info;
    },
    mapPercent(pX, pY, displayInfo) {
      return mapPercentToMagpie(pX, pY, state, displayInfo);
    },
    restorePassThrough,
  };
}

const exported = {
  createMagpieRendererController,
  createMagpieState,
  mapPercentToMagpie,
  mapPointToMagpie,
  mapRectToMagpie,
  mapCursorToMagpie,
  normalizeMagpieInfo,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = exported;
} else if (typeof window !== "undefined") {
  window.GSMMagpie = exported;
}
