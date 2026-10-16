// Setting definitions, normalization, defaults, and persistence bindings.
// Keep IDs and setting keys stable when moving controls between pages.
const HOTKEY_BINDING_OPTIONS = Object.freeze({
  showHotkey: { warningElementId: "ctrl-warning", showCtrlWarning: true, placeholder: "Press keys..." },
  toggleFuriganaHotkey: {
    warningElementId: "furigana-ctrl-warning",
    showCtrlWarning: true,
    placeholder: "Press keys...",
  },
  translateHotkey: {
    warningElementId: "translate-ctrl-warning",
    showCtrlWarning: true,
    placeholder: "Press keys...",
  },
  liveStatsToggleHotkey: {
    warningElementId: "livestatstoggle-ctrl-warning",
    showCtrlWarning: true,
    placeholder: "Press keys...",
  },
  toggleWindowHotkey: {
    warningElementId: "togglewindow-ctrl-warning",
    showCtrlWarning: true,
    placeholder: "Press keys...",
  },
  minimizeHotkey: { warningElementId: "minimize-ctrl-warning", showCtrlWarning: true, placeholder: "Press keys..." },
  yomitanSettingsHotkey: {
    warningElementId: "yomitansettings-ctrl-warning",
    showCtrlWarning: true,
    placeholder: "Press keys...",
  },
  overlaySettingsHotkey: {
    warningElementId: "overlaysettings-ctrl-warning",
    showCtrlWarning: true,
    placeholder: "Press keys...",
  },
  texthookerHotkey: {
    warningElementId: "texthooker-ctrl-warning",
    showCtrlWarning: true,
    placeholder: "Press keys...",
  },
  customPageHotkey: {
    warningElementId: "custompage-ctrl-warning",
    showCtrlWarning: true,
    placeholder: "Press keys...",
  },
  vnGuideToggleHotkey: { showCtrlWarning: false, placeholder: "Press keys..." },
  vnGuideNextHotkey: { showCtrlWarning: false, placeholder: "Press keys..." },
  vnGuideBackHotkey: { showCtrlWarning: false, placeholder: "Press keys..." },
  gamepadKeyboardHotkey: {
    warningElementId: "gamepadkeyboard-ctrl-warning",
    showCtrlWarning: true,
    placeholder: "Press keys...",
  },
});
const VALID_PLATFORM_OVERRIDE_VALUES = new Set(["win32", "linux", "darwin"]);
const VALID_MANUAL_MODE_TYPES = new Set(["hold", "toggle"]);
const VALID_MANUAL_MODE_INACTIVE_BEHAVIORS = new Set(["hide-overlay", "disable-interaction"]);
const VALID_GAMEPAD_ACTIVATION_MODES = new Set(["modifier", "toggle"]);
const VALID_GAMEPAD_TOKENIZER_BACKENDS = new Set([
  "mecab",
  "sudachi",
  "yomitan-bridge",
  "yomitan-api",
  "jiten-api",
  "jpdb-api",
]);
const VALID_LOCAL_TOKENIZER_FALLBACK_BACKENDS = new Set(["mecab", "sudachi"]);
const VALID_SUDACHI_DICTIONARIES = new Set(["small", "core", "full"]);
const VALID_LIVE_STATS_SCOPES = new Set(["session", "today"]);
const VALID_LIVE_STATS_DISPLAY_MODES = new Set(["always", "new-line"]);
const VALID_LIVE_STATS_LAYOUTS = new Set(["stacked", "one-line"]);
const VALID_LIVE_STATS_POSITION_MODES = new Set(["active-window", "overlay"]);
const LIVE_STATS_FIELD_DEFINITIONS = [
  { key: "chars_per_hour", controlId: "liveStatsFieldCharsPerHour" },
  { key: "total_characters", controlId: "liveStatsFieldTotalCharacters" },
  { key: "active_reading_time", controlId: "liveStatsFieldActiveReadingTime" },
  { key: "raw_reading_time", controlId: "liveStatsFieldRawReadingTime" },
  { key: "cards_mined", controlId: "liveStatsFieldCardsMined" },
];
let overlaySettingDefaults = {};
const settingBindingMap = new Map();
const settingBindingState = new Map();
let manualHotkeyRuntimeState = {
  backend: "electron",
  backendReason: "electron",
  keyboardAvailable: true,
  keyboardError: null,
};

function toArray(value) {
  return Array.isArray(value) ? value : [value];
}

