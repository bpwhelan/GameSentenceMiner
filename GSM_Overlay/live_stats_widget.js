(() => {
  const DEFAULT_FIELD_DEFINITIONS = Object.freeze([
    { key: "chars_per_hour", label: "Chars/hour", format: "integer", default_visible: true },
    { key: "total_characters", label: "Characters", format: "integer", default_visible: true },
    { key: "active_reading_time", label: "Active time", format: "duration", default_visible: true },
    { key: "cards_mined", label: "Cards mined", format: "integer", default_visible: true },
  ]);

  const DEFAULT_SETTINGS = Object.freeze({
    showLiveStats: true,
    liveStatsDisplayModeV2: "always",
    liveStatsLayoutV2: "one-line",
    liveStatsAutoHideSeconds: 5,
    liveStatsPositionMode: "active-window",
    liveStatsFields: {
      chars_per_hour: true,
      total_characters: true,
      active_reading_time: true,
      cards_mined: true,
    },
  });

  const VALID_DISPLAY_MODES = new Set(["always", "new-line"]);
  const VALID_LAYOUTS = new Set(["stacked", "one-line"]);
  const VALID_POSITION_MODES = new Set(["active-window", "overlay"]);
  const FIELD_KEYS = DEFAULT_FIELD_DEFINITIONS.map((field) => field.key);

  let ipcRenderer = null;
  try {
    ({ ipcRenderer } = require("electron"));
  } catch (error) {
    console.warn("[LiveStatsWidget] Electron ipcRenderer is unavailable:", error);
  }

  const state = {
    root: null,
    grid: null,
    status: null,
    settings: { ...DEFAULT_SETTINGS, liveStatsFields: { ...DEFAULT_SETTINGS.liveStatsFields } },
    fieldDefinitions: DEFAULT_FIELD_DEFINITIONS.map((field) => ({ ...field })),
    payload: null,
    displayInfo: null,
    targetWindowRect: null,
    targetClientRect: null,
    magpieInfo: null,
    hideTimer: null,
    temporarilyVisible: false,
  };

  function normalizeBoolean(value, fallback = false) {
    if (value === undefined) {
      return fallback;
    }
    return value === true;
  }

  function clampNumber(value, fallback, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, numeric));
  }

  function normalizeDisplayMode(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return VALID_DISPLAY_MODES.has(normalized) ? normalized : DEFAULT_SETTINGS.liveStatsDisplayModeV2;
  }

  function normalizePositionMode(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return VALID_POSITION_MODES.has(normalized) ? normalized : DEFAULT_SETTINGS.liveStatsPositionMode;
  }

  function normalizeLayout(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return VALID_LAYOUTS.has(normalized) ? normalized : DEFAULT_SETTINGS.liveStatsLayoutV2;
  }

  function normalizeLiveStatsFields(value = {}) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const normalized = {};
    FIELD_KEYS.forEach((key) => {
      normalized[key] = source[key] !== false;
    });
    return normalized;
  }

  function normalizeSettings(settings = {}) {
    return {
      showLiveStats: normalizeBoolean(settings.showLiveStats, state.settings.showLiveStats),
      liveStatsDisplayModeV2: normalizeDisplayMode(settings.liveStatsDisplayModeV2 ?? state.settings.liveStatsDisplayModeV2),
      liveStatsLayoutV2: normalizeLayout(settings.liveStatsLayoutV2 ?? state.settings.liveStatsLayoutV2),
      liveStatsAutoHideSeconds: clampNumber(
        settings.liveStatsAutoHideSeconds ?? state.settings.liveStatsAutoHideSeconds,
        DEFAULT_SETTINGS.liveStatsAutoHideSeconds,
        0,
        60
      ),
      liveStatsPositionMode: normalizePositionMode(settings.liveStatsPositionMode ?? state.settings.liveStatsPositionMode),
      liveStatsFields: normalizeLiveStatsFields(settings.liveStatsFields ?? state.settings.liveStatsFields),
    };
  }

  function normalizeFieldDefinitions(fields) {
    const source = Array.isArray(fields) && fields.length > 0 ? fields : DEFAULT_FIELD_DEFINITIONS;
    const byKey = new Map();

    source.forEach((field) => {
      if (!field || typeof field !== "object") {
        return;
      }
      const key = String(field.key || "").trim();
      if (!FIELD_KEYS.includes(key)) {
        return;
      }
      byKey.set(key, {
        key,
        label: String(field.label || key),
        format: String(field.format || "integer"),
        default_visible: field.default_visible !== false,
      });
    });

    return FIELD_KEYS
      .map((key) => byKey.get(key) || DEFAULT_FIELD_DEFINITIONS.find((field) => field.key === key))
      .filter(Boolean)
      .map((field) => ({ ...field }));
  }

  function normalizeStatsPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const values = payload.values && typeof payload.values === "object" ? payload.values : {};
    return {
      ...payload,
      values,
      session_active: payload.session_active === true,
    };
  }

  function normalizeTargetWindowRect(rect) {
    if (!rect || typeof rect !== "object") {
      return null;
    }

    const left = Number(rect.left);
    const top = Number(rect.top);
    const right = Number(rect.right ?? (left + Number(rect.width)));
    const bottom = Number(rect.bottom ?? (top + Number(rect.height)));
    if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
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

  function normalizeMagpieRect(rawInfo, keys) {
    const left = Number(rawInfo?.[keys.left]);
    const top = Number(rawInfo?.[keys.top]);
    const right = Number(rawInfo?.[keys.right]);
    const bottom = Number(rawInfo?.[keys.bottom]);
    if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
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

  function normalizeMagpieInfo(rawInfo) {
    if (!rawInfo || typeof rawInfo !== "object") {
      return null;
    }

    if (window.GSMMagpie && typeof window.GSMMagpie.normalizeMagpieInfo === "function") {
      const normalizedInfo = window.GSMMagpie.normalizeMagpieInfo(rawInfo);
      if (normalizedInfo?.sourceRect && normalizedInfo?.destinationRect) {
        return normalizedInfo;
      }
    }

    const sourceRect = normalizeMagpieRect(rawInfo, {
      left: "sourceWindowLeftEdgePosition",
      top: "sourceWindowTopEdgePosition",
      right: "sourceWindowRightEdgePosition",
      bottom: "sourceWindowBottomEdgePosition",
    });
    const destinationRect = normalizeMagpieRect(rawInfo, {
      left: "magpieWindowLeftEdgePosition",
      top: "magpieWindowTopEdgePosition",
      right: "magpieWindowRightEdgePosition",
      bottom: "magpieWindowBottomEdgePosition",
    });
    if (!sourceRect || !destinationRect) {
      return null;
    }
    return { sourceRect, destinationRect };
  }

  function formatInteger(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return "0";
    }
    return Math.round(numeric).toLocaleString();
  }

  function formatDuration(value) {
    const totalSeconds = Math.max(0, Math.floor(Number(value) || 0));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function formatValue(value, format) {
    if (format === "duration") {
      return formatDuration(value);
    }
    return formatInteger(value);
  }

  function ensureRoot() {
    if (state.root) {
      return state.root;
    }

    const root = document.createElement("section");
    root.id = "gsm-live-stats";
    root.setAttribute("aria-live", "polite");

    const header = document.createElement("div");
    header.className = "gsm-live-stats-header";

    const title = document.createElement("span");
    title.textContent = "Session";
    header.appendChild(title);

    const status = document.createElement("span");
    status.className = "gsm-live-stats-status";
    status.setAttribute("aria-hidden", "true");
    header.appendChild(status);

    const grid = document.createElement("div");
    grid.className = "gsm-live-stats-grid";

    root.appendChild(header);
    root.appendChild(grid);
    document.body.appendChild(root);

    state.root = root;
    state.grid = grid;
    state.status = status;
    updatePosition();
    return root;
  }

  function render() {
    ensureRoot();
    state.root.classList.toggle("gsm-live-stats-one-line", state.settings.liveStatsLayoutV2 === "one-line");
    const payload = state.payload;
    state.status.classList.toggle("active", !!payload?.session_active);
    state.grid.replaceChildren();

    if (!payload) {
      const empty = document.createElement("div");
      empty.className = "gsm-live-stats-empty";
      empty.textContent = "Waiting for stats";
      state.grid.appendChild(empty);
      updateVisibility();
      return;
    }

    const values = payload.values || {};
    const visibleFields = state.fieldDefinitions.filter((field) => state.settings.liveStatsFields[field.key] !== false);
    if (visibleFields.length === 0) {
      const empty = document.createElement("div");
      empty.className = "gsm-live-stats-empty";
      empty.textContent = "No fields selected";
      state.grid.appendChild(empty);
      updateVisibility();
      return;
    }

    visibleFields.forEach((field) => {
      const row = document.createElement("div");
      row.className = "gsm-live-stats-row";

      const label = document.createElement("span");
      label.className = "gsm-live-stats-label";
      label.textContent = field.label;

      const value = document.createElement("span");
      value.className = "gsm-live-stats-value";
      value.textContent = formatValue(values[field.key], field.format);

      row.appendChild(label);
      row.appendChild(value);
      state.grid.appendChild(row);
    });

    updatePosition();
    updateVisibility();
  }

  function clampPosition(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function getContentRect() {
    if (state.targetClientRect) {
      return state.targetClientRect;
    }

    if (!state.targetWindowRect) {
      return null;
    }

    const titleBarInset = Math.min(52, Math.max(30, state.targetWindowRect.height * 0.06));
    const top = Math.min(state.targetWindowRect.bottom, state.targetWindowRect.top + titleBarInset);
    return {
      ...state.targetWindowRect,
      top,
      height: Math.max(1, state.targetWindowRect.bottom - top),
    };
  }

  function mapRectThroughMagpie(rect) {
    if (!rect || !state.magpieInfo?.sourceRect || !state.magpieInfo?.destinationRect) {
      return rect;
    }

    const { sourceRect, destinationRect } = state.magpieInfo;
    const overlapsSource = (
      rect.right > sourceRect.left &&
      rect.left < sourceRect.right &&
      rect.bottom > sourceRect.top &&
      rect.top < sourceRect.bottom
    );
    if (!overlapsSource) {
      return rect;
    }

    const mapX = (value) => destinationRect.left + ((value - sourceRect.left) / sourceRect.width) * destinationRect.width;
    const mapY = (value) => destinationRect.top + ((value - sourceRect.top) / sourceRect.height) * destinationRect.height;
    const left = mapX(rect.left);
    const top = mapY(rect.top);
    const right = mapX(rect.right);
    const bottom = mapY(rect.bottom);
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  }

  function updatePosition() {
    const root = ensureRoot();
    const margin = 16;
    const rect = mapRectThroughMagpie(getContentRect());
    const physicalBounds = state.displayInfo?.physicalBounds;

    if (
      state.settings.liveStatsPositionMode === "active-window" &&
      rect &&
      physicalBounds &&
      Number(physicalBounds.width) > 0 &&
      Number(physicalBounds.height) > 0
    ) {
      const widgetRect = root.getBoundingClientRect();
      const widgetWidth = widgetRect.width || 220;
      const widgetHeight = widgetRect.height || 100;
      const scaleX = window.innerWidth / Number(physicalBounds.width);
      const scaleY = window.innerHeight / Number(physicalBounds.height);
      const left = ((rect.right - Number(physicalBounds.x || 0)) * scaleX) - widgetWidth - margin;
      const top = ((rect.top - Number(physicalBounds.y || 0)) * scaleY) + margin;

      root.style.setProperty("--gsm-live-stats-x", `${Math.round(clampPosition(left, margin, window.innerWidth - widgetWidth - margin))}px`);
      root.style.setProperty("--gsm-live-stats-y", `${Math.round(clampPosition(top, margin, window.innerHeight - widgetHeight - margin))}px`);
      root.style.right = "auto";
      return;
    }

    root.style.setProperty("--gsm-live-stats-x", "auto");
    root.style.setProperty("--gsm-live-stats-y", `${margin}px`);
    root.style.right = `${margin}px`;
  }

  function clearHideTimer() {
    if (state.hideTimer !== null) {
      clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
  }

  function setVisible(visible) {
    ensureRoot().classList.toggle("gsm-live-stats-visible", visible);
  }

  function updateVisibility() {
    const enabled = state.settings.showLiveStats === true && state.payload !== null;
    if (!enabled) {
      setVisible(false);
      return;
    }

    if (state.settings.liveStatsDisplayModeV2 === "always") {
      setVisible(true);
      return;
    }

    setVisible(state.temporarilyVisible);
  }

  function revealForUpdate() {
    if (state.settings.liveStatsDisplayModeV2 === "always") {
      state.temporarilyVisible = true;
      updateVisibility();
      return;
    }

    clearHideTimer();
    state.temporarilyVisible = true;
    updateVisibility();

    const hideAfterSeconds = state.settings.liveStatsAutoHideSeconds;
    if (hideAfterSeconds > 0) {
      state.hideTimer = setTimeout(() => {
        state.temporarilyVisible = false;
        state.hideTimer = null;
        updateVisibility();
      }, hideAfterSeconds * 1000);
    }
  }

  function handleStatsUpdate(payload) {
    const normalizedPayload = normalizeStatsPayload(payload);
    if (!normalizedPayload) {
      return;
    }

    state.payload = normalizedPayload;
    state.fieldDefinitions = normalizeFieldDefinitions(normalizedPayload.fields);
    render();
    revealForUpdate();
  }

  function handleWindowState(payload) {
    if (!payload || typeof payload !== "object") {
      return;
    }
    state.targetWindowRect = normalizeTargetWindowRect(payload.target_window_rect);
    state.targetClientRect = normalizeTargetWindowRect(payload.target_client_rect);
    state.magpieInfo = normalizeMagpieInfo(payload.magpie_info);
    updatePosition();
  }

  function applySettings(settings = {}) {
    state.settings = normalizeSettings(settings);
    updatePosition();
    render();
  }

  function setDisplayInfo(displayInfo) {
    state.displayInfo = displayInfo && typeof displayInfo === "object" ? displayInfo : null;
    updatePosition();
  }

  function init() {
    ensureRoot();
    render();
  }

  window.GSMLiveStatsWidget = {
    applySettings,
    handleStatsUpdate,
    handleWindowState,
    setDisplayInfo,
  };

  window.addEventListener("gsm-live-stats-update", (event) => {
    handleStatsUpdate(event.detail);
  });

  window.addEventListener("gsm-window-state-update", (event) => {
    handleWindowState(event.detail);
  });

  window.addEventListener("resize", () => {
    updatePosition();
  });

  if (ipcRenderer) {
    ipcRenderer.on("load-settings", (_event, settings) => {
      applySettings(settings);
    });
    ipcRenderer.on("settings-updated", (_event, settings) => {
      applySettings(settings);
    });
    ipcRenderer.on("display-info", (_event, displayInfo) => {
      setDisplayInfo(displayInfo);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
