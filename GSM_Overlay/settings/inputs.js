// Keyboard/controller capture, device status, and input diagnostics.
// Loaded before bindings.js; side effects start in initializeSettingsInputs().
const GAMEPAD_INPUT_CONSOLE_MAX_LINES = 120;
const gamepadInputConsoleLines = [];
const GAMEPAD_BUTTON_LABELS = {
  0: "A",
  1: "B",
  2: "X",
  3: "Y",
  4: "LB",
  5: "RB",
  6: "LT",
  7: "RT",
  8: "Back",
  9: "Start",
  10: "LS",
  11: "RS",
  12: "DPad Up",
  13: "DPad Down",
  14: "DPad Left",
  15: "DPad Right",
  16: "Guide",
};
const GAMEPAD_AXIS_LABELS = {
  0: "LS-X",
  1: "LS-Y",
  2: "RS-X",
  3: "RS-Y",
};
const GAMEPAD_BUTTON_SORT_PRIORITY = {
  4: 10,
  5: 11,
  6: 12,
  7: 13,
  8: 20,
  9: 21,
  10: 30,
  11: 31,
  0: 40,
  1: 41,
  2: 42,
  3: 43,
  12: 50,
  13: 51,
  14: 52,
  15: 53,
  16: 60,
};
const GAMEPAD_BINDING_CAPTURE_POLL_MS = 50;
const GAMEPAD_BUTTON_ALIAS_LOOKUP = buildGamepadButtonAliasLookup();
const gamepadDeviceBlacklist = new Set();
const GAMEPAD_BINDING_INPUT_CONFIG = {
  gamepadModifierButton: { settingKey: "gamepadModifierButton", label: "Modifier Button", fallbackValue: 4 },
  gamepadToggleButton: { settingKey: "gamepadToggleButton", label: "Toggle Button", fallbackValue: 8 },
  gamepadConfirmButton: { settingKey: "gamepadConfirmButton", label: "Confirm Button", fallbackValue: 0 },
  gamepadCancelButton: { settingKey: "gamepadCancelButton", label: "Cancel Button", fallbackValue: 1 },
  gamepadForwardEnterButton: {
    settingKey: "gamepadForwardEnterButton",
    label: "Forward Enter Button",
    fallbackValue: -1,
  },
  gamepadForwardSpaceButton: {
    settingKey: "gamepadForwardSpaceButton",
    label: "Forward Space Button",
    fallbackValue: -1,
  },
  gamepadForwardCtrlButton: {
    settingKey: "gamepadForwardCtrlButton",
    label: "Forward Ctrl Button",
    fallbackValue: -1,
  },
  gamepadForwardEscapeButton: {
    settingKey: "gamepadForwardEscapeButton",
    label: "Forward Escape Button",
    fallbackValue: -1,
  },
  gamepadForwardClickButton: {
    settingKey: "gamepadForwardClickButton",
    label: "Forward Click Button",
    fallbackValue: -1,
  },
  gamepadManualOverlayScanButton: {
    settingKey: "gamepadManualOverlayScanButton",
    label: "Manual Overlay Scan Button",
    fallbackValue: -1,
  },
  gamepadTranslateButton: { settingKey: "gamepadTranslateButton", label: "Translation Button", fallbackValue: -1 },
  gamepadPauseToggleButton: { settingKey: "gamepadPauseToggleButton", label: "Pause Button", fallbackValue: -1 },
  gamepadTokenModeToggleButton: {
    settingKey: "gamepadTokenModeToggleButton",
    label: "Token Mode Toggle Button",
    fallbackValue: 3,
  },
  gamepadMineButton: { settingKey: "gamepadMineButton", label: "Mine Button", fallbackValue: 0 },
  gamepadNextEntryButton: {
    settingKey: "gamepadNextEntryButton",
    label: "Next Yomitan Entry Button",
    fallbackValue: 7,
  },
  gamepadPrevEntryButton: {
    settingKey: "gamepadPrevEntryButton",
    label: "Previous Yomitan Entry Button",
    fallbackValue: 6,
  },
  gamepadPrevJitenWordButton: {
    settingKey: "gamepadPrevJitenWordButton",
    label: "Previous New / i+1 Jiten Word",
    fallbackValue: -1,
  },
  gamepadNextJitenWordButton: {
    settingKey: "gamepadNextJitenWordButton",
    label: "Next New / i+1 Jiten Word",
    fallbackValue: -1,
  },
  gamepadNavigateUp: { settingKey: "gamepadNavigateUp", label: "Navigate Up", fallbackValue: 12 },
  gamepadNavigateDown: { settingKey: "gamepadNavigateDown", label: "Navigate Down", fallbackValue: 13 },
  gamepadNavigateLeft: { settingKey: "gamepadNavigateLeft", label: "Navigate Left", fallbackValue: 14 },
  gamepadNavigateRight: { settingKey: "gamepadNavigateRight", label: "Navigate Right", fallbackValue: 15 },
};

const KEYBOARD_BINDING_INPUT_CONFIG = {
  keyboardModifierKey: { settingKey: "keyboardModifierKey", label: "Keyboard Modifier Key", fallbackValue: null },
  keyboardToggleKey: { settingKey: "keyboardToggleKey", label: "Keyboard Toggle Key", fallbackValue: null },
  keyboardConfirmKey: { settingKey: "keyboardConfirmKey", label: "Keyboard Confirm Key", fallbackValue: "Enter" },
  keyboardCancelKey: { settingKey: "keyboardCancelKey", label: "Keyboard Cancel Key", fallbackValue: "Escape" },
  keyboardForwardEnterKey: {
    settingKey: "keyboardForwardEnterKey",
    label: "Keyboard Forward Enter Key",
    fallbackValue: null,
  },
  keyboardForwardSpaceKey: {
    settingKey: "keyboardForwardSpaceKey",
    label: "Keyboard Forward Space Key",
    fallbackValue: null,
  },
  keyboardForwardCtrlKey: {
    settingKey: "keyboardForwardCtrlKey",
    label: "Keyboard Forward Ctrl Key",
    fallbackValue: null,
  },
  keyboardForwardEscapeKey: {
    settingKey: "keyboardForwardEscapeKey",
    label: "Keyboard Forward Escape Key",
    fallbackValue: null,
  },
  keyboardForwardClickKey: {
    settingKey: "keyboardForwardClickKey",
    label: "Keyboard Forward Click Key",
    fallbackValue: null,
  },
  keyboardManualOverlayScanKey: {
    settingKey: "keyboardManualOverlayScanKey",
    label: "Keyboard Manual Overlay Scan Key",
    fallbackValue: null,
  },
  keyboardPauseToggleKey: { settingKey: "keyboardPauseToggleKey", label: "Keyboard Pause Key", fallbackValue: null },
  keyboardTokenModeToggleKey: {
    settingKey: "keyboardTokenModeToggleKey",
    label: "Keyboard Token Toggle Key",
    fallbackValue: null,
  },
  keyboardNextEntryKey: { settingKey: "keyboardNextEntryKey", label: "Keyboard Next Entry Key", fallbackValue: null },
  keyboardPrevEntryKey: { settingKey: "keyboardPrevEntryKey", label: "Keyboard Prev Entry Key", fallbackValue: null },
  keyboardPrevJitenWordKey: {
    settingKey: "keyboardPrevJitenWordKey",
    label: "Keyboard Previous New / i+1 Jiten Word",
    fallbackValue: null,
  },
  keyboardNextJitenWordKey: {
    settingKey: "keyboardNextJitenWordKey",
    label: "Keyboard Next New / i+1 Jiten Word",
    fallbackValue: null,
  },
  keyboardNavigateUp: { settingKey: "keyboardNavigateUp", label: "Keyboard Navigate Up", fallbackValue: "ArrowUp" },
  keyboardNavigateDown: {
    settingKey: "keyboardNavigateDown",
    label: "Keyboard Navigate Down",
    fallbackValue: "ArrowDown",
  },
  keyboardNavigateLeft: {
    settingKey: "keyboardNavigateLeft",
    label: "Keyboard Navigate Left",
    fallbackValue: "ArrowLeft",
  },
  keyboardNavigateRight: {
    settingKey: "keyboardNavigateRight",
    label: "Keyboard Navigate Right",
    fallbackValue: "ArrowRight",
  },
  keyboardMineButton: { settingKey: "keyboardMineButton", label: "Keyboard Mine Button", fallbackValue: null },
};