function clampNumericValue(
  value,
  fallback,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  integer = false,
) {
  const numeric = integer ? Number.parseInt(value, 10) : Number.parseFloat(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

function normalizeTrimmedString(value, fallback = "") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function normalizeHotkeyForComparison(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function normalizeTokenizerBackendValue(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return VALID_GAMEPAD_TOKENIZER_BACKENDS.has(normalized) ? normalized : "sudachi";
}

function normalizeSudachiDictionaryValue(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return VALID_SUDACHI_DICTIONARIES.has(normalized) ? normalized : "core";
}

function normalizeLocalTokenizerFallbackBackendValue(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return VALID_LOCAL_TOKENIZER_FALLBACK_BACKENDS.has(normalized) ? normalized : "sudachi";
}

function normalizeYomitanApiUrlValue(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\/+$/, "");
  return normalized || "http://127.0.0.1:19633";
}

function normalizePlatformOverrideValue(value) {
  if (value === null || value === undefined || value === "" || value === "null") {
    return null;
  }
  const normalized = String(value).trim();
  return VALID_PLATFORM_OVERRIDE_VALUES.has(normalized) ? normalized : null;
}

function normalizeManualModeTypeValue(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return VALID_MANUAL_MODE_TYPES.has(normalized) ? normalized : "hold";
}

function normalizeManualModeInactiveBehaviorValue(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return VALID_MANUAL_MODE_INACTIVE_BEHAVIORS.has(normalized) ? normalized : "hide-overlay";
}

function normalizeGamepadActivationModeValue(value) {
  const normalized = String(value || "").trim();
  return VALID_GAMEPAD_ACTIVATION_MODES.has(normalized) ? normalized : "modifier";
}

function normalizeLiveStatsScopeValue(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return VALID_LIVE_STATS_SCOPES.has(normalized) ? normalized : "session";
}

function normalizeLiveStatsDisplayModeValue(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return VALID_LIVE_STATS_DISPLAY_MODES.has(normalized) ? normalized : "always";
}

function normalizeLiveStatsLayoutValue(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return VALID_LIVE_STATS_LAYOUTS.has(normalized) ? normalized : "one-line";
}

function normalizeLiveStatsPositionModeValue(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return VALID_LIVE_STATS_POSITION_MODES.has(normalized) ? normalized : "active-window";
}

function normalizeLiveStatsFieldsValue(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalized = {};
  LIVE_STATS_FIELD_DEFINITIONS.forEach((field) => {
    normalized[field.key] = source[field.key] !== false;
  });
  return normalized;
}

function areLiveStatsFieldsEqual(left, right) {
  const normalizedLeft = normalizeLiveStatsFieldsValue(left);
  const normalizedRight = normalizeLiveStatsFieldsValue(right);
  return LIVE_STATS_FIELD_DEFINITIONS.every((field) => normalizedLeft[field.key] === normalizedRight[field.key]);
}

function normalizeBooleanValue(value) {
  return value === true;
}

function composeAfterApply(...callbacks) {
  const activeCallbacks = callbacks.filter((callback) => typeof callback === "function");
  if (activeCallbacks.length === 0) {
    return null;
  }

  return (value, context) => {
    activeCallbacks.forEach((callback) => {
      callback(value, context);
    });
  };
}

function defaultReadBindingValue(control) {
  if (!control) return undefined;
  if (control.type === "checkbox") {
    return control.checked === true;
  }
  return control.value;
}

function defaultWriteBindingValue(control, value) {
  if (!control) return;
  if (control.type === "checkbox") {
    control.checked = value === true;
    return;
  }
  control.value = value ?? "";
}

function getBindingDefaultValue(binding) {
  if (typeof binding.getDefault === "function") {
    return binding.getDefault(overlaySettingDefaults);
  }
  const defaultKey = binding.defaultKey || binding.key;
  return overlaySettingDefaults[defaultKey];
}

function areBindingValuesEqual(binding, left, right) {
  if (typeof binding.equals === "function") {
    return binding.equals(left, right);
  }
  return left === right;
}

function ensureSettingControlShell(control) {
  if (!control || !control.parentElement) {
    return null;
  }

  const existingShell = control.closest(".setting-control-shell");
  if (existingShell && existingShell.contains(control)) {
    return existingShell;
  }

  const parent = control.parentElement;
  if (parent.classList.contains("input-container")) {
    parent.classList.add("setting-control-shell");
    return parent;
  }

  const shell = document.createElement("span");
  shell.className = "setting-control-shell";
  parent.insertBefore(shell, control);
  shell.appendChild(control);
  return shell;
}

function addResetButtonToBindingControl(binding, control) {
  const shell = ensureSettingControlShell(control);
  if (!shell) return;

  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.className = "setting-reset-button hidden";
  resetButton.textContent = "↺";
  resetButton.title = "Reset to default";
  resetButton.setAttribute("aria-label", "Reset to default");
  resetButton._gsmTargetControl = control;
  resetButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void resetSettingToDefault(binding.key);
  });

  shell.appendChild(resetButton);
  binding.resetButtons.push(resetButton);
}

function updateBindingResetButtons(binding) {
  const defaultValue = getBindingDefaultValue(binding);
  const currentValue = settingBindingState.get(binding.key);
  const isDefault = defaultValue === undefined || areBindingValuesEqual(binding, currentValue, defaultValue);

  binding.resetButtons.forEach((button) => {
    const targetControl = button._gsmTargetControl;
    button.classList.toggle("hidden", isDefault);
    button.disabled = isDefault || Boolean(targetControl?.disabled);
  });
}

function applyBindingValue(binding, value, options = {}) {
  const normalizedValue = typeof binding.normalize === "function" ? binding.normalize(value) : value;
  settingBindingState.set(binding.key, normalizedValue);

  binding.controls.forEach((control) => {
    if (control !== options.sourceControl) {
      if (typeof binding.write === "function") {
        binding.write(control, normalizedValue);
      } else {
        defaultWriteBindingValue(control, normalizedValue);
      }
    }
  });

  if (options.sourceControl && binding.controls.includes(options.sourceControl)) {
    if (typeof binding.write === "function") {
      binding.write(options.sourceControl, normalizedValue);
    } else {
      defaultWriteBindingValue(options.sourceControl, normalizedValue);
    }
  }

  if (typeof binding.afterApply === "function") {
    binding.afterApply(normalizedValue, options);
  }

  updateBindingResetButtons(binding);
  window.GSMSettingsHome?.refresh();
  return normalizedValue;
}

// Delegated to the shared Manual Mode card component (single source of truth).
function splitHotkeyParts(hotkey) {
  return GSMManualModeCard.splitHotkeyParts(hotkey);
}

function isModifierOnlyHotkey(hotkey) {
  return GSMManualModeCard.isModifierOnlyHotkey(hotkey);
}

function predictManualHotkeyBackend(hotkey) {
  return GSMManualModeCard.predictManualHotkeyBackend(hotkey);
}

