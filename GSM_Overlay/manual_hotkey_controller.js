const MANUAL_HOTKEY_BACKEND_ELECTRON = "electron";
const MANUAL_HOTKEY_BACKEND_INPUT_SERVER = "input_server";
const MANUAL_HOTKEY_MODE_HOLD = "hold";
const MANUAL_HOTKEY_MODE_HYBRID = "hybrid";
const MANUAL_HOTKEY_MODE_TOGGLE = "toggle";
const MANUAL_HOTKEY_ALLOWED_GAME_WINDOW_STATES = new Set(["active", "background"]);

const MODIFIER_TOKENS = Object.freeze(["ctrl", "cmd", "alt", "shift"]);
const MODIFIER_TOKEN_SET = new Set(MODIFIER_TOKENS);

function splitHotkeyParts(hotkey) {
  return String(hotkey || "")
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function normalizeHotkeyParts(hotkey) {
  return splitHotkeyParts(hotkey).map((part) => part.toLowerCase());
}

function isModifierToken(token) {
  return MODIFIER_TOKEN_SET.has(String(token || "").trim().toLowerCase());
}

function isModifierOnlyHotkey(hotkey) {
  const parts = normalizeHotkeyParts(hotkey);
  return parts.length > 0 && parts.every(isModifierToken);
}

function isMouseHotkey(hotkey) {
  const parts = normalizeHotkeyParts(hotkey);
  const primaryParts = parts.filter((part) => !isModifierToken(part));
  return primaryParts.length === 1 && ["mouse4", "mouse5"].includes(primaryParts[0]);
}

function isManualHotkeyBlockedByGameWindowState(state) {
  const normalized = String(state || "").trim().toLowerCase();
  return !MANUAL_HOTKEY_ALLOWED_GAME_WINDOW_STATES.has(normalized);
}

function resolveManualHotkeyBackend(hotkey, options = {}) {
  if (options.forceInputServer === true) {
    return MANUAL_HOTKEY_BACKEND_INPUT_SERVER;
  }

  if (isModifierOnlyHotkey(hotkey) || isMouseHotkey(hotkey)) {
    return MANUAL_HOTKEY_BACKEND_INPUT_SERVER;
  }

  return MANUAL_HOTKEY_BACKEND_ELECTRON;
}

function normalizeManualHotkeyMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  return [MANUAL_HOTKEY_MODE_HYBRID, MANUAL_HOTKEY_MODE_TOGGLE].includes(normalized)
    ? normalized : MANUAL_HOTKEY_MODE_HOLD;
}

function createManualHotkeyController(options = {}) {
  const holdReleaseTimeoutMs = Math.max(0, Number.parseInt(options.holdReleaseTimeoutMs, 10) || 650);
  const onStateChange = typeof options.onStateChange === "function"
    ? options.onStateChange
    : null;
  const getMode = typeof options.getMode === "function"
    ? options.getMode
    : () => normalizeManualHotkeyMode(options.mode);

  let keyDown = false;
  let pressId = 0;
  let holdActive = false;
  let toggleLatched = false;
  let electronReleaseTimer = null;

  function currentMode() {
    return normalizeManualHotkeyMode(getMode());
  }

  function getSnapshot() {
    return {
      mode: currentMode(),
      keyDown,
      pendingTap: false,
      holdActive,
      toggleLatched,
      isActive: holdActive || toggleLatched,
    };
  }

  function emit(source, reason) {
    if (!onStateChange) {
      return;
    }
    onStateChange(getSnapshot(), { source, reason });
  }

  function clearElectronReleaseTimer() {
    if (electronReleaseTimer) {
      clearTimeout(electronReleaseTimer);
      electronReleaseTimer = null;
    }
  }

  function toggleLatch(source) {
    toggleLatched = !toggleLatched;
    emit(source, toggleLatched ? "toggle-on" : "toggle-off");
  }

  function releaseHold(source) {
    holdActive = false;
    emit(source, "hold-released");
  }

  function handlePress(source = "input_server") {
    if (keyDown) {
      return getSnapshot();
    }

    keyDown = true;
    ++pressId;
    if (currentMode() === MANUAL_HOTKEY_MODE_TOGGLE) {
      toggleLatch(source);
      return getSnapshot();
    }

    if (!holdActive) {
      holdActive = true;
      emit(source, "hold-activated");
    }
    return getSnapshot();
  }

  function handleRelease(source = "input_server") {
    if (!keyDown) {
      return getSnapshot();
    }

    keyDown = false;
    clearElectronReleaseTimer();

    if (currentMode() === MANUAL_HOTKEY_MODE_TOGGLE) {
      return getSnapshot();
    }

    if (currentMode() === MANUAL_HOTKEY_MODE_HYBRID) {
      if (options.isPopupShowing?.()) return getSnapshot();
      if (options.checkPopupShowing) {
        void checkHybridRelease(pressId, source);
        return getSnapshot();
      }
    }
    if (holdActive) releaseHold(source);

    return getSnapshot();
  }

  async function checkHybridRelease(id, source) {
    let visible = false;
    try {
      visible = await options.checkPopupShowing();
    } catch {
      // A closed renderer has no popup to retain.
    }
    if (id === pressId && !keyDown && holdActive && currentMode() === MANUAL_HOTKEY_MODE_HYBRID
        && !visible && !options.isPopupShowing?.()) releaseHold(source);
  }

  function handleElectronSignal(source = "electron") {
    if (currentMode() === MANUAL_HOTKEY_MODE_TOGGLE) {
      clearElectronReleaseTimer();
      keyDown = false;
      toggleLatch(source);
      return getSnapshot();
    }

    handlePress(source);
    clearElectronReleaseTimer();
    electronReleaseTimer = setTimeout(() => handleRelease(source), holdReleaseTimeoutMs);

    return getSnapshot();
  }

  function handlePopupClosed() {
    if (currentMode() !== MANUAL_HOTKEY_MODE_HYBRID || keyDown || !holdActive) return false;
    releaseHold("popup-closed");
    return true;
  }

  function reset(reason = "reset", options = {}) {
    const notify = options.notify === true;
    clearElectronReleaseTimer();
    keyDown = false;
    holdActive = false;
    toggleLatched = false;
    if (notify) {
      emit("reset", reason);
    }
    return getSnapshot();
  }

  return {
    getSnapshot,
    handlePress,
    handleRelease,
    handleElectronSignal,
    handlePopupClosed,
    reset,
  };
}

module.exports = {
  MANUAL_HOTKEY_BACKEND_ELECTRON,
  MANUAL_HOTKEY_BACKEND_INPUT_SERVER,
  MANUAL_HOTKEY_MODE_HOLD,
  MANUAL_HOTKEY_MODE_TOGGLE,
  createManualHotkeyController,
  isManualHotkeyBlockedByGameWindowState,
  isMouseHotkey,
  isModifierOnlyHotkey,
  normalizeManualHotkeyMode,
  resolveManualHotkeyBackend,
  splitHotkeyParts,
};