let gamepadStatusInterval = null;
let gamepadInputTestInterval = null;
let previousGamepadInputSignature = "";
let gamepadStatusSocket = null;
let gamepadStatusSocketPort = null;
let gamepadStatusSocketReconnectTimer = null;
let activeGamepadBindingCapture = null;
let renderingGamepadDeviceLists = false;
let overlayInputSuppressed = false;
const activeGamepadSuppressionReasons = new Set();
const serverReportedGamepads = new Set();
const serverGamepadStates = new Map();

// Reusable hotkey input initialization function
function initializeHotkeyInput(inputId, options = {}) {
  const {
    warningElementId = null,
    showCtrlWarning = false,
    placeholder = "Press keys...",
    settingKey = inputId,
    onCapture = null,
    onValidate = null,
  } = options;

  const input = document.getElementById(inputId);
  if (!input) return;

  let isCapturing = false;
  let previousValue = input.value;

  input.addEventListener("focus", (event) => {
    isCapturing = true;
    previousValue = event.target.value; // Store the current value before editing
    event.target.value = placeholder;
    event.target.classList.add("capturing-hotkey");
  });

  input.addEventListener("blur", (event) => {
    isCapturing = false;
    event.target.classList.remove("capturing-hotkey");

    // If no valid hotkey was captured, restore the previous value
    if (event.target.value === placeholder || event.target.value.trim() === "") {
      event.target.value = previousValue;
      if (settingKey === "showHotkey") {
        syncManualHotkeyStatusUi();
      }
      return;
    }

    // Handle Ctrl warning
    if (showCtrlWarning && warningElementId) {
      updateCtrlWarning(event.target.value, warningElementId);
    }

    // Only validate and send if we have a real hotkey, not the placeholder
    if (validateHotkey(event.target.value)) {
      previousValue = event.target.value; // Update previous value on successful change
      if (onValidate) {
        onValidate(event.target.value);
      } else {
        handleSettingChange(settingKey, event.target.value, event.target);
      }
    } else {
      alert("Invalid hotkey format. Use a key like Shift+Space or a modifier-only hotkey like Shift.");
      event.target.value = previousValue; // Restore previous value on invalid input
    }
    if (settingKey === "showHotkey") {
      syncManualHotkeyStatusUi();
    }
  });

  input.addEventListener("keydown", (event) => {
    if (!isCapturing) return;

    event.preventDefault();
    event.stopPropagation();

    const accelerator = captureKeyboardEvent(event);
    if (accelerator) {
      event.target.value = accelerator;
      if (onCapture) {
        onCapture(accelerator);
      }
      if (settingKey === "showHotkey") {
        syncManualHotkeyStatusUi();
      }
    }
  });

  input.addEventListener("keyup", (event) => {
    if (isCapturing && event.target.value !== placeholder) {
      // Handle Ctrl warning
      if (showCtrlWarning && warningElementId) {
        updateCtrlWarning(event.target.value, warningElementId);
      }

      // Auto-apply the hotkey after a short delay
      setTimeout(() => {
        if (validateHotkey(event.target.value)) {
          if (onValidate) {
            onValidate(event.target.value);
          } else {
            handleSettingChange(settingKey, event.target.value, event.target);
          }
          event.target.blur(); // Exit capture mode
        }
      }, 500);
    }
  });

  input.addEventListener("mousedown", (event) => {
    if (!isCapturing) return;

    const accelerator = captureMouseEvent(event);
    if (!accelerator) return;

    event.preventDefault();
    event.stopPropagation();
    event.target.value = accelerator;
    if (onCapture) {
      onCapture(accelerator);
    }
    if (showCtrlWarning && warningElementId) {
      updateCtrlWarning(accelerator, warningElementId);
    }
    if (settingKey === "showHotkey") {
      syncManualHotkeyStatusUi();
    }

    // Let the normal blur path validate and persist the captured value.
    setTimeout(() => {
      if (isCapturing && validateHotkey(event.target.value)) {
        event.target.blur();
      }
    }, 0);
  });

  input.addEventListener("mouseup", (event) => {
    if (isCapturing && captureMouseEvent(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  input.addEventListener("auxclick", (event) => {
    if (isCapturing && captureMouseEvent(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

function initializeGamepadBindingInput(inputId) {
  const input = document.getElementById(inputId);
  const config = GAMEPAD_BINDING_INPUT_CONFIG[inputId];
  if (!input || !config) return;

  input.readOnly = true;

  input.addEventListener("focus", () => {
    if (input.disabled) {
      return;
    }
    startGamepadBindingCapture(inputId);
  });

  input.addEventListener("blur", () => {
    if (activeGamepadBindingCapture && activeGamepadBindingCapture.inputId === inputId) {
      stopGamepadBindingCapture({ restorePrevious: true });
    }
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      stopGamepadBindingCapture({ restorePrevious: true });
      input.blur();
      return;
    }

    if (event.key === "Backspace" || event.key === "Delete") {
      clearGamepadBindingInput(inputId);
      input.blur();
    }
  });
}

function getCaptureTargetGamepad(capture) {
  const connectedGamepads = getConnectedGamepads();
  if (connectedGamepads.length === 0) {
    return null;
  }

  if (capture.lockedGamepadIndex !== null) {
    const lockedGamepad = connectedGamepads.find((gamepad) => gamepad.index === capture.lockedGamepadIndex);
    if (lockedGamepad) {
      return lockedGamepad;
    }
    capture.lockedGamepadIndex = null;
    capture.capturedButtons = null;
  }

  const activeGamepad = connectedGamepads.find((gamepad) => getPressedGamepadButtons(gamepad).length > 0);
  return activeGamepad || connectedGamepads[0];
}

function startGamepadBindingCapture(inputId) {
  const input = document.getElementById(inputId);
  const config = GAMEPAD_BINDING_INPUT_CONFIG[inputId];
  if (!input || !config || input.disabled) {
    return;
  }

  if (activeGamepadBindingCapture && activeGamepadBindingCapture.inputId === inputId) {
    return;
  }

  stopGamepadBindingCapture({ restorePrevious: true });

  activeGamepadBindingCapture = {
    inputId,
    input,
    config,
    previousValue: input.value,
    lockedGamepadIndex: null,
    capturedButtons: null,
    intervalId: null,
  };

  input.value = "Listening for controller input...";
  input.classList.add("capturing-hotkey");
  setOverlayGamepadBindingCaptureSuppression(true);
  addGamepadInputConsoleLine(`Capturing ${config.label}...`);

  activeGamepadBindingCapture.intervalId = setInterval(pollGamepadBindingCapture, GAMEPAD_BINDING_CAPTURE_POLL_MS);
}

function pollGamepadBindingCapture() {
  const capture = activeGamepadBindingCapture;
  if (!capture) return;

  const targetGamepad = getCaptureTargetGamepad(capture);
  if (!targetGamepad) {
    capture.lockedGamepadIndex = null;
    capture.capturedButtons = null;
    capture.input.value = "Waiting for controller...";
    return;
  }

  const pressedButtons = getPressedGamepadButtons(targetGamepad);
  if (pressedButtons.length === 0) {
    if (capture.capturedButtons && capture.capturedButtons.length > 0) {
      commitGamepadBindingCapture();
      return;
    }

    capture.input.value = "Listening for controller input...";
    return;
  }

  capture.lockedGamepadIndex = targetGamepad.index;
  if (!capture.capturedButtons || pressedButtons.length >= capture.capturedButtons.length) {
    capture.capturedButtons = pressedButtons;
  }
  capture.input.value = createGamepadBindingDescriptor(capture.capturedButtons, true).label;
}

function commitGamepadBindingCapture() {
  const capture = activeGamepadBindingCapture;
  if (!capture) {
    return;
  }

  const bindingValue = createGamepadBindingDescriptor(capture.capturedButtons || [], true).label;
  stopGamepadBindingCapture({
    nextValue: bindingValue,
    shouldSave: true,
    logLine: `Saved ${capture.config.label}: ${bindingValue}`,
    blurInput: true,
  });
}

function clearGamepadBindingInput(inputId) {
  const input = document.getElementById(inputId);
  const config = GAMEPAD_BINDING_INPUT_CONFIG[inputId];
  if (!input || !config) {
    return;
  }

  if (activeGamepadBindingCapture && activeGamepadBindingCapture.inputId === inputId) {
    stopGamepadBindingCapture({ restorePrevious: false });
  }

  input.classList.remove("capturing-hotkey");
  input.value = "Disabled";
  void commitSettingValue(config.settingKey, "Disabled", input);
  addGamepadInputConsoleLine(`Cleared ${config.label}`);
}

function stopGamepadBindingCapture(options = {}) {
  const { restorePrevious = false, nextValue = null, shouldSave = false, logLine = "", blurInput = false } = options;

  const capture = activeGamepadBindingCapture;
  if (!capture) {
    return;
  }

  activeGamepadBindingCapture = null;

  if (capture.intervalId !== null) {
    clearInterval(capture.intervalId);
  }

  capture.input.classList.remove("capturing-hotkey");
  setOverlayGamepadBindingCaptureSuppression(false);

  if (nextValue !== null) {
    capture.input.value = nextValue;
  } else if (restorePrevious) {
    capture.input.value = capture.previousValue;
  }

  if (shouldSave && nextValue !== null) {
    void commitSettingValue(capture.config.settingKey, nextValue, capture.input);
  }

  if (logLine) {
    addGamepadInputConsoleLine(logLine);
  }

  if (blurInput && typeof capture.input.blur === "function" && document.activeElement === capture.input) {
    capture.input.blur();
  }
}

function stopGamepadBindingCaptureIfDisabled() {
  if (activeGamepadBindingCapture && activeGamepadBindingCapture.input?.disabled) {
    stopGamepadBindingCapture({ restorePrevious: true });
  }
}

// ==================== Keyboard Binding Capture ====================

const KEYBOARD_MODIFIER_KEY_IDS = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

const KEYBOARD_KEY_DISPLAY_LABELS = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
};

function getKeyboardKeyDisplayLabel(keyId) {
  if (!keyId) return "";
  const letterMatch = keyId.match(/^Key([A-Z])$/);
  if (letterMatch) return letterMatch[1];
  const digitMatch = keyId.match(/^Digit(\d)$/);
  if (digitMatch) return digitMatch[1];
  if (KEYBOARD_KEY_DISPLAY_LABELS[keyId]) return KEYBOARD_KEY_DISPLAY_LABELS[keyId];
  return keyId;
}

function formatKeyboardBindingLabel(key, modifiers) {
  const parts = [];
  if (modifiers && modifiers.ctrl) parts.push("Ctrl");
  if (modifiers && modifiers.alt) parts.push("Alt");
  if (modifiers && modifiers.shift) parts.push("Shift");
  if (modifiers && modifiers.meta) parts.push("Meta");
  if (key && !KEYBOARD_MODIFIER_KEY_IDS.has(key)) {
    parts.push(getKeyboardKeyDisplayLabel(key));
  }
  return parts.length > 0 ? parts.join("+") : "Disabled";
}

function formatKeyboardBindingSettingValue(key, modifiers) {
  // The setting value is stored as a string like "Ctrl+ArrowUp" or just "Enter"
  const parts = [];
  if (modifiers && modifiers.ctrl) parts.push("Ctrl");
  if (modifiers && modifiers.alt) parts.push("Alt");
  if (modifiers && modifiers.shift) parts.push("Shift");
  if (modifiers && modifiers.meta) parts.push("Meta");
  if (key && !KEYBOARD_MODIFIER_KEY_IDS.has(key)) {
    parts.push(key);
  }
  return parts.length > 0 ? parts.join("+") : "Disabled";
}

function formatKeyboardBindingDisplayValue(settingValue, fallbackValue) {
  if (settingValue === null || settingValue === undefined) {
    if (fallbackValue !== null && fallbackValue !== undefined) {
      return formatKeyboardBindingDisplayFromSettingValue(fallbackValue);
    }
    return "Disabled";
  }

  if (/^(disabled|none|off)?$/i.test(String(settingValue).trim())) {
    return "Disabled";
  }

  return formatKeyboardBindingDisplayFromSettingValue(settingValue);
}

function formatKeyboardBindingDisplayFromSettingValue(value) {
  if (!value || /^(disabled|none|off)$/i.test(String(value).trim())) return "Disabled";
  const tokens = String(value)
    .split("+")
    .map((t) => t.trim());
  const parts = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "ctrl" || lower === "control") {
      parts.push("Ctrl");
      continue;
    }
    if (lower === "alt") {
      parts.push("Alt");
      continue;
    }
    if (lower === "shift") {
      parts.push("Shift");
      continue;
    }
    if (lower === "meta" || lower === "cmd" || lower === "win") {
      parts.push("Meta");
      continue;
    }
    parts.push(getKeyboardKeyDisplayLabel(token));
  }
  return parts.length > 0 ? parts.join("+") : "Disabled";
}

let activeKeyboardBindingCapture = null;

function setKeyboardBindingInputValue(inputId, value) {
  const input = document.getElementById(inputId);
  const config = KEYBOARD_BINDING_INPUT_CONFIG[inputId];
  if (!input || !config) return;
  input.value = formatKeyboardBindingDisplayValue(value, config.fallbackValue);
}

function initializeKeyboardBindingInput(inputId) {
  const input = document.getElementById(inputId);
  const config = KEYBOARD_BINDING_INPUT_CONFIG[inputId];
  if (!input || !config) return;

  input.readOnly = true;

  input.addEventListener("focus", () => {
    if (input.disabled) return;
    startKeyboardBindingCapture(inputId);
  });

  input.addEventListener("blur", () => {
    if (activeKeyboardBindingCapture && activeKeyboardBindingCapture.inputId === inputId) {
      stopKeyboardBindingCapture({ restorePrevious: true });
    }
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    // We DON'T capture browser keyboard events — we wait for server events instead.
    // But we handle Escape, Backspace, Delete for UX.
    if (handleKeyboardBindingControlKey(inputId, event.key)) {
      return;
    }
  });
}

function handleKeyboardBindingControlKey(inputId, key) {
  const input = document.getElementById(inputId);
  if (!input) return false;

  if (key === "Escape") {
    stopKeyboardBindingCapture({ restorePrevious: true });
    input.blur();
    return true;
  }

  if (key === "Backspace" || key === "Delete") {
    clearKeyboardBindingInput(inputId);
    input.blur();
    return true;
  }

  return false;
}

function startKeyboardBindingCapture(inputId) {
  if (activeKeyboardBindingCapture) {
    stopKeyboardBindingCapture({ restorePrevious: true });
  }

  const input = document.getElementById(inputId);
  const config = KEYBOARD_BINDING_INPUT_CONFIG[inputId];
  if (!input || !config) return;

  const previousValue = input.value;
  input.value = "Press a key...";
  input.classList.add("capturing-keyboard");
  setOverlayGamepadBindingCaptureSuppression(true);
  setServerKeyboardCaptureAll(true);

  activeKeyboardBindingCapture = {
    inputId,
    input,
    config,
    previousValue,
    capturedKey: null,
    capturedModifiers: null,
    handlerFn: null,
  };

  // Listen for keyboard events from the input server WebSocket
  const handler = (event) => {
    const { key, pressed, modifiers } = event.detail;
    if (!activeKeyboardBindingCapture || activeKeyboardBindingCapture.inputId !== inputId) return;
    if (pressed && handleKeyboardBindingControlKey(inputId, key)) return;
    if (!pressed) {
      // Key released — if we captured something, commit it
      if (
        activeKeyboardBindingCapture.capturedKey !== null ||
        activeKeyboardBindingCapture.capturedModifiers !== null
      ) {
        commitKeyboardBindingCapture();
      }
      return;
    }

    // Track the captured key+modifiers
    const isModifier = KEYBOARD_MODIFIER_KEY_IDS.has(key);
    if (isModifier) {
      // Just update modifiers display
      activeKeyboardBindingCapture.capturedModifiers = { ...modifiers };
      activeKeyboardBindingCapture.capturedKey = null;
      input.value = formatKeyboardBindingLabel(null, modifiers);
    } else {
      activeKeyboardBindingCapture.capturedKey = key;
      activeKeyboardBindingCapture.capturedModifiers = { ...modifiers };
      input.value = formatKeyboardBindingLabel(key, modifiers);
      // Non-modifier key pressed — commit immediately
      commitKeyboardBindingCapture();
    }
  };

  activeKeyboardBindingCapture.handlerFn = handler;
  window.addEventListener("gsm-keyboard-event", handler);
}

function commitKeyboardBindingCapture() {
  const capture = activeKeyboardBindingCapture;
  if (!capture) return;

  const settingValue = formatKeyboardBindingSettingValue(capture.capturedKey, capture.capturedModifiers);
  const displayLabel = formatKeyboardBindingLabel(capture.capturedKey, capture.capturedModifiers);

  stopKeyboardBindingCapture({
    nextValue: displayLabel,
    shouldSave: true,
    saveValue: settingValue,
    logLine: `Saved ${capture.config.label}: ${displayLabel}`,
    blurInput: true,
  });
}

function clearKeyboardBindingInput(inputId) {
  const input = document.getElementById(inputId);
  const config = KEYBOARD_BINDING_INPUT_CONFIG[inputId];
  if (!input || !config) return;

  if (activeKeyboardBindingCapture && activeKeyboardBindingCapture.inputId === inputId) {
    stopKeyboardBindingCapture({ restorePrevious: false });
  }

  input.classList.remove("capturing-keyboard");
  input.value = "Disabled";
  void commitSettingValue(config.settingKey, "Disabled", input);
  addGamepadInputConsoleLine(`Cleared ${config.label}`);
}

function stopKeyboardBindingCapture(options = {}) {
  const {
    restorePrevious = false,
    nextValue = null,
    shouldSave = false,
    saveValue = null,
    logLine = "",
    blurInput = false,
  } = options;

  const capture = activeKeyboardBindingCapture;
  if (!capture) return;

  activeKeyboardBindingCapture = null;

  if (capture.handlerFn) {
    window.removeEventListener("gsm-keyboard-event", capture.handlerFn);
  }

  capture.input.classList.remove("capturing-keyboard");
  setOverlayGamepadBindingCaptureSuppression(false);
  setServerKeyboardCaptureAll(false);

  if (nextValue !== null) {
    capture.input.value = nextValue;
  } else if (restorePrevious) {
    capture.input.value = capture.previousValue;
  }

  if (shouldSave && saveValue !== null) {
    void commitSettingValue(capture.config.settingKey, saveValue, capture.input);
  } else if (shouldSave && nextValue !== null) {
    void commitSettingValue(capture.config.settingKey, nextValue, capture.input);
  }

  if (logLine) {
    addGamepadInputConsoleLine(logLine);
  }

  if (blurInput && typeof capture.input.blur === "function" && document.activeElement === capture.input) {
    capture.input.blur();
  }
}

function createKeyboardBindingSetting(inputId) {
  const config = KEYBOARD_BINDING_INPUT_CONFIG[inputId];
  return {
    key: config.settingKey,
    selectors: [`#${inputId}`],
    kind: "keyboard-binding",
    read: (control) => control.value,
    write: (control, value) => {
      setKeyboardBindingInputValue(control.id, value);
    },
    equals: (left, right) =>
      formatKeyboardBindingDisplayValue(left, config.fallbackValue) ===
      formatKeyboardBindingDisplayValue(right, config.fallbackValue),
  };
}

// Capture keyboard event and convert to accelerator format
// Delegated to the shared Manual Mode card component (single source of truth).
function captureKeyboardEvent(event) {
  return GSMManualModeCard.captureKeyboardEvent(event);
}

function captureMouseEvent(event) {
  return GSMManualModeCard.captureMouseEvent(event);
}

// Update Ctrl warning visibility
function updateCtrlWarning(hotkey, warningElementId) {
  const warningElement = document.getElementById(warningElementId);
  if (!warningElement) return;

  if (hotkey && hotkey.includes("Ctrl")) {
    warningElement.style.display = "block";
  } else {
    warningElement.style.display = "none";
  }
}

// Delegated to the shared Manual Mode card component (single source of truth).
function validateHotkey(hotkey) {
  return GSMManualModeCard.validateHotkey(hotkey);
}

function addGamepadInputConsoleLine(message) {
  const timestamp = new Date().toLocaleTimeString();
  gamepadInputConsoleLines.push(`[${timestamp}] ${message}`);
  if (gamepadInputConsoleLines.length > GAMEPAD_INPUT_CONSOLE_MAX_LINES) {
    gamepadInputConsoleLines.shift();
  }

  if (window.GSMSettingsNavigation?.activePage.category === "gamepad") {
    renderGamepadInputConsole();
  }
}

function renderGamepadInputConsole() {
  const consoleEl = document.getElementById("gamepadInputConsole");
  if (!consoleEl) return;

  if (!gamepadInputConsoleLines.length) {
    consoleEl.textContent = "No input events yet.";
    consoleEl.classList.add("empty");
    return;
  }

  consoleEl.classList.remove("empty");
  consoleEl.textContent = gamepadInputConsoleLines.join("\n");
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function clearGamepadInputConsole() {
  gamepadInputConsoleLines.length = 0;
  renderGamepadInputConsole();
}

function getDisplayControllerLabel(name) {
  if (typeof name !== "string" || !name.trim()) return "Unknown controller";
  const trimmed = name.trim();
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}...` : trimmed;
}

function normalizeGamepadDeviceName(name) {
  const normalized = String(name || "").trim();
  return normalized || null;
}

function normalizeGamepadDeviceBlacklistValue(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value.map(normalizeGamepadDeviceName).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function getSortedGamepadDeviceBlacklist() {
  return Array.from(gamepadDeviceBlacklist.values()).sort((a, b) => a.localeCompare(b));
}

function isGamepadDeviceBlacklisted(name) {
  const normalized = normalizeGamepadDeviceName(name);
  return Boolean(normalized && gamepadDeviceBlacklist.has(normalized));
}

function setGamepadDeviceBlacklist(devices, options = {}) {
  gamepadDeviceBlacklist.clear();
  normalizeGamepadDeviceBlacklistValue(devices).forEach((deviceName) => {
    gamepadDeviceBlacklist.add(deviceName);
  });

  renderGamepadDeviceLists();
  updateGamepadStatus();

  if (options.persist) {
    handleSettingChange("gamepadDeviceBlacklist", getSortedGamepadDeviceBlacklist());
  }
  if (options.send !== false) {
    sendGamepadDeviceBlacklistToServer();
  }
}

function sendGamepadDeviceBlacklistToServer() {
  if (!gamepadStatusSocket || gamepadStatusSocket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    gamepadStatusSocket.send(
      JSON.stringify({
        type: "configure_device_blacklist",
        devices: getSortedGamepadDeviceBlacklist(),
      }),
    );
  } catch (e) {
    // Ignore send errors and rely on reconnect.
  }
}

// While recording a keyboard binding we need every key, so ask the server to
// broadcast all keys ("press a key..."). The rest of the time the server only
// broadcasts the overlay's allowlisted control keys, so this MUST be turned
// back off as soon as capture ends.
function setServerKeyboardCaptureAll(active) {
  if (!gamepadStatusSocket || gamepadStatusSocket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    gamepadStatusSocket.send(
      JSON.stringify({
        type: "configure_keyboard_capture",
        captureAll: !!active,
      }),
    );
  } catch (e) {
    // Ignore send errors and rely on reconnect.
  }
}

function addGamepadDeviceToBlacklist(deviceName) {
  const normalized = normalizeGamepadDeviceName(deviceName);
  if (!normalized || gamepadDeviceBlacklist.has(normalized)) {
    return;
  }
  gamepadDeviceBlacklist.add(normalized);
  serverReportedGamepads.delete(normalized);
  serverGamepadStates.delete(normalized);
  setGamepadDeviceBlacklist(getSortedGamepadDeviceBlacklist(), { persist: true });
  addGamepadInputConsoleLine(`Ignored device: ${getDisplayControllerLabel(normalized)}`);
}

function removeGamepadDeviceFromBlacklist(deviceName) {
  const normalized = normalizeGamepadDeviceName(deviceName);
  if (!normalized || !gamepadDeviceBlacklist.delete(normalized)) {
    return;
  }
  setGamepadDeviceBlacklist(getSortedGamepadDeviceBlacklist(), { persist: true });
  addGamepadInputConsoleLine(`Allowed device: ${getDisplayControllerLabel(normalized)}`);
}

function getDetectedGamepadDeviceNames() {
  const names = new Set();
  serverReportedGamepads.forEach((name) => {
    const normalized = normalizeGamepadDeviceName(name);
    if (normalized && !isGamepadDeviceBlacklisted(normalized)) {
      names.add(normalized);
    }
  });

  getConnectedGamepads().forEach((gamepad) => {
    const normalized = normalizeGamepadDeviceName(gamepad.id);
    if (normalized && !isGamepadDeviceBlacklisted(normalized)) {
      names.add(normalized);
    }
  });

  return Array.from(names.values()).sort((a, b) => a.localeCompare(b));
}

function createGamepadDeviceRow(deviceName, actionLabel, actionTitle, onClick) {
  const row = document.createElement("div");
  row.className = "gamepad-device-row";

  const name = document.createElement("div");
  name.className = "gamepad-device-name";
  name.textContent = getDisplayControllerLabel(deviceName);
  name.title = deviceName;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "gamepad-device-action";
  button.textContent = actionLabel;
  button.title = actionTitle;
  button.setAttribute("aria-label", actionTitle);
  button.addEventListener("click", onClick);

  row.appendChild(name);
  row.appendChild(button);
  return row;
}

function renderGamepadDeviceList(container, devices, emptyText, renderRow) {
  if (!container) return;
  if (!devices.length) {
    const empty = document.createElement("div");
    empty.className = "gamepad-device-empty";
    empty.textContent = emptyText;
    container.replaceChildren(empty);
    return;
  }
  container.replaceChildren(...devices.map(renderRow));
}

function renderGamepadDeviceLists() {
  if (renderingGamepadDeviceLists) {
    return;
  }
  renderingGamepadDeviceLists = true;
  try {
    const detectedList = document.getElementById("gamepadDetectedDeviceList");
    const ignoredList = document.getElementById("gamepadIgnoredDeviceList");
    const detectedDevices = getDetectedGamepadDeviceNames();
    const ignoredDevices = getSortedGamepadDeviceBlacklist();

    renderGamepadDeviceList(detectedList, detectedDevices, "No detected devices.", (deviceName) =>
      createGamepadDeviceRow(deviceName, "-", `Ignore ${deviceName}`, () => addGamepadDeviceToBlacklist(deviceName)),
    );

    renderGamepadDeviceList(ignoredList, ignoredDevices, "No ignored devices.", (deviceName) =>
      createGamepadDeviceRow(deviceName, "+", `Allow ${deviceName}`, () =>
        removeGamepadDeviceFromBlacklist(deviceName),
      ),
    );
  } finally {
    renderingGamepadDeviceLists = false;
  }
}

function getGamepadButtonLabel(index) {
  return GAMEPAD_BUTTON_LABELS[index] || `Button ${index}`;
}

function getGamepadAxisLabel(index) {
  const serverLabels = { left_x: "LS-X", left_y: "LS-Y", right_x: "RS-X", right_y: "RS-Y", lt: "LT", rt: "RT" };
  return serverLabels[index] || GAMEPAD_AXIS_LABELS[index] || `Axis ${index}`;
}

function getGamepadButtonSortKey(index) {
  return Object.prototype.hasOwnProperty.call(GAMEPAD_BUTTON_SORT_PRIORITY, index)
    ? GAMEPAD_BUTTON_SORT_PRIORITY[index]
    : 1000 + index;
}

function normalizeGamepadButtonToken(token) {
  return String(token || "")
    .trim()
    .toLowerCase()
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ");
}

function buildGamepadButtonAliasLookup() {
  const aliases = {};
  const registerAlias = (alias, index) => {
    aliases[normalizeGamepadButtonToken(alias)] = index;
  };

  Object.entries(GAMEPAD_BUTTON_LABELS).forEach(([index, label]) => {
    registerAlias(label, Number(index));
  });

  registerAlias("cross", 0);
  registerAlias("circle", 1);
  registerAlias("square", 2);
  registerAlias("triangle", 3);
  registerAlias("left bumper", 4);
  registerAlias("right bumper", 5);
  registerAlias("left trigger", 6);
  registerAlias("right trigger", 7);
  registerAlias("view", 8);
  registerAlias("select", 8);
  registerAlias("back/select/view", 8);
  registerAlias("menu", 9);
  registerAlias("start/menu", 9);
  registerAlias("left stick", 10);
  registerAlias("left stick click", 10);
  registerAlias("l3", 10);
  registerAlias("right stick", 11);
  registerAlias("right stick click", 11);
  registerAlias("r3", 11);
  registerAlias("d-pad up", 12);
  registerAlias("d-pad down", 13);
  registerAlias("d-pad left", 14);
  registerAlias("d-pad right", 15);
  registerAlias("home", 16);

  return aliases;
}

function normalizeGamepadButtonList(buttons) {
  const uniqueButtons = [];
  const seen = new Set();

  (Array.isArray(buttons) ? buttons : []).forEach((button) => {
    const numericButton = Number(button);
    if (!Number.isInteger(numericButton) || numericButton < 0 || seen.has(numericButton)) {
      return;
    }
    seen.add(numericButton);
    uniqueButtons.push(numericButton);
  });

  uniqueButtons.sort((a, b) => {
    const priorityDelta = getGamepadButtonSortKey(a) - getGamepadButtonSortKey(b);
    return priorityDelta !== 0 ? priorityDelta : a - b;
  });

  return uniqueButtons;
}

function createGamepadBindingDescriptor(buttons, valid = true) {
  const normalizedButtons = normalizeGamepadButtonList(buttons);
  return {
    valid,
    disabled: normalizedButtons.length === 0,
    buttons: normalizedButtons,
    label:
      normalizedButtons.length > 0
        ? normalizedButtons.map((button) => getGamepadButtonLabel(button)).join(" + ")
        : "Disabled",
  };
}

function parseGamepadButtonToken(token) {
  const normalizedToken = normalizeGamepadButtonToken(token);
  if (!normalizedToken) {
    return null;
  }

  if (/^-?\d+$/.test(normalizedToken)) {
    const numericToken = Number(normalizedToken);
    return numericToken >= 0 ? numericToken : -1;
  }

  const buttonMatch = normalizedToken.match(/^button\s+(\d+)$/);
  if (buttonMatch) {
    return Number(buttonMatch[1]);
  }

  return Object.prototype.hasOwnProperty.call(GAMEPAD_BUTTON_ALIAS_LOOKUP, normalizedToken)
    ? GAMEPAD_BUTTON_ALIAS_LOOKUP[normalizedToken]
    : null;
}

function parseGamepadBindingValue(value) {
  if (value === null || value === undefined) {
    return createGamepadBindingDescriptor([], false);
  }

  if (Array.isArray(value)) {
    return createGamepadBindingDescriptor(value, true);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 0 ? createGamepadBindingDescriptor([value], true) : createGamepadBindingDescriptor([], true);
  }

  if (typeof value === "string") {
    const trimmedValue = value.trim();
    if (!trimmedValue || /^(disabled|none|off)$/i.test(trimmedValue)) {
      return createGamepadBindingDescriptor([], true);
    }

    if (/^-?\d+$/.test(trimmedValue)) {
      return parseGamepadBindingValue(Number(trimmedValue));
    }

    const tokens = trimmedValue.split(/\s*\+\s*/).filter((token) => token.trim().length > 0);
    if (tokens.length === 0) {
      return createGamepadBindingDescriptor([], false);
    }

    const parsedButtons = [];
    for (const token of tokens) {
      const buttonIndex = parseGamepadButtonToken(token);
      if (buttonIndex === null || buttonIndex < 0) {
        return createGamepadBindingDescriptor([], false);
      }
      parsedButtons.push(buttonIndex);
    }

    return createGamepadBindingDescriptor(parsedButtons, true);
  }

  return createGamepadBindingDescriptor([], false);
}

function normalizeGamepadBindingValue(value, fallbackValue = null) {
  const parsedBinding = parseGamepadBindingValue(value);
  if (parsedBinding.valid) {
    return parsedBinding;
  }

  if (fallbackValue !== null && fallbackValue !== undefined && fallbackValue !== value) {
    const fallbackBinding = parseGamepadBindingValue(fallbackValue);
    if (fallbackBinding.valid) {
      return fallbackBinding;
    }
  }

  return createGamepadBindingDescriptor([], true);
}

function formatGamepadBindingValue(value, fallbackValue = null) {
  return normalizeGamepadBindingValue(value, fallbackValue).label;
}

function setGamepadBindingInputValue(inputId, value) {
  const input = document.getElementById(inputId);
  const config = GAMEPAD_BINDING_INPUT_CONFIG[inputId];
  if (!input || !config) {
    return;
  }

  input.value = formatGamepadBindingValue(value, config.fallbackValue);
}

function getPressedGamepadButtons(gamepad) {
  const pressedButtons = [];
  Object.entries(gamepad?.buttons || {}).forEach(([index, button]) => {
    if (button === true || (button && (button.pressed || button.value > 0.5))) {
      pressedButtons.push(Number(index));
    }
  });
  return normalizeGamepadButtonList(pressedButtons);
}

function setOverlayInputTestSuppression(active) {
  setOverlayInputSuppressionReason("input-test", active);
}

function setOverlayGamepadBindingCaptureSuppression(active) {
  setOverlayInputSuppressionReason("binding-capture", active);
}

function setOverlayInputSuppressionReason(reason, active) {
  if (active) {
    activeGamepadSuppressionReasons.add(reason);
  } else {
    activeGamepadSuppressionReasons.delete(reason);
  }

  const nextSuppressed = activeGamepadSuppressionReasons.size > 0;
  if (nextSuppressed === overlayInputSuppressed) {
    return;
  }

  overlayInputSuppressed = nextSuppressed;
  ipcRenderer.send("gamepad-input-test-active", { active: nextSuppressed });
}

function getConnectedGamepads() {
  // Capture exactly the IDs used by navigation. Chromium's raw layout can
  // differ from gilrs and may not expose the device at all.
  if (gamepadStatusSocket?.readyState === WebSocket.OPEN) {
    return Array.from(serverGamepadStates.values()).filter((g) => !isGamepadDeviceBlacklisted(g.id));
  }
  // Chromium cannot distinguish XInput from DirectInput reliably. On
  // Windows, require the server so a disabled listener stays disabled.
  if (process.platform === "win32" || !navigator.getGamepads) return [];
  const gamepads = navigator.getGamepads();
  return Array.from(gamepads).filter((g) => g !== null && !isGamepadDeviceBlacklisted(g.id));
}

function updateServerGamepadState(data) {
  const device = data.device;
  if (typeof device !== "string" || !device) return;
  if (data.type === "gamepad_disconnected") {
    serverReportedGamepads.delete(device);
    serverGamepadStates.delete(device);
    pollGamepadBindingCapture();
    return;
  }
  if (isGamepadDeviceBlacklisted(device)) return;
  if (!["gamepad_connected", "gamepad_state", "button", "axis"].includes(data.type)) return;
  serverReportedGamepads.add(device);
  let gamepad = serverGamepadStates.get(device);
  if (!gamepad || data.type === "gamepad_connected") {
    gamepad = { id: device, index: `server:${device}`, buttons: {}, axes: {} };
    serverGamepadStates.set(device, gamepad);
  }
  if (data.type === "gamepad_connected" || data.type === "gamepad_state") {
    const state = data.type === "gamepad_connected" ? data.state : data;
    gamepad.buttons = { ...state?.buttons };
    gamepad.axes = { ...state?.axes };
  } else if (data.type === "button" && Number.isSafeInteger(data.button) && data.button >= 0) {
    gamepad.buttons[data.button] = data.pressed === true;
  } else if (data.type === "axis" && typeof data.axis === "string" && Number.isFinite(data.value)) {
    gamepad.axes[data.axis] = data.value;
  }
  // Poll on edges as well as on the timer so a quick tap is never missed.
  pollGamepadBindingCapture();
}

function clearServerGamepadState() {
  serverReportedGamepads.clear();
  serverGamepadStates.clear();
  if (activeGamepadBindingCapture) {
    activeGamepadBindingCapture.lockedGamepadIndex = null;
    activeGamepadBindingCapture.capturedButtons = null;
  }
}

function updateGamepadStatus() {
  const statusText = document.getElementById("gamepadStatusText");
  if (!statusText) return;

  const serverNames = Array.from(serverReportedGamepads.values()).filter(
    (deviceName) => !isGamepadDeviceBlacklisted(deviceName),
  );
  if (serverNames.length > 0) {
    if (serverNames.length === 1) {
      statusText.textContent = `✓ ${getDisplayControllerLabel(serverNames[0])}`;
    } else {
      statusText.textContent = `✓ ${serverNames.length} controllers connected`;
    }
    statusText.style.color = "#4CAF50";
    renderGamepadDeviceLists();
    return;
  }

  const connectedGamepads = getConnectedGamepads();

  if (connectedGamepads.length === 0) {
    statusText.textContent = "No controller connected";
    statusText.style.color = "#888";
  } else if (connectedGamepads.length === 1) {
    statusText.textContent = `✓ ${getDisplayControllerLabel(connectedGamepads[0].id)}`;
    statusText.style.color = "#4CAF50";
  } else {
    statusText.textContent = `✓ ${connectedGamepads.length} controllers connected`;
    statusText.style.color = "#4CAF50";
  }

  renderGamepadDeviceLists();
}

function connectGamepadStatusSocket(port) {
  const parsedPort = parseInt(port, 10);
  const targetPort = Number.isFinite(parsedPort) ? parsedPort : 7276;
  const socketReady =
    gamepadStatusSocket &&
    (gamepadStatusSocket.readyState === WebSocket.OPEN || gamepadStatusSocket.readyState === WebSocket.CONNECTING);
  if (socketReady && gamepadStatusSocketPort === targetPort) {
    return;
  }

  if (gamepadStatusSocketReconnectTimer) {
    clearTimeout(gamepadStatusSocketReconnectTimer);
    gamepadStatusSocketReconnectTimer = null;
  }

  if (gamepadStatusSocket) {
    try {
      gamepadStatusSocket.close();
    } catch (e) {
      // Ignore close errors.
    }
    gamepadStatusSocket = null;
  }

  gamepadStatusSocketPort = targetPort;
  clearServerGamepadState();
  updateGamepadStatus();

  let ws = null;
  try {
    ws = new WebSocket(`ws://localhost:${targetPort}`);
  } catch (e) {
    scheduleGamepadStatusSocketReconnect();
    return;
  }

  gamepadStatusSocket = ws;

  ws.onopen = () => {
    if (gamepadStatusSocket !== ws) return;
    try {
      ws.send(JSON.stringify({ type: "configure_features", features: ["keyboard"] }));
      sendGamepadDeviceBlacklistToServer();
      ws.send(JSON.stringify({ type: "get_state" }));
    } catch (e) {
      // Ignore send error and rely on reconnect.
    }
  };

  ws.onmessage = (event) => {
    if (gamepadStatusSocket !== ws) return;
    if (!event || typeof event.data !== "string") return;

    let data = null;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      return;
    }

    if (!data || typeof data !== "object") return;
    updateServerGamepadState(data);
    const deviceName = typeof data.device === "string" ? data.device : "";
    switch (data.type) {
      case "gamepad_connected":
        if (deviceName && !isGamepadDeviceBlacklisted(deviceName)) serverReportedGamepads.add(deviceName);
        updateGamepadStatus();
        break;
      case "gamepad_disconnected":
        if (deviceName) serverReportedGamepads.delete(deviceName);
        updateGamepadStatus();
        break;
      case "gamepad_state":
        if (deviceName && !isGamepadDeviceBlacklisted(deviceName)) serverReportedGamepads.add(deviceName);
        updateGamepadStatus();
        break;
      case "device_blacklist_updated":
        setGamepadDeviceBlacklist(data.devices, { persist: false, send: false });
        break;
      case "keyboard_event":
        // Forward server keyboard events for keyboard binding capture
        window.dispatchEvent(
          new CustomEvent("gsm-keyboard-event", {
            detail: {
              key: data.key,
              pressed: data.pressed,
              modifiers: data.modifiers || {},
            },
          }),
        );
        break;
      case "mouse_event":
        // Mouse4/Mouse5 use the same capture surface as keyboard bindings.
        window.dispatchEvent(
          new CustomEvent("gsm-keyboard-event", {
            detail: {
              key: data.key,
              pressed: data.pressed,
              modifiers: data.modifiers || {},
            },
          }),
        );
        break;
      default:
        break;
    }
  };

  ws.onerror = () => {};

  ws.onclose = () => {
    if (gamepadStatusSocket !== ws) return;
    gamepadStatusSocket = null;
    clearServerGamepadState();
    updateGamepadStatus();
    scheduleGamepadStatusSocketReconnect();
  };
}

function scheduleGamepadStatusSocketReconnect() {
  if (gamepadStatusSocketReconnectTimer) return;
  gamepadStatusSocketReconnectTimer = setTimeout(() => {
    gamepadStatusSocketReconnectTimer = null;
    const portEl = document.getElementById("gamepadServerPort");
    connectGamepadStatusSocket(portEl ? parseInt(portEl.value, 10) || 7276 : 7276);
  }, 2500);
}

function buildGamepadInputSnapshot(gamepad) {
  const activeAxes = {};
  Object.entries(gamepad.axes || {}).forEach(([index, value]) => {
    const rounded = Number((Number(value) || 0).toFixed(2));
    if (Math.abs(rounded) >= 0.12) {
      activeAxes[index] = rounded;
    }
  });

  return {
    index: gamepad.index,
    id: gamepad.id,
    buttons: getPressedGamepadButtons(gamepad),
    axes: activeAxes,
  };
}

function formatGamepadSnapshot(snapshot) {
  const buttonPart = snapshot.buttons.length
    ? `buttons=[${snapshot.buttons.map((index) => getGamepadButtonLabel(index)).join(", ")}]`
    : "buttons=[]";
  const axisEntries = Object.entries(snapshot.axes || {});
  const axisPart = axisEntries.length
    ? `axes=${axisEntries.map(([axis, value]) => `${getGamepadAxisLabel(axis)}:${value}`).join(" ")}`
    : "axes=idle";
  return `${getDisplayControllerLabel(snapshot.id)} | ${buttonPart} | ${axisPart}`;
}

function setGamepadInputTestUi(running) {
  const toggleButton = document.getElementById("gamepadInputTestToggle");
  const status = document.getElementById("gamepadInputTestStatus");
  if (toggleButton) {
    toggleButton.textContent = running ? "Stop Test" : "Start Test";
  }
  if (status) {
    status.textContent = running ? "Running" : "Idle";
    status.style.color = running ? "#4CAF50" : "#888";
  }
}

function startGamepadInputTest() {
  if (gamepadInputTestInterval !== null) return;
  previousGamepadInputSignature = "";
  setGamepadInputTestUi(true);
  setOverlayInputTestSuppression(true);
  console.log("[Gamepad Input Test] Started");
  addGamepadInputConsoleLine("Input test started (overlay input suppressed)");

  gamepadInputTestInterval = setInterval(() => {
    const connectedGamepads = getConnectedGamepads();
    if (connectedGamepads.length === 0) {
      if (previousGamepadInputSignature !== "no-gamepad") {
        previousGamepadInputSignature = "no-gamepad";
        console.log("[Gamepad Input Test] No controller connected");
        addGamepadInputConsoleLine("No controller connected");
      }
      return;
    }

    const snapshot = buildGamepadInputSnapshot(connectedGamepads[0]);
    const signature = JSON.stringify(snapshot);
    if (signature !== previousGamepadInputSignature) {
      previousGamepadInputSignature = signature;
      console.log("[Gamepad Input Test]", snapshot);
      addGamepadInputConsoleLine(formatGamepadSnapshot(snapshot));
    }
  }, 100);
}

function stopGamepadInputTest() {
  if (gamepadInputTestInterval === null) return;
  clearInterval(gamepadInputTestInterval);
  gamepadInputTestInterval = null;
  setGamepadInputTestUi(false);
  previousGamepadInputSignature = "";
  setOverlayInputTestSuppression(false);
  console.log("[Gamepad Input Test] Stopped");
  addGamepadInputConsoleLine("Input test stopped (overlay input restored)");
}

// Check gamepad server connection status
function checkGamepadServerStatus(port) {
  const serverStatusEl = document.getElementById("gamepadServerStatus");
  if (!serverStatusEl) return;

  try {
    const ws = new WebSocket(`ws://localhost:${port}`);

    ws.onopen = () => {
      serverStatusEl.textContent = "✅ Connected";
      serverStatusEl.style.color = "#4ade80";
      ws.close();
    };

    ws.onerror = () => {
      serverStatusEl.textContent = "❌ Not running";
      serverStatusEl.style.color = "#f87171";
    };

    ws.onclose = () => {};
  } catch (e) {
    serverStatusEl.textContent = "❌ Error: " + e.message;
    serverStatusEl.style.color = "#f87171";
  }
}

function initializeSettingsInputs() {
  // Distinguish paired fields without changing their IDs or capture handlers.
  document.querySelectorAll(".gamepad-binding-input, .keyboard-binding-input").forEach((input) => {
    const kind = input.classList.contains("gamepad-binding-input") ? "Controller" : "Keyboard";
    const label = input.closest("label")?.querySelector(".label-text")?.firstChild?.textContent.trim();
    input.setAttribute("aria-label", `${label || input.id} (${kind})`);
    const caption = document.createElement("span");
    caption.className = "binding-device-label";
    caption.textContent = kind;
    caption.setAttribute("aria-hidden", "true");
    input.closest(".setting-control-shell")?.prepend(caption);
  });
  // Check gamepad status periodically
  gamepadStatusInterval = setInterval(updateGamepadStatus, 2000);
  updateGamepadStatus();
  setGamepadInputTestUi(false);
  renderGamepadDeviceLists();
  renderGamepadInputConsole();
  connectGamepadStatusSocket(parseInt(document.getElementById("gamepadServerPort")?.value, 10) || 7276);

  const gamepadInputTestToggle = document.getElementById("gamepadInputTestToggle");
  if (gamepadInputTestToggle) {
    gamepadInputTestToggle.addEventListener("click", () => {
      if (gamepadInputTestInterval === null) {
        startGamepadInputTest();
      } else {
        stopGamepadInputTest();
      }
    });
  }

  const gamepadInputConsoleClear = document.getElementById("gamepadInputConsoleClear");
  if (gamepadInputConsoleClear) {
    gamepadInputConsoleClear.addEventListener("click", () => {
      clearGamepadInputConsole();
    });
  }

  // Listen for gamepad connect/disconnect events
  window.addEventListener("gamepadconnected", (e) => {
    console.log("Gamepad connected:", e.gamepad.id);
    addGamepadInputConsoleLine(`Gamepad connected: ${getDisplayControllerLabel(e.gamepad.id)}`);
    updateGamepadStatus();
  });

  window.addEventListener("gamepaddisconnected", (e) => {
    console.log("Gamepad disconnected:", e.gamepad.id);
    addGamepadInputConsoleLine(`Gamepad disconnected: ${getDisplayControllerLabel(e.gamepad.id)}`);
    updateGamepadStatus();
  });

  window.addEventListener("beforeunload", () => {
    stopGamepadBindingCapture({ restorePrevious: false });
    stopGamepadInputTest();
    setOverlayInputTestSuppression(false);
    setOverlayGamepadBindingCaptureSuppression(false);
    if (gamepadStatusSocketReconnectTimer) {
      clearTimeout(gamepadStatusSocketReconnectTimer);
      gamepadStatusSocketReconnectTimer = null;
    }
    if (gamepadStatusSocket) {
      try {
        gamepadStatusSocket.close();
      } catch (e) {
        // Ignore close errors.
      }
      gamepadStatusSocket = null;
    }
  });
  // Refresh server status periodically
  setInterval(() => {
    const portEl = document.getElementById("gamepadServerPort");
    if (portEl) {
      checkGamepadServerStatus(parseInt(portEl.value) || 7276);
    }
  }, 5000);
}