function syncManualHotkeyStatusUi() {
  const backendElement = document.getElementById("manualHotkeyBackendStatus");
  const platformWarning = document.getElementById("manual-hotkey-platform-warning");
  const runtimeWarning = document.getElementById("manual-hotkey-runtime-warning");
  const mouseHoldWarning = document.getElementById("manual-hotkey-mouse-hold-warning");
  if (!backendElement || !platformWarning || !runtimeWarning || !mouseHoldWarning) {
    return;
  }

  const configuredHotkey = settingBindingState.get("showHotkey") || document.getElementById("showHotkey")?.value || "";
  const manualModeType = normalizeManualModeTypeValue(
    settingBindingState.get("manualModeType") || document.getElementById("manualModeType")?.value || "hold",
  );
  const predictedBackend = predictManualHotkeyBackend(configuredHotkey);
  const backend = manualHotkeyRuntimeState.backend || predictedBackend;
  const backendLabel = backend === "input_server" ? "Input Server" : "Electron";
  let statusText = `Backend: ${backendLabel}`;
  if (backend === "electron" && predictedBackend !== "electron") {
    statusText = "Backend: Electron (pending reconfiguration)";
  } else if (backend === "input_server" && manualHotkeyRuntimeState.backendReason === "electron-registration-failed") {
    statusText = "Backend: Input Server (Electron registration fallback)";
  }
  if (backend === "electron" && manualModeType === "hold") {
    statusText += " | Hold detection is best-effort";
  }
  backendElement.textContent = statusText;

  platformWarning.style.display = "none";
  runtimeWarning.style.display = "none";
  mouseHoldWarning.style.display = "none";
  platformWarning.textContent = "";
  runtimeWarning.textContent = "";
  mouseHoldWarning.textContent = "";

  const mouseHoldWarningText = GSMManualModeCard.getMouseHotkeyHoldWarning(configuredHotkey, manualModeType);
  if (mouseHoldWarningText) {
    mouseHoldWarning.textContent = mouseHoldWarningText;
    mouseHoldWarning.style.display = "block";
  }

  const platform =
    document.getElementById("platform-override")?.value &&
    document.getElementById("platform-override")?.value !== "null"
      ? document.getElementById("platform-override").value
      : process.platform;

  if (backend === "input_server") {
    if (platform === "darwin") {
      platformWarning.textContent = "Input-server manual hotkeys on macOS require Accessibility permission.";
      platformWarning.style.display = "block";
    } else if (platform === "linux") {
      platformWarning.textContent = "Linux manual hotkeys are best-effort. Wayland may block global keyboard hooks.";
      platformWarning.style.display = "block";
    }
  } else if (backend === "electron" && manualModeType === "hold") {
    platformWarning.textContent =
      "Electron hold mode uses repeat/watchdog release detection because global shortcuts do not expose key-up.";
    platformWarning.style.display = "block";
  }

  if (
    backend === "input_server" &&
    (manualHotkeyRuntimeState.keyboardAvailable === false || manualHotkeyRuntimeState.keyboardError)
  ) {
    runtimeWarning.textContent =
      manualHotkeyRuntimeState.keyboardError || "Input-server keyboard listener unavailable.";
    runtimeWarning.style.display = "block";
  }
}

async function persistBindingValue(binding, value, sourceControl) {
  if (typeof binding.persist === "function") {
    return binding.persist(value, sourceControl);
  }
  return handleSettingChange(binding.key, value, sourceControl);
}

async function commitSettingValue(settingKey, value, sourceControl) {
  const binding = settingBindingMap.get(settingKey);
  if (!binding) {
    return handleSettingChange(settingKey, value, sourceControl);
  }

  const normalizedValue = applyBindingValue(binding, value, { sourceControl, source: "user" });
  await persistBindingValue(binding, normalizedValue, sourceControl);
  refreshActivePresetHighlight();
  return normalizedValue;
}

function setSettingValueWithoutPersist(settingKey, value, options = {}) {
  const binding = settingBindingMap.get(settingKey);
  if (!binding) {
    return value;
  }
  return applyBindingValue(binding, value, { ...options, source: "preload" });
}

async function resetSettingToDefault(settingKey) {
  const binding = settingBindingMap.get(settingKey);
  if (!binding) return;

  const defaultValue = getBindingDefaultValue(binding);
  if (defaultValue === undefined) return;

  await commitSettingValue(settingKey, defaultValue, null);
}

function refreshAllResetButtons() {
  window.GSMSettingsHome?.refresh();
  settingBindingMap.forEach((binding) => {
    updateBindingResetButtons(binding);
  });
}

function syncShowMainBoxStartupUi() {
  const showMainBoxOnStartup = document.getElementById("showMainBoxOnStartup");
  const modal = document.getElementById("main-box-warning-modal");
  if (!showMainBoxOnStartup || !modal) return;

  if (showMainBoxOnStartup.checked && !mainBoxStartupWarningAcknowledged) {
    showMainBoxStartupWarning();
  } else {
    modal.classList.remove("visible");
  }
}

function syncJitenReaderUi(enabled) {
  const checkbox = document.getElementById("enableJitenReader");
  const isEnabled = enabled !== undefined ? enabled : checkbox?.checked !== false;
  ["openJitenReaderSettings", "jitenHighlightingEnabled", "jitenHighlightOffsetY", "showJitenGradingButtons"].forEach(
    (id) => {
      const control = document.getElementById(id);
      if (control) {
        control.disabled = !isEnabled;
      }
    },
  );
}

function syncDisableInteractionSubOptionsUi() {
  const select = document.getElementById("manualModeInactiveBehavior");
  const isDisableInteraction = select && select.value === "disable-interaction";
  const label = document.getElementById("manualModeDisableInteractionFocusOverlayLabel");
  if (label) label.style.display = isDisableInteraction ? "" : "none";
}

function syncReadingLanguageUi() {
  const select = document.getElementById("readingLanguage");
  const group = document.getElementById("pinyinToneColorsGroup");
  if (!select || !group) return;
  group.style.display = select.value === "chinese" ? "" : "none";
}

// The OCR-area subset toggles only apply when OCR Area Config is enabled.
function syncOcrAreaSubsetUi() {
  const enabled = document.getElementById("use_overlay_area_config")?.checked === true;
  [
    "ocr_area_config_include_primary_areas",
    "ocr_area_config_include_secondary_areas",
    "ocr_area_config_use_exclusion_zones",
  ].forEach((id) => {
    const control = document.getElementById(id);
    if (control) control.disabled = !enabled;
  });
}

function syncLastSentOcrPresenceUi() {
  const enabled = document.getElementById("last_sent_ocr_presence_check")?.checked === true;
  ["last_sent_ocr_presence_remove_notation", "last_sent_ocr_presence_invalidate_lookups"].forEach((id) => {
    const control = document.getElementById(id);
    if (control) control.disabled = !enabled;
  });
}

