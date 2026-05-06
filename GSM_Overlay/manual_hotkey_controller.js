const MANUAL_HOTKEY_BACKEND_ELECTRON = "electron";
const MANUAL_HOTKEY_BACKEND_INPUT_SERVER = "input_server";
const MANUAL_HOTKEY_MODE_HOLD = "hold";
const MANUAL_HOTKEY_MODE_TOGGLE = "toggle";
const MANUAL_HOTKEY_BLOCKED_GAME_WINDOW_STATES = new Set(["obscured", "minimized", "closed"]);

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

function isManualHotkeyBlockedByGameWindowState(state) {
  const normalized = String(state || "").trim().toLowerCase();
  return MANUAL_HOTKEY_BLOCKED_GAME_WINDOW_STATES.has(normalized);
}

function resolveManualHotkeyBackend(hotkey, options = {}) {
  if (options.forceInputServer === true) {
    return MANUAL_HOTKEY_BACKEND_INPUT_SERVER;
  }

  if (isModifierOnlyHotkey(hotkey)) {
    return MANUAL_HOTKEY_BACKEND_INPUT_SERVER;
  }

  return MANUAL_HOTKEY_BACKEND_ELECTRON;
}

function normalizeManualHotkeyMode(mode) {
  return String(mode || "").trim().toLowerCase() === MANUAL_HOTKEY_MODE_TOGGLE
    ? MANUAL_HOTKEY_MODE_TOGGLE
    : MANUAL_HOTKEY_MODE_HOLD;
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
    if (!keyDown && !holdActive) {
      return getSnapshot();
    }

    keyDown = false;
    clearElectronReleaseTimer();

    if (currentMode() === MANUAL_HOTKEY_MODE_TOGGLE) {
      return getSnapshot();
    }

    if (holdActive) {
      releaseHold(source);
    }

    return getSnapshot();
  }

  function handleElectronSignal(source = "electron") {
    if (currentMode() === MANUAL_HOTKEY_MODE_TOGGLE) {
      clearElectronReleaseTimer();
      keyDown = false;
      toggleLatch(source);
      return getSnapshot();
    }

    if (!keyDown) {
      keyDown = true;
      if (!holdActive) {
        holdActive = true;
        emit(source, "hold-activated");
      }
    }

    clearElectronReleaseTimer();
    electronReleaseTimer = setTimeout(() => {
      electronReleaseTimer = null;
      keyDown = false;

      if (currentMode() === MANUAL_HOTKEY_MODE_HOLD && holdActive) {
        releaseHold(source);
      }
    }, holdReleaseTimeoutMs);

    return getSnapshot();
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
  isModifierOnlyHotkey,
  normalizeManualHotkeyMode,
  resolveManualHotkeyBackend,
  splitHotkeyParts,
};
