(() => {
  const DEFAULT_FIELD_DEFINITIONS = Object.freeze([
    { key: "chars_per_hour", label: "Chars/hour", format: "integer", default_visible: true },
    { key: "total_characters", label: "Characters", format: "integer", default_visible: true },
    { key: "active_reading_time", label: "Active time", format: "duration", default_visible: true },
    { key: "raw_reading_time", label: "Raw time", format: "duration", default_visible: true },
    { key: "cards_mined", label: "Cards mined", format: "integer", default_visible: true },
  ]);

  const DEFAULT_SETTINGS = Object.freeze({
    showLiveStats: true,
    showLiveGoals: true,
    liveStatsDisplayModeV2: "always",
    liveStatsLayoutV2: "one-line",
    liveStatsAutoHideSeconds: 5,
    liveStatsPositionMode: "active-window",
    liveStatsFields: {
      chars_per_hour: true,
      total_characters: true,
      active_reading_time: true,
      raw_reading_time: true,
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
    pomodoro: null,
    pomodoroEl: null,
    goals: [],
    goalsEl: null,
    displayInfo: null,
    targetWindowRect: null,
    targetClientRect: null,
    magpieInfo: null,
    hideTimer: null,
    tickTimer: null,
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
      showLiveGoals: normalizeBoolean(settings.showLiveGoals ?? state.settings.showLiveGoals, true),
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

  // Raw time is wall-clock elapsed since the session's first line. The payload
  // only refreshes on new lines, so extrapolate it forward from session_start_time
  // while a session is active; everything else uses the payload value verbatim.
  function liveFieldValue(key, payloadValue) {
    if (key === "raw_reading_time") {
      const payload = state.payload;
      if (payload?.session_active && Number.isFinite(Number(payload.session_start_time))) {
        return Math.max(0, Date.now() / 1000 - Number(payload.session_start_time));
      }
    }
    return payloadValue;
  }

  // Re-render only the value cells that advance on their own (raw time), plus
  // the Pomodoro countdown.
  function updateLiveTimes() {
    if (state.grid && state.payload?.session_active) {
      const values = state.payload.values || {};
      state.grid.querySelectorAll('[data-field-key="raw_reading_time"]').forEach((cell) => {
        setText(cell, formatValue(liveFieldValue("raw_reading_time", values.raw_reading_time), cell.dataset.fieldFormat));
      });
    }
    renderPomodoro();
  }

  function pomodoroRemainingSeconds(pomodoro) {
    if (pomodoro.running && Number.isFinite(Number(pomodoro.endTimestamp))) {
      return Math.max(0, (Number(pomodoro.endTimestamp) - Date.now()) / 1000);
    }
    return Math.max(0, Number(pomodoro.remainingMs || 0) / 1000);
  }

  function renderPomodoro() {
    const el = state.pomodoroEl;
    if (!el) {
      return;
    }
    const pomodoro = state.pomodoro;
    if (!pomodoro || !pomodoro.enabled) {
      el.classList.remove("visible");
      return;
    }

    const isBreak = pomodoro.phase === "break";
    const remaining = pomodoroRemainingSeconds(pomodoro);
    const icon = isBreak ? "☕" : "🍅";
    let text = `${icon} ${formatDuration(remaining)}`;
    if (!pomodoro.running) {
      text += " ⏸";
    }
    setText(el, text);
    el.classList.add("visible");
    el.classList.toggle("break", isBreak);
    el.classList.toggle("paused", !pomodoro.running);
  }

  function renderGoals() {
    const el = state.goalsEl;
    if (!el) {
      return;
    }
    const goals = Array.isArray(state.goals) ? state.goals : [];
    if (state.settings.showLiveGoals === false || goals.length === 0) {
      el.replaceChildren();
      el.classList.remove("visible");
      return;
    }

    el.replaceChildren();
    goals.forEach((goal) => {
      const row = document.createElement("div");
      row.className = "gsm-live-goal";

      const label = document.createElement("span");
      label.className = "gsm-live-goal-label";
      setText(label, `${goal.icon || "🎯"} ${goal.name || "Goal"}`);
      row.appendChild(label);

      if (goal.view === "overall") {
        const percent = Math.max(0, Math.min(100, Number(goal.overall?.percent) || 0));
        const bar = document.createElement("span");
        bar.className = "gsm-live-goal-bar";
        const fill = document.createElement("span");
        fill.className = "gsm-live-goal-bar-fill";
        fill.style.width = `${percent}%`;
        bar.appendChild(fill);
        row.appendChild(bar);

        const value = document.createElement("span");
        value.className = "gsm-live-goal-value";
        setText(value, `${percent}%`);
        row.appendChild(value);
      } else {
        const value = document.createElement("span");
        value.className = "gsm-live-goal-value";
        const progress = formatInteger(goal.today?.progress);
        const required = formatInteger(goal.today?.required);
        const met = Number(goal.today?.progress) >= Number(goal.today?.required) && Number(goal.today?.required) > 0;
        setText(value, met ? `${progress} / ${required} ✓` : `${progress} / ${required}`);
        row.classList.toggle("met", met);
        row.appendChild(value);
      }

      el.appendChild(row);
    });
    el.classList.add("visible");
  }

  function handleGoalsUpdate(payload) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.goals)) {
      return;
    }
    state.goals = payload.goals;
    renderGoals();
    updateVisibility();
  }

  function handlePomodoroUpdate(payload) {
    if (!payload || typeof payload !== "object") {
      return;
    }
    state.pomodoro = {
      enabled: payload.enabled === true,
      phase: payload.phase === "break" ? "break" : "work",
      running: payload.running === true,
      endTimestamp: payload.endTimestamp,
      remainingMs: payload.remainingMs,
    };
    renderPomodoro();
    updateVisibility();
  }

  // Render text as CSS generated content (data-text -> ::after) instead of a
  // DOM text node. Yomitan finds text via caretRangeFromPoint, which ignores
  // user-select/pointer-events but only returns real text nodes — so generated
  // content keeps the stats out of Yomitan scans/sentence extraction.
  function setText(element, text) {
    element.dataset.text = text;
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
    setText(title, "Session");
    header.appendChild(title);

    const status = document.createElement("span");
    status.className = "gsm-live-stats-status";
    status.setAttribute("aria-hidden", "true");
    header.appendChild(status);

    const pomodoro = document.createElement("div");
    pomodoro.className = "gsm-live-stats-pomodoro";

    const grid = document.createElement("div");
    grid.className = "gsm-live-stats-grid";

    const goals = document.createElement("div");
    goals.className = "gsm-live-stats-goals";

    root.appendChild(header);
    root.appendChild(pomodoro);
    root.appendChild(grid);
    root.appendChild(goals);
    document.body.appendChild(root);

    state.root = root;
    state.grid = grid;
    state.status = status;
    state.pomodoroEl = pomodoro;
    state.goalsEl = goals;
    updatePosition();
    return root;
  }

  function render() {
    ensureRoot();
    renderPomodoro();
    renderGoals();
    state.root.classList.toggle("gsm-live-stats-one-line", state.settings.liveStatsLayoutV2 === "one-line");
    const payload = state.payload;
    state.status.classList.toggle("active", !!payload?.session_active);
    state.grid.replaceChildren();

    if (!payload) {
      const empty = document.createElement("div");
      empty.className = "gsm-live-stats-empty";
      setText(empty, "Waiting for stats");
      state.grid.appendChild(empty);
      updateVisibility();
      return;
    }

    const values = payload.values || {};
    const visibleFields = state.fieldDefinitions.filter((field) => state.settings.liveStatsFields[field.key] !== false);
    if (visibleFields.length === 0) {
      const empty = document.createElement("div");
      empty.className = "gsm-live-stats-empty";
      setText(empty, "No fields selected");
      state.grid.appendChild(empty);
      updateVisibility();
      return;
    }

    visibleFields.forEach((field) => {
      const row = document.createElement("div");
      row.className = "gsm-live-stats-row";

      const label = document.createElement("span");
      label.className = "gsm-live-stats-label";
      setText(label, field.label);

      const value = document.createElement("span");
      value.className = "gsm-live-stats-value";
      value.dataset.fieldKey = field.key;
      value.dataset.fieldFormat = field.format;
      setText(value, formatValue(liveFieldValue(field.key, values[field.key]), field.format));

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
    const pomodoroActive = !!(state.pomodoro && state.pomodoro.enabled);
    const goalsActive = state.settings.showLiveGoals !== false && Array.isArray(state.goals) && state.goals.length > 0;
    const enabled = state.settings.showLiveStats === true && (state.payload !== null || pomodoroActive || goalsActive);
    if (!enabled) {
      setVisible(false);
      return;
    }

    // Keep the widget pinned while a Pomodoro is enabled so the countdown stays
    // on screen even in auto-hide / new-line display modes.
    if (state.settings.liveStatsDisplayModeV2 === "always" || pomodoroActive || goalsActive) {
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
    if (state.tickTimer === null) {
      state.tickTimer = setInterval(updateLiveTimes, 1000);
    }
  }

  window.GSMLiveStatsWidget = {
    applySettings,
    handleStatsUpdate,
    handleWindowState,
    handlePomodoroUpdate,
    handleGoalsUpdate,
    setDisplayInfo,
  };

  window.addEventListener("gsm-live-goals-update", (event) => {
    handleGoalsUpdate(event.detail);
  });

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
    ipcRenderer.on("pomodoro-update", (_event, payload) => {
      handlePomodoroUpdate(payload);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