function syncGamepadSettingsEnabledUi() {
  const enabled = document.getElementById("gamepadEnabled")?.checked !== false;
  updateGamepadSettingsVisibility(enabled);

  [
    "gamepadActivationMode",
    "gamepadConfirmButton",
    "gamepadCancelButton",
    "gamepadForwardEnterButton",
    "gamepadForwardSpaceButton",
    "gamepadForwardCtrlButton",
    "gamepadForwardEscapeButton",
    "gamepadForwardClickButton",
    "gamepadManualOverlayScanButton",
    "gamepadTranslateButton",
    "gamepadPauseToggleButton",
    "gamepadTokenModeToggleButton",
    "gamepadMineButton",
    "gamepadNextEntryButton",
    "gamepadPrevEntryButton",
    "gamepadPrevJitenWordButton",
    "gamepadNextJitenWordButton",
    "gamepadNavigateUp",
    "gamepadNavigateDown",
    "gamepadNavigateLeft",
    "gamepadNavigateRight",
    "gamepadTokenMode",
    "gamepadAutoConfirmSelection",
    "gamepadFocusOverlayOnEntry",
    "gamepadShowModeIndicator",
    "gamepadShowNavigationStatus",
    "gamepadRepeatDelay",
    "gamepadRepeatRate",
    "gamepadHoldNavigation",
    "gamepadHorizontalWrap",
    "gamepadVerticalNavigation",
    "gamepadInitialPosition",
    "gamepadBlockJumpAnimation",
    "gamepadAnalogAcceleration",
    "gamepadServerPort",
    "gamepadControllerEnabled",
    "gamepadKeyboardEnabled",
    "gamepadKeyboardHotkey",
  ].forEach((id) => {
    const control = document.getElementById(id);
    if (control) {
      control.disabled = !enabled;
    }
  });

  stopGamepadBindingCaptureIfDisabled();
  updateControllerActivationFieldState();
  updateTokenizerBackendFieldState();
  refreshAllResetButtons();
}

function syncHotkeyWarningUi(settingKey, value) {
  const hotkeyOptions = HOTKEY_BINDING_OPTIONS[settingKey];
  if (!hotkeyOptions?.warningElementId || !hotkeyOptions.showCtrlWarning) {
    return;
  }
  updateCtrlWarning(String(value || ""), hotkeyOptions.warningElementId);
}

function createCheckboxBinding(key, selectors, options = {}) {
  return {
    key,
    selectors: toArray(selectors),
    event: "change",
    read: (control) => control.checked === true,
    write: (control, value) => {
      control.checked = value === true;
    },
    normalize: options.normalize || normalizeBooleanValue,
    ...options,
  };
}

function createNumberBinding(key, selectors, options = {}) {
  const {
    fallback = 0,
    min = Number.NEGATIVE_INFINITY,
    max = Number.POSITIVE_INFINITY,
    integer = false,
    event = "input",
    blurEvent = false,
  } = options;

  return {
    key,
    selectors: toArray(selectors),
    event,
    blurEvent,
    read: (control) => control.value,
    write: (control, value) => {
      control.value = value;
    },
    normalize: options.normalize || ((value) => clampNumericValue(value, fallback, min, max, integer)),
    ...options,
  };
}

function createTextBinding(key, selectors, options = {}) {
  const event = options.event || "blur";
  return {
    key,
    selectors: toArray(selectors),
    event,
    read: (control) => control.value,
    write: (control, value) => {
      control.value = value ?? "";
    },
    normalize: options.normalize || ((value) => String(value ?? "")),
    ...options,
  };
}

function createSelectBinding(key, selectors, options = {}) {
  return {
    key,
    selectors: toArray(selectors),
    event: "change",
    read: (control) => control.value,
    write: (control, value) => {
      control.value = value ?? "";
    },
    normalize: options.normalize || ((value) => value),
    ...options,
  };
}

function createHotkeyBinding(key, selectors, options = {}) {
  return {
    key,
    selectors: toArray(selectors),
    kind: "hotkey",
    read: (control) => control.value,
    write: (control, value) => {
      control.value = value ?? "";
    },
    normalize: options.normalize || ((value) => normalizeTrimmedString(value)),
    equals:
      options.equals || ((left, right) => normalizeHotkeyForComparison(left) === normalizeHotkeyForComparison(right)),
    afterApply: composeAfterApply((value) => syncHotkeyWarningUi(key, value), options.afterApply),
    ...options,
  };
}

function createGamepadBindingSetting(inputId) {
  const config = GAMEPAD_BINDING_INPUT_CONFIG[inputId];
  return {
    key: config.settingKey,
    selectors: [`#${inputId}`],
    kind: "gamepad-binding",
    read: (control) => control.value,
    write: (control, value) => {
      setGamepadBindingInputValue(control.id, value);
    },
    equals: (left, right) =>
      formatGamepadBindingValue(left, config.fallbackValue) === formatGamepadBindingValue(right, config.fallbackValue),
  };
}

function createLiveStatsFieldsBinding() {
  return {
    key: "liveStatsFields",
    selectors: LIVE_STATS_FIELD_DEFINITIONS.map((field) => `#${field.controlId}`),
    event: "change",
    read: () => {
      const value = {};
      LIVE_STATS_FIELD_DEFINITIONS.forEach((field) => {
        value[field.key] = document.getElementById(field.controlId)?.checked !== false;
      });
      return value;
    },
    write: (_control, value) => {
      const normalizedValue = normalizeLiveStatsFieldsValue(value);
      LIVE_STATS_FIELD_DEFINITIONS.forEach((field) => {
        const checkbox = document.getElementById(field.controlId);
        if (checkbox) {
          checkbox.checked = normalizedValue[field.key] !== false;
        }
      });
    },
    normalize: normalizeLiveStatsFieldsValue,
    equals: areLiveStatsFieldsEqual,
  };
}

