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
    signature: buildMagpieSignature(sourceRect, destinationRect),
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

  const { sourceRect, destinationRect } = state.info;
  const absoluteX = (pX / 100) * displaySize.width;
  const absoluteY = (pY / 100) * displaySize.height;
  const mappedX = destinationRect.left + ((absoluteX - sourceRect.left) / sourceRect.width) * destinationRect.width;
  const mappedY = destinationRect.top + ((absoluteY - sourceRect.top) / sourceRect.height) * destinationRect.height;

  return {
    x: (mappedX / displaySize.width) * 100,
    y: (mappedY / displaySize.height) * 100,
  };
}

function createMagpieRendererController(options = {}) {
  const {
    requestMouseRelease = () => {},
    restoreMouseIgnore = () => {},
    isYomitanShowing = () => false,
    isManualHotkeyPressed = () => false,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    compatibilityIntervalMs = 1000,
    logger = console,
  } = options;

  let state = createMagpieState(null);
  let releaseInterval = null;

  function clearCompatibilityInterval() {
    if (releaseInterval) {
      clearIntervalFn(releaseInterval);
      releaseInterval = null;
    }
  }

  function canReleaseMouse() {
    return state.active && !isYomitanShowing() && !isManualHotkeyPressed();
  }

  function triggerMouseRelease(reason) {
    if (!canReleaseMouse()) {
      return false;
    }

    requestMouseRelease(reason);
    return true;
  }

  function syncCompatibility(reason = "magpie-sync") {
    clearCompatibilityInterval();

    if (!state.active) {
      return;
    }

    triggerMouseRelease(reason);
    releaseInterval = setIntervalFn(() => {
      triggerMouseRelease(reason);
    }, compatibilityIntervalMs);
  }

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

    syncCompatibility(reason);
    return {
      activeChanged,
      signatureChanged,
      state,
    };
  }

  function restorePassThrough(reason = "overlay-pass-through") {
    if (state.active) {
      triggerMouseRelease(reason);
      return;
    }

    restoreMouseIgnore(reason);
  }

  function getState() {
    return state;
  }

  function dispose() {
    clearCompatibilityInterval();
  }

  return {
    applyInfo,
    dispose,
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
    syncCompatibility,
  };
}

const exported = {
  createMagpieRendererController,
  createMagpieState,
  mapPercentToMagpie,
  normalizeMagpieInfo,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = exported;
} else if (typeof window !== "undefined") {
  window.GSMMagpie = exported;
}