// Latest GSM-owned monitor index; used to restore selection once the dropdown is populated.
let desiredMonitorToCapture = 0;
const SETTING_BINDING_DEFINITIONS = [
  createCheckboxBinding("showReadyIndicator", "#showReadyIndicator"),
  createCheckboxBinding("showTextIndicators", "#showTextIndicators", {
    afterApply: () => updateFadeTextIndicatorsState(),
  }),
  createCheckboxBinding("fadeTextIndicators", "#fadeTextIndicators"),
  createCheckboxBinding("showRecycledIndicator", "#showRecycledIndicator"),
  // GSM-owned OCR/Capture settings (persisted by the backend per GSM profile).
  createSelectBinding("engine_v2", "#engine_v2"),
  {
    key: "monitor_to_capture",
    selectors: ["#monitor_to_capture"],
    event: "change",
    read: (control) => {
      const numeric = Number.parseInt(control.value, 10);
      return Number.isFinite(numeric) ? numeric : 0;
    },
    write: (control, value) => {
      const idx = Number.isFinite(Number(value)) ? Number(value) : 0;
      desiredMonitorToCapture = idx;
      if (control.querySelector(`option[value="${idx}"]`)) {
        control.value = String(idx);
      }
    },
    normalize: (value) => {
      const numeric = Number.parseInt(value, 10);
      return Number.isFinite(numeric) ? numeric : 0;
    },
  },
  createCheckboxBinding("use_overlay_area_config", "#use_overlay_area_config", {
    afterApply: () => syncOcrAreaSubsetUi(),
  }),
  createNumberBinding("minimum_character_size", "#minimum_character_size", {
    fallback: 0,
    min: 0,
    max: 500,
    integer: true,
  }),
  createCheckboxBinding("scan_on_overlay_activation", "#scan_on_overlay_activation"),
  createCheckboxBinding("text_appears_instantly", "#text_appears_instantly"),
  createCheckboxBinding("adaptive_ocr_retries", "#adaptive_ocr_retries"),
  createNumberBinding("base_scale", "#base_scale", {
    fallback: 0.75,
    min: 0.5,
    max: 1,
    afterApply: (value) => {
      const output = document.getElementById("base_scale_value");
      if (output) output.textContent = `${Math.round(value * 100)}%`;
    },
  }),
  createCheckboxBinding("periodic", "#periodic"),
  createNumberBinding("periodic_interval", "#periodic_interval", {
    fallback: 1,
    min: 0.1,
    max: 60,
  }),
  createCheckboxBinding("scan_on_mouse_move", "#scan_on_mouse_move"),
  createCheckboxBinding("inject_scanned_lines", "#inject_scanned_lines"),
  createCheckboxBinding("use_ocr_result_v2", "#use_ocr_result_v2", {
    afterApply: (value, options) => {
      if (value === true && options.source === "user") {
        void commitSettingValue("supplement_ocr_result_with_overlay", false, null);
      }
    },
  }),
  createCheckboxBinding("supplement_ocr_result_with_overlay", "#supplement_ocr_result_with_overlay", {
    afterApply: (value, options) => {
      if (value === true && options.source === "user") {
        void commitSettingValue("use_ocr_result_v2", false, null);
      }
    },
  }),
  createCheckboxBinding("use_text_filtering", "#use_text_filtering"),
  createCheckboxBinding("last_sent_ocr_presence_check", "#last_sent_ocr_presence_check", {
    afterApply: () => syncLastSentOcrPresenceUi(),
  }),
  createCheckboxBinding("last_sent_ocr_presence_remove_notation", "#last_sent_ocr_presence_remove_notation"),
  createCheckboxBinding("last_sent_ocr_presence_invalidate_lookups", "#last_sent_ocr_presence_invalidate_lookups"),
  // Legacy / advanced OCR-capture settings (collapsed in the Capture tab).
  createNumberBinding("periodic_ratio", "#periodic_ratio", {
    fallback: 0.9,
    min: 0,
    max: 1,
  }),
  createCheckboxBinding("ocr_area_config_include_primary_areas", "#ocr_area_config_include_primary_areas"),
  createCheckboxBinding("ocr_area_config_include_secondary_areas", "#ocr_area_config_include_secondary_areas"),
  createCheckboxBinding("ocr_area_config_use_exclusion_zones", "#ocr_area_config_use_exclusion_zones"),
  createCheckboxBinding("ocr_full_screen_instead_of_obs", "#ocr_full_screen_instead_of_obs"),
  {
    key: "manual_mode_desktop_background",
    selectors: ["#manual_mode_desktop_background"],
    event: "change",
    read: (control) => (control.checked === true ? "on_demand" : "off"),
    write: (control, value) => {
      control.checked =
        String(value || "off")
          .trim()
          .toLowerCase() === "on_demand";
    },
    normalize: (value) =>
      String(value || "off")
        .trim()
        .toLowerCase() === "on_demand"
        ? "on_demand"
        : "off",
  },
  createCheckboxBinding("showLiveStats", "#showLiveStats"),
  createCheckboxBinding("showLiveGoals", "#showLiveGoals"),
  createCheckboxBinding("hideCompletedGoals", "#hideCompletedGoals"),
  createCheckboxBinding("hideLiveStatsOnTextOverlap", "#hideLiveStatsOnTextOverlap"),
  createHotkeyBinding("liveStatsToggleHotkey", "#liveStatsToggleHotkey"),
  createSelectBinding("liveStatsScope", "#liveStatsScope", {
    normalize: normalizeLiveStatsScopeValue,
  }),
  createSelectBinding("liveStatsDisplayModeV2", "#liveStatsDisplayModeV2", {
    normalize: normalizeLiveStatsDisplayModeValue,
  }),
  createSelectBinding("liveStatsLayoutV2", "#liveStatsLayoutV2", {
    normalize: normalizeLiveStatsLayoutValue,
  }),
  createNumberBinding("liveStatsAutoHideSeconds", "#liveStatsAutoHideSeconds", {
    fallback: 5,
    min: 0,
    max: 60,
    integer: true,
  }),
  createSelectBinding("liveStatsPositionMode", "#liveStatsPositionMode", {
    normalize: normalizeLiveStatsPositionModeValue,
  }),
  createLiveStatsFieldsBinding(),
  createCheckboxBinding("pomodoroEnabled", "#pomodoroEnabled"),
  createNumberBinding("pomodoroWorkMinutes", "#pomodoroWorkMinutes", {
    fallback: 25,
    min: 1,
    max: 180,
    integer: true,
  }),
  createNumberBinding("pomodoroBreakMinutes", "#pomodoroBreakMinutes", {
    fallback: 5,
    min: 1,
    max: 180,
    integer: true,
  }),
  createCheckboxBinding("pomodoroAutoStart", "#pomodoroAutoStart"),
  createCheckboxBinding("overlaySettingsProfilesEnabled", "#overlaySettingsProfilesEnabled", {
    afterApply: (value) => {
      overlayProfileState.enabled = value === true;
      renderOverlayProfileState();
    },
  }),
  createNumberBinding("offsetX", "#offsetX", {
    fallback: 0,
    normalize: (value) => {
      const numeric = Number.parseFloat(value);
      return Number.isFinite(numeric) ? numeric : 0;
    },
  }),
  createNumberBinding("offsetY", "#offsetY", {
    fallback: 0,
    normalize: (value) => {
      const numeric = Number.parseFloat(value);
      return Number.isFinite(numeric) ? numeric : 0;
    },
  }),
  createCheckboxBinding("hideOverlayOnStartup", "#hideOverlayOnStartup"),
  {
    key: "hideOnStartup",
    selectors: ["#showMainBoxOnStartup"],
    event: "change",
    read: (control) => !control.checked,
    write: (control, value) => {
      control.checked = value !== true;
    },
    normalize: (value) => value === true,
    afterApply: () => syncShowMainBoxStartupUi(),
  },
  createNumberBinding("fontSize", "#fontSize", {
    fallback: 42,
    min: 8,
    max: 200,
    integer: true,
    event: "change",
  }),
  createCheckboxBinding("openSettingsOnStartup", "#openSettingsOnStartup"),
  createSelectBinding("dictionaryReaderSelection", "#dictionaryReaderSelection", {
    normalize: (value) => (value === "hachidori" ? "hachidori" : "yomitan"),
    afterApply: () => syncDictionaryReaderUi(),
  }),
  createCheckboxBinding("focusOverlayOnYomitanLookup", "#focusOverlayOnYomitanLookup"),
  createCheckboxBinding("routeAllHotkeysThroughInputServer", "#routeAllHotkeysThroughInputServer"),
  createNumberBinding("afkTimer", "#afkTimer", {
    fallback: 5,
    min: 0,
    max: 60,
    integer: true,
    blurEvent: true,
  }),
  createSelectBinding("readingLanguage", "#readingLanguage", {
    normalize: (value) =>
      String(value || "japanese")
        .trim()
        .toLowerCase() === "chinese"
        ? "chinese"
        : "japanese",
    afterApply: () => syncReadingLanguageUi(),
  }),
  createCheckboxBinding("showFurigana", "#showFurigana"),
  createCheckboxBinding("hideFuriganaOnStartup", "#hideFuriganaOnStartup"),
  createNumberBinding("hideFuriganaAfterSeconds", "#hideFuriganaAfterSeconds", {
    fallback: 0,
    min: 0,
    max: 60,
    integer: true,
    getDefault: () => 0,
  }),
  createNumberBinding("furiganaScale", "#furiganaScale", {
    fallback: 0.55,
    min: 0.2,
    max: 2.5,
  }),
  createNumberBinding("furiganaYOffset", "#furiganaYOffset", {
    fallback: -2,
    min: -48,
    max: 48,
  }),
  createNumberBinding("jitenHighlightOffsetY", "#jitenHighlightOffsetY", {
    fallback: 3,
    min: -48,
    max: 48,
  }),
  createTextBinding("furiganaColor", "#furiganaColor", {
    event: "input",
    normalize: (value) => normalizeTrimmedString(value, "#ffffff").toLowerCase(),
  }),
  createCheckboxBinding("pinyinToneColors", "#pinyinToneColors"),
  createTextBinding("pinyinTone1Color", "#pinyinTone1Color", {
    event: "input",
    normalize: (value) => normalizeTrimmedString(value, "#ff5252").toLowerCase(),
  }),
  createTextBinding("pinyinTone2Color", "#pinyinTone2Color", {
    event: "input",
    normalize: (value) => normalizeTrimmedString(value, "#ffb300").toLowerCase(),
  }),
  createTextBinding("pinyinTone3Color", "#pinyinTone3Color", {
    event: "input",
    normalize: (value) => normalizeTrimmedString(value, "#4caf50").toLowerCase(),
  }),
  createTextBinding("pinyinTone4Color", "#pinyinTone4Color", {
    event: "input",
    normalize: (value) => normalizeTrimmedString(value, "#42a5f5").toLowerCase(),
  }),
  createTextBinding("pinyinTone5Color", "#pinyinTone5Color", {
    event: "input",
    normalize: (value) => normalizeTrimmedString(value, "#e0e0e0").toLowerCase(),
  }),
  createTextBinding("furiganaOutlineColor", "#furiganaOutlineColor", {
    event: "input",
    normalize: (value) => normalizeTrimmedString(value, "#222222").toLowerCase(),
  }),
  createNumberBinding("furiganaOutlineWidth", "#furiganaOutlineWidth", {
    fallback: 1.5,
    min: 0,
    max: 6,
  }),
  createTextBinding("furiganaFontFamily", "#furiganaFontFamily", {
    normalize: (value) => normalizeTrimmedString(value, '"Yu Gothic UI", "Hiragino Sans", sans-serif'),
  }),
  createSelectBinding("furiganaFontWeight", "#furiganaFontWeight", {
    normalize: (value) => normalizeTrimmedString(value, "600"),
  }),
  createCheckboxBinding("manualMode", "#manualMode"),
  createSelectBinding("manualModeType", "#manualModeType", {
    normalize: normalizeManualModeTypeValue,
    afterApply: () => syncManualHotkeyStatusUi(),
  }),
  createSelectBinding("manualModeInactiveBehavior", "#manualModeInactiveBehavior", {
    normalize: normalizeManualModeInactiveBehaviorValue,
    afterApply: () => syncDisableInteractionSubOptionsUi(),
  }),
  createCheckboxBinding("manualModeDisableInteractionFocusOverlay", "#manualModeDisableInteractionFocusOverlay"),
  createHotkeyBinding("showHotkey", "#showHotkey", {
    afterApply: () => syncManualHotkeyStatusUi(),
  }),
  createCheckboxBinding("autoRequestTranslation", "#autoRequestTranslation"),
  createHotkeyBinding("translateHotkey", "#translateHotkey"),
  createCheckboxBinding("enableJitenReader", "#enableJitenReader", {
    afterApply: () => syncJitenReaderUi(),
  }),
  createCheckboxBinding("jitenHighlightingEnabled", "#jitenHighlightingEnabled"),
  createCheckboxBinding("showJitenGradingButtons", "#showJitenGradingButtons"),
  createHotkeyBinding("toggleFuriganaHotkey", "#toggleFuriganaHotkey"),
  createHotkeyBinding("toggleWindowHotkey", "#toggleWindowHotkey"),
  createHotkeyBinding("minimizeHotkey", "#minimizeHotkey"),
  createHotkeyBinding("yomitanSettingsHotkey", "#yomitanSettingsHotkey"),
  createHotkeyBinding("overlaySettingsHotkey", "#overlaySettingsHotkey"),
  createHotkeyBinding("texthookerHotkey", "#texthookerHotkey"),
  createCheckboxBinding("customPageEnabled", "#customPageEnabled"),
  createCheckboxBinding("vnGuideEnabled", "#vnGuideEnabled"),
  createTextBinding("vnGuideUrl", "#vnGuideUrl", { normalize: (value) => String(value ?? "").trim() }),
  createSelectBinding("vnGuideRoute", "#vnGuideRoute", {
    write: (control, value) => {
      control.value = value || control.dataset.currentRoute || "";
    },
  }),
  createSelectBinding("vnGuideMode", "#vnGuideMode"),
  createCheckboxBinding("vnGuideAutoAdvance", "#vnGuideAutoAdvance"),
  createHotkeyBinding("vnGuideToggleHotkey", "#vnGuideToggleHotkey"),
  createHotkeyBinding("vnGuideNextHotkey", "#vnGuideNextHotkey"),
  createHotkeyBinding("vnGuideBackHotkey", "#vnGuideBackHotkey"),
  createTextBinding("customPageUrl", "#customPageUrl", {
    normalize: (value) => String(value ?? "").trim(),
    afterApply: (value) => {
      let valid = !value;
      try {
        valid = ["http:", "https:"].includes(new URL(value).protocol);
      } catch {}
      const control = document.getElementById("customPageUrl");
      control.setCustomValidity(valid ? "" : "Enter a full http:// or https:// URL.");
      document.getElementById("custom-page-url-error").hidden = valid;
    },
  }),
  createHotkeyBinding("customPageHotkey", "#customPageHotkey"),
  createCheckboxBinding("gamepadEnabled", "#gamepadEnabled", {
    afterApply: () => syncGamepadSettingsEnabledUi(),
  }),
  createSelectBinding("gamepadActivationMode", "#gamepadActivationMode", {
    normalize: normalizeGamepadActivationModeValue,
    afterApply: () => updateControllerActivationFieldState(),
  }),
  createGamepadBindingSetting("gamepadModifierButton"),
  createGamepadBindingSetting("gamepadToggleButton"),
  createGamepadBindingSetting("gamepadConfirmButton"),
  createGamepadBindingSetting("gamepadCancelButton"),
  createGamepadBindingSetting("gamepadForwardEnterButton"),
  createGamepadBindingSetting("gamepadForwardSpaceButton"),
  createGamepadBindingSetting("gamepadForwardCtrlButton"),
  createGamepadBindingSetting("gamepadForwardEscapeButton"),
  createGamepadBindingSetting("gamepadForwardClickButton"),
  createGamepadBindingSetting("gamepadManualOverlayScanButton"),
  createGamepadBindingSetting("gamepadTranslateButton"),
  createGamepadBindingSetting("gamepadPauseToggleButton"),
  createGamepadBindingSetting("gamepadTokenModeToggleButton"),
  createGamepadBindingSetting("gamepadMineButton"),
  createGamepadBindingSetting("gamepadNextEntryButton"),
  createGamepadBindingSetting("gamepadPrevEntryButton"),
  createGamepadBindingSetting("gamepadPrevJitenWordButton"),
  createGamepadBindingSetting("gamepadNextJitenWordButton"),
  createGamepadBindingSetting("gamepadNavigateUp"),
  createGamepadBindingSetting("gamepadNavigateDown"),
  createGamepadBindingSetting("gamepadNavigateLeft"),
  createGamepadBindingSetting("gamepadNavigateRight"),
  createKeyboardBindingSetting("keyboardModifierKey"),
  createKeyboardBindingSetting("keyboardToggleKey"),
  createKeyboardBindingSetting("keyboardConfirmKey"),
  createKeyboardBindingSetting("keyboardCancelKey"),
  createKeyboardBindingSetting("keyboardForwardEnterKey"),
  createKeyboardBindingSetting("keyboardForwardSpaceKey"),
  createKeyboardBindingSetting("keyboardForwardCtrlKey"),
  createKeyboardBindingSetting("keyboardForwardEscapeKey"),
  createKeyboardBindingSetting("keyboardForwardClickKey"),
  createKeyboardBindingSetting("keyboardManualOverlayScanKey"),
  createKeyboardBindingSetting("keyboardPauseToggleKey"),
  createKeyboardBindingSetting("keyboardTokenModeToggleKey"),
  createKeyboardBindingSetting("keyboardNextEntryKey"),
  createKeyboardBindingSetting("keyboardPrevEntryKey"),
  createKeyboardBindingSetting("keyboardPrevJitenWordKey"),
  createKeyboardBindingSetting("keyboardNextJitenWordKey"),
  createKeyboardBindingSetting("keyboardNavigateUp"),
  createKeyboardBindingSetting("keyboardNavigateDown"),
  createKeyboardBindingSetting("keyboardNavigateLeft"),
  createKeyboardBindingSetting("keyboardNavigateRight"),
  createKeyboardBindingSetting("keyboardMineButton"),
  createCheckboxBinding("gamepadTokenMode", "#gamepadTokenMode"),
  createCheckboxBinding("gamepadFocusOverlayOnEntry", "#gamepadFocusOverlayOnEntry"),
  createCheckboxBinding("gamepadShowModeIndicator", "#gamepadShowModeIndicator"),
  createCheckboxBinding("gamepadShowNavigationStatus", "#gamepadShowNavigationStatus"),
  createSelectBinding("gamepadTokenizerBackend", ["#gamepadTokenizerBackend", "#furiganaTokenizerBackend"], {
    normalize: normalizeTokenizerBackendValue,
    afterApply: () => updateTokenizerBackendFieldState(),
  }),
  createSelectBinding("gamepadLocalTokenizerFallbackBackend", "#furiganaLocalTokenizerFallbackBackend", {
    normalize: normalizeLocalTokenizerFallbackBackendValue,
    getDefault: () => "sudachi",
  }),
  createSelectBinding("gamepadSudachiDictionary", ["#gamepadSudachiDictionary", "#furiganaSudachiDictionary"], {
    normalize: normalizeSudachiDictionaryValue,
    afterApply: () => updateTokenizerBackendFieldState(),
  }),
  createTextBinding("gamepadYomitanApiUrl", ["#gamepadYomitanApiUrl", "#furiganaYomitanApiUrl"], {
    event: "change",
    normalize: normalizeYomitanApiUrlValue,
  }),
  createNumberBinding("gamepadYomitanScanLength", ["#gamepadYomitanScanLength", "#furiganaYomitanScanLength"], {
    fallback: 10,
    min: 1,
    max: 100,
    integer: true,
    blurEvent: true,
  }),
  createTextBinding("gamepadJitenApiKey", ["#gamepadJitenApiKey", "#furiganaJitenApiKey", "#jitenReaderApiKey"], {
    normalize: (value) => normalizeTrimmedString(value),
  }),
  createTextBinding("gamepadJpdbApiKey", ["#gamepadJpdbApiKey", "#furiganaJpdbApiKey"], {
    normalize: (value) => normalizeTrimmedString(value),
  }),
  createCheckboxBinding("gamepadAutoConfirmSelection", "#gamepadAutoConfirmSelection"),
  createNumberBinding("gamepadRepeatDelay", "#gamepadRepeatDelay", {
    fallback: 400,
    min: 100,
    max: 1000,
    integer: true,
  }),
  createNumberBinding("gamepadRepeatRate", "#gamepadRepeatRate", {
    fallback: 150,
    min: 50,
    max: 500,
    integer: true,
  }),
  createSelectBinding("gamepadHoldNavigation", "#gamepadHoldNavigation", { getDefault: () => "repeat" }),
  createSelectBinding("gamepadHorizontalWrap", "#gamepadHorizontalWrap", { getDefault: () => "adjacent" }),
  createSelectBinding("gamepadVerticalNavigation", "#gamepadVerticalNavigation", { getDefault: () => "lines" }),
  createSelectBinding("gamepadInitialPosition", "#gamepadInitialPosition", { getDefault: () => "remember" }),
  createCheckboxBinding("gamepadBlockJumpAnimation", "#gamepadBlockJumpAnimation"),
  createCheckboxBinding("gamepadAnalogAcceleration", "#gamepadAnalogAcceleration"),
  createCheckboxBinding("gamepadControllerEnabled", "#gamepadControllerEnabled", {
    afterApply: () => updateControllerActivationFieldState(),
  }),
  createCheckboxBinding("gamepadKeyboardEnabled", "#gamepadKeyboardEnabled"),
  createCheckboxBinding("gamepadXinputEnabled", "#gamepadXinputEnabled"),
  createCheckboxBinding("gamepadDinputEnabled", "#gamepadDinputEnabled"),
  createHotkeyBinding("gamepadKeyboardHotkey", "#gamepadKeyboardHotkey"),
  createNumberBinding("gamepadServerPort", "#gamepadServerPort", {
    fallback: 7276,
    min: 1024,
    max: 65535,
    integer: true,
    afterApply: (value) => connectGamepadStatusSocket(value),
  }),
  createSelectBinding("platformOverride", "#platform-override", {
    normalize: normalizePlatformOverrideValue,
    getDefault: () => null,
    read: (control) => normalizePlatformOverrideValue(control.value),
    write: (control, value) => {
      control.value = value || "null";
    },
    equals: (left, right) => normalizePlatformOverrideValue(left) === normalizePlatformOverrideValue(right),
    persist: (value) => {
      ipcRenderer.send("set-platform-override", value);
    },
  }),
];

function registerBindingListener(binding, control) {
  if (!control) return;

  addResetButtonToBindingControl(binding, control);

  if (binding.kind === "hotkey") {
    const hotkeyOptions = HOTKEY_BINDING_OPTIONS[binding.key] || {};
    initializeHotkeyInput(control.id, {
      ...hotkeyOptions,
      settingKey: binding.key,
      onValidate: (value) => {
        void commitSettingValue(binding.key, value, control);
      },
    });
    return;
  }

  if (binding.kind === "gamepad-binding") {
    initializeGamepadBindingInput(control.id);
    return;
  }

  if (binding.kind === "keyboard-binding") {
    initializeKeyboardBindingInput(control.id);
    return;
  }

  const eventName = binding.event || (control.type === "checkbox" || control.tagName === "SELECT" ? "change" : "input");
  control.addEventListener(eventName, () => {
    const nextValue = typeof binding.read === "function" ? binding.read(control) : defaultReadBindingValue(control);
    void commitSettingValue(binding.key, nextValue, control);
  });

  if (binding.blurEvent) {
    control.addEventListener("blur", () => {
      const nextValue = typeof binding.read === "function" ? binding.read(control) : defaultReadBindingValue(control);
      void commitSettingValue(binding.key, nextValue, control);
    });
  }
}

function initializeSettingBindings() {
  SETTING_BINDING_DEFINITIONS.forEach((definition) => {
    const controls = definition.selectors
      .map((selector) => document.querySelector(selector))
      .filter((control) => control !== null)
      .concat(Array.from(document.querySelectorAll(`[data-setting-alias="${definition.key}"]`)));

    if (controls.length === 0) {
      return;
    }

    const binding = {
      ...definition,
      controls,
      resetButtons: [],
    };

    settingBindingMap.set(binding.key, binding);
    controls.forEach((control) => {
      registerBindingListener(binding, control);
    });

    const initialValue =
      typeof binding.read === "function" ? binding.read(controls[0]) : defaultReadBindingValue(controls[0]);
    applyBindingValue(binding, initialValue, { source: "initial" });
  });
}
