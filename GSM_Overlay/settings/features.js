// Settings IPC updates, goals, tokenizer state, and recommended setups.
document.getElementById("openOffsetHelper").addEventListener("click", () => {
  ipcRenderer.send("open-offset-helper");
});

const selectOcrAreaButton = document.getElementById("selectOcrAreaButton");
if (selectOcrAreaButton) {
  selectOcrAreaButton.addEventListener("click", () => {
    ipcRenderer.send("overlay-select-ocr-area");
  });
}

// Populate the monitor dropdown from the backend-provided monitor list, preserving selection.
function populateMonitorOptions(monitors) {
  const select = document.getElementById("monitor_to_capture");
  if (!select || !Array.isArray(monitors) || monitors.length === 0) {
    return;
  }
  select.innerHTML = "";
  monitors.forEach((label, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = typeof label === "string" && label.trim() ? label : `Monitor ${index + 1}`;
    select.appendChild(option);
  });
  // Restore the active monitor index (tracked even when options weren't populated yet).
  const current = String(desiredMonitorToCapture);
  if (select.querySelector(`option[value="${current}"]`)) {
    select.value = current;
  }
}

ipcRenderer.on("gsm-overlay-monitors", (event, monitors) => {
  populateMonitorOptions(monitors);
});

document.getElementById("resetOffset").addEventListener("click", () => {
  void commitSettingValue("offsetX", 0, document.getElementById("offsetX"));
  void commitSettingValue("offsetY", 0, document.getElementById("offsetY"));
});

document.getElementById("ack-main-box-warning").addEventListener("click", () => {
  acknowledgeMainBoxStartupWarning();
});

document.getElementById("openJitenReaderSettings").addEventListener("click", () => {
  ipcRenderer.send("open-jiten-reader-settings");
});

document.getElementById("openYomitanSettings").addEventListener("click", () => {
  ipcRenderer.send("open-yomitan-settings");
});

const openGSMProfileSettingsButton = document.getElementById("openGSMProfileSettings");
if (openGSMProfileSettingsButton) {
  openGSMProfileSettingsButton.addEventListener("click", () => {
    ipcRenderer.send("open-gsm-profile-settings");
  });
}

function buildResolvedUserSettings(userSettings = {}) {
  return {
    ...userSettings,
    showTextIndicators:
      userSettings.showTextIndicators !== undefined ? userSettings.showTextIndicators !== false : true,
    fadeTextIndicators:
      userSettings.fadeTextIndicators !== undefined
        ? userSettings.fadeTextIndicators === true
        : userSettings.showTextBackground === true,
    showRecycledIndicator: userSettings.showRecycledIndicator !== false,
    showLiveStats: userSettings.showLiveStats !== false,
    showLiveGoals: userSettings.showLiveGoals !== false,
    hideCompletedGoals: userSettings.hideCompletedGoals !== false,
    hideLiveStatsOnTextOverlap: userSettings.hideLiveStatsOnTextOverlap !== false,
    liveStatsScope: normalizeLiveStatsScopeValue(userSettings.liveStatsScope),
    liveStatsDisplayModeV2: normalizeLiveStatsDisplayModeValue(userSettings.liveStatsDisplayModeV2),
    liveStatsLayoutV2: normalizeLiveStatsLayoutValue(userSettings.liveStatsLayoutV2),
    liveStatsAutoHideSeconds: clampNumericValue(userSettings.liveStatsAutoHideSeconds, 5, 0, 60, true),
    liveStatsPositionMode: normalizeLiveStatsPositionModeValue(userSettings.liveStatsPositionMode),
    liveStatsFields: normalizeLiveStatsFieldsValue(userSettings.liveStatsFields),
    pomodoroEnabled: userSettings.pomodoroEnabled === true,
    pomodoroWorkMinutes: clampNumericValue(userSettings.pomodoroWorkMinutes, 25, 1, 180, true),
    pomodoroBreakMinutes: clampNumericValue(userSettings.pomodoroBreakMinutes, 5, 1, 180, true),
    pomodoroAutoStart: userSettings.pomodoroAutoStart === true,
    manualModeInactiveBehavior: normalizeManualModeInactiveBehaviorValue(userSettings.manualModeInactiveBehavior),
    enableJitenReader: userSettings.enableJitenReader !== false,
    jitenHighlightingEnabled: userSettings.jitenHighlightingEnabled === true,
    showJitenGradingButtons: userSettings.showJitenGradingButtons !== false,
    gamepadEnabled: userSettings.gamepadEnabled !== false,
    gamepadTokenMode: userSettings.gamepadTokenMode !== false,
    gamepadAutoConfirmSelection: userSettings.gamepadAutoConfirmSelection !== false,
    gamepadFocusOverlayOnEntry: userSettings.gamepadFocusOverlayOnEntry !== false,
    gamepadShowModeIndicator: userSettings.gamepadShowModeIndicator !== false,
    gamepadShowNavigationStatus: userSettings.gamepadShowNavigationStatus !== false,
    gamepadControllerEnabled: userSettings.gamepadControllerEnabled !== false,
    gamepadXinputEnabled: userSettings.gamepadXinputEnabled !== false,
    gamepadDinputEnabled: userSettings.gamepadDinputEnabled === true,
    gamepadKeyboardEnabled: userSettings.gamepadKeyboardEnabled !== false,
    gamepadDeviceBlacklist: normalizeGamepadDeviceBlacklistValue(userSettings.gamepadDeviceBlacklist),
  };
}

function applyPreloadedSettings(userSettings = {}, defaultSettings = {}, runtimeSettings = {}) {
  const resolvedSettings = buildResolvedUserSettings(userSettings);
  overlaySettingDefaults = {
    ...defaultSettings,
    platformOverride: null,
  };
  manualHotkeyRuntimeState = {
    ...manualHotkeyRuntimeState,
    backend: runtimeSettings.manualHotkeyBackend || manualHotkeyRuntimeState.backend,
    backendReason: runtimeSettings.manualHotkeyBackendReason || manualHotkeyRuntimeState.backendReason,
    keyboardAvailable: runtimeSettings.manualHotkeyKeyboardAvailable !== false,
    keyboardError: runtimeSettings.manualHotkeyKeyboardError || null,
  };
  mainBoxStartupWarningAcknowledged = resolvedSettings.mainBoxStartupWarningAcknowledged === true;

  settingBindingMap.forEach((binding) => {
    const defaultValue = getBindingDefaultValue(binding);
    if (defaultValue !== undefined) {
      setSettingValueWithoutPersist(binding.key, defaultValue);
    }
  });

  Object.entries(resolvedSettings).forEach(([key, value]) => {
    if (settingBindingMap.has(key)) {
      setSettingValueWithoutPersist(key, value);
    }
  });

  if (resolvedSettings.weburl1 !== undefined) {
    const wsUrl1 = document.getElementById("wsUrl1");
    if (wsUrl1) wsUrl1.value = resolvedSettings.weburl1;
  }
  if (resolvedSettings.weburl2 !== undefined) {
    const wsUrl2 = document.getElementById("wsUrl2");
    if (wsUrl2) wsUrl2.value = resolvedSettings.weburl2;
  }
  if (resolvedSettings.texthookerUrl !== undefined) {
    document.getElementById("texthookerUrl").value = resolvedSettings.texthookerUrl;
  }

  syncShowMainBoxStartupUi();
  syncJitenReaderUi(resolvedSettings.enableJitenReader !== false);
  syncDisableInteractionSubOptionsUi();
  syncReadingLanguageUi();
  setGamepadDeviceBlacklist(resolvedSettings.gamepadDeviceBlacklist, { persist: false, send: false });
  updateControllerActivationFieldState();
  updateTokenizerBackendFieldState();
  syncManualHotkeyStatusUi();
  refreshAllResetButtons();

  setOverlayGoalsSelection(resolvedSettings.overlayGoals);
  loadOverlayGoalsPicker();

  const configuredPort = Number.parseInt(resolvedSettings.gamepadServerPort, 10) || 7276;
  checkGamepadServerStatus(configuredPort);
  connectGamepadStatusSocket(configuredPort);
  void applyPlatformSpecifics();
}

ipcRenderer.on(
  "preload-settings",
  (event, { userSettings, websocketStates, defaultSettings, runtimeSettings, profileState }) => {
    applyPreloadedSettings(userSettings, defaultSettings, runtimeSettings);
    updateOverlayProfileState(profileState);
    updateWebSocketStatus("ws1", websocketStates.ws1);
    updateWebSocketStatus("ws2", websocketStates.ws2);
  },
);

ipcRenderer.on("overlay-profile-state-updated", (event, profileState = {}) => {
  updateOverlayProfileState(profileState);
});

ipcRenderer.on("settings-updated", (event, updatedSettings = {}) => {
  Object.entries(updatedSettings).forEach(([key, value]) => {
    if (key === "manualHotkeyBackend") {
      manualHotkeyRuntimeState.backend = value || manualHotkeyRuntimeState.backend;
      return;
    }
    if (key === "manualHotkeyBackendReason") {
      manualHotkeyRuntimeState.backendReason = value || manualHotkeyRuntimeState.backendReason;
      return;
    }
    if (key === "manualHotkeyKeyboardAvailable") {
      manualHotkeyRuntimeState.keyboardAvailable = value !== false;
      return;
    }
    if (key === "manualHotkeyKeyboardError") {
      manualHotkeyRuntimeState.keyboardError = value || null;
      return;
    }
    if (key === "gamepadDeviceBlacklist") {
      setGamepadDeviceBlacklist(value, { persist: false, send: true });
      return;
    }
    if (key === "overlayGoals") {
      setOverlayGoalsSelection(value);
      renderOverlayGoalsPicker();
      return;
    }

    if (settingBindingMap.has(key)) {
      setSettingValueWithoutPersist(key, value);
    }
  });

  syncManualHotkeyStatusUi();
  refreshAllResetButtons();
  refreshActivePresetHighlight();
});

// ---- Overlay goals picker (Stats tab) ----
// The goals page only defines goals; here the user picks which active goals the
// live-stats widget shows (and in which view). Selection persists as the
// overlayGoals overlay setting; the widget filters the server feed by it.
let overlayGoalsSelection = {};
let overlayGoalsActive = [];
let overlayGoalsRefreshBound = false;

function normalizeOverlayGoalsValue(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalized = {};
  Object.keys(source).forEach((goalId) => {
    const cfg = source[goalId];
    if (!cfg || typeof cfg !== "object") return;
    normalized[goalId] = {
      enabled: cfg.enabled === true,
      view: cfg.view === "overall" ? "overall" : "today",
    };
  });
  return normalized;
}

function setOverlayGoalsSelection(value) {
  overlayGoalsSelection = normalizeOverlayGoalsValue(value);
}

function persistOverlayGoalsSelection() {
  ipcRenderer.send("setting-changed", { key: "overlayGoals", value: overlayGoalsSelection });
}

function handleOverlayGoalToggle(goalId, enabled) {
  const existing = overlayGoalsSelection[goalId] || { enabled: false, view: "today" };
  overlayGoalsSelection[goalId] = { ...existing, enabled: enabled === true };
  persistOverlayGoalsSelection();
}

function handleOverlayGoalViewChange(goalId, view) {
  const existing = overlayGoalsSelection[goalId] || { enabled: false, view: "today" };
  overlayGoalsSelection[goalId] = { ...existing, view: view === "overall" ? "overall" : "today" };
  persistOverlayGoalsSelection();
}

function renderOverlayGoalsPicker() {
  const list = document.getElementById("overlayGoalsList");
  if (!list) return;
  list.replaceChildren();

  if (!Array.isArray(overlayGoalsActive) || overlayGoalsActive.length === 0) {
    const empty = document.createElement("div");
    empty.className = "overlay-goals-empty";
    empty.textContent = "No active goals. Create goals on the Goals page, then refresh.";
    list.appendChild(empty);
    return;
  }

  overlayGoalsActive.forEach((goal) => {
    const cfg = overlayGoalsSelection[goal.id] || { enabled: false, view: "today" };

    const row = document.createElement("div");
    row.className = "overlay-goal-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "overlay-goal-checkbox";
    checkbox.checked = cfg.enabled === true;
    checkbox.addEventListener("change", () => handleOverlayGoalToggle(goal.id, checkbox.checked));
    row.appendChild(checkbox);

    const name = document.createElement("span");
    name.className = "overlay-goal-name";
    name.textContent = `${goal.icon || "🎯"} ${goal.name || "Goal"}`;
    name.title = name.textContent;
    row.appendChild(name);

    const view = document.createElement("select");
    view.className = "overlay-goal-view";
    const todayOpt = document.createElement("option");
    todayOpt.value = "today";
    todayOpt.textContent = "Today";
    const overallOpt = document.createElement("option");
    overallOpt.value = "overall";
    overallOpt.textContent = "Overall";
    view.appendChild(todayOpt);
    view.appendChild(overallOpt);
    view.value = cfg.view === "overall" ? "overall" : "today";
    view.addEventListener("change", () => handleOverlayGoalViewChange(goal.id, view.value));
    row.appendChild(view);

    list.appendChild(row);
  });
}

async function loadOverlayGoalsPicker() {
  const list = document.getElementById("overlayGoalsList");
  if (!overlayGoalsRefreshBound) {
    const refreshBtn = document.getElementById("overlayGoalsRefresh");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => loadOverlayGoalsPicker());
      overlayGoalsRefreshBound = true;
    }
  }
  if (list) {
    list.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "overlay-goals-empty";
    loading.textContent = "Loading goals…";
    list.appendChild(loading);
  }
  try {
    const result = await ipcRenderer.invoke("overlay-get-active-goals");
    overlayGoalsActive = Array.isArray(result?.goals) ? result.goals : [];
    renderOverlayGoalsPicker();
  } catch (error) {
    console.error("Failed to load overlay goals:", error);
    if (list) {
      list.replaceChildren();
      const err = document.createElement("div");
      err.className = "overlay-goals-empty";
      err.textContent = "Could not load goals (is GSM running?).";
      list.appendChild(err);
    }
  }
}

// Handle websocket status updates
function updateWebSocketStatus(type, isConnected) {
  const statusElement = document.getElementById(type === "ws1" ? "wsstatus1" : "wsstatus2");
  if (!statusElement) return;
  statusElement.className = `status-indicator ${isConnected ? "connected" : "disconnected"}`;
}

ipcRenderer.on("websocket-closed", (event, type) => {
  updateWebSocketStatus(type, false);
});

ipcRenderer.on("websocket-opened", (event, type) => {
  updateWebSocketStatus(type, true);
});

// ==================== Sudachi Download Progress ====================

const SUDACHI_STAGE_LABELS = {
  ready: "Dictionary already downloaded ✓",
  downloading: "Downloading Sudachi dictionary...",
  verifying: "Verifying checksum...",
  extracting: "Extracting dictionary...",
  done: "Sudachi dictionary ready!",
  error: "Download failed",
};

function updateSudachiProgress(data) {
  const container = document.getElementById("sudachiProgressContainer");
  const label = document.getElementById("sudachiProgressLabel");
  const percent = document.getElementById("sudachiProgressPercent");
  const fill = document.getElementById("sudachiProgressFill");
  const errorEl = document.getElementById("sudachiProgressError");
  if (!container) return;

  const stage = data.stage || "downloading";
  const pct = Math.min(100, Math.max(0, data.percent || 0));

  // Remove all state classes
  container.classList.remove("error", "done", "extracting", "verifying", "ready");

  if (stage === "ready") {
    container.classList.add("visible", "done", "ready");
    label.textContent = SUDACHI_STAGE_LABELS.ready;
    percent.textContent = "";
    fill.style.width = "100%";
    errorEl.style.display = "none";
    // Auto-hide after 3 seconds
    setTimeout(() => {
      container.classList.remove("visible");
    }, 3000);
    return;
  }

  if (stage === "error") {
    container.classList.add("visible", "error");
    label.textContent = SUDACHI_STAGE_LABELS.error;
    percent.textContent = "";
    fill.style.width = "100%";
    errorEl.textContent = data.error || "Unknown error";
    errorEl.style.display = "block";
    return;
  }

  if (stage === "done") {
    container.classList.add("visible", "done");
    label.textContent = SUDACHI_STAGE_LABELS.done;
    percent.textContent = "";
    fill.style.width = "100%";
    errorEl.style.display = "none";
    // Auto-hide after 4 seconds
    setTimeout(() => {
      container.classList.remove("visible");
    }, 4000);
    return;
  }

  container.classList.add("visible");
  if (stage === "extracting" || stage === "verifying") {
    container.classList.add(stage);
  }
  label.textContent = SUDACHI_STAGE_LABELS[stage] || stage;
  errorEl.style.display = "none";

  if (stage === "downloading") {
    fill.style.width = pct + "%";
    if (data.totalBytes) {
      const downloadedMB = ((data.totalBytes * pct) / 100 / 1024 / 1024).toFixed(1);
      const totalMB = (data.totalBytes / 1024 / 1024).toFixed(1);
      percent.textContent = `${downloadedMB} / ${totalMB} MB (${pct}%)`;
    } else {
      percent.textContent = pct > 0 ? pct + "%" : "";
    }
  } else {
    fill.style.width = "100%";
    percent.textContent = "";
  }
}

ipcRenderer.on("sudachi-progress", (event, data) => {
  updateSudachiProgress(data);
});

ipcRenderer.on("update-offset-values", (event, { offsetX, offsetY }) => {
  setSettingValueWithoutPersist("offsetX", offsetX);
  setSettingValueWithoutPersist("offsetY", offsetY);
});

function updateTokenizerBackendFieldState() {
  const backend = normalizeTokenizerBackendValue(
    settingBindingState.get("gamepadTokenizerBackend") || document.getElementById("gamepadTokenizerBackend")?.value,
  );
  const usesSudachi = backend === "sudachi";
  const usesYomitanBridge = backend === "yomitan-bridge";
  const usesYomitanApi = backend === "yomitan-api";
  const usesYomitan = usesYomitanBridge || usesYomitanApi;
  const usesJiten = backend === "jiten-api";
  const usesJpdb = backend === "jpdb-api";

  document.querySelectorAll('[data-tokenizer-setting="sudachi"]').forEach((label) => {
    label.style.display = usesSudachi ? "" : "none";
  });
  document.querySelectorAll('[data-tokenizer-setting="yomitan-url"]').forEach((label) => {
    label.style.display = usesYomitanApi ? "" : "none";
  });
  document.querySelectorAll('[data-tokenizer-setting="yomitan-scan"]').forEach((label) => {
    label.style.display = usesYomitan ? "" : "none";
  });
  document.querySelectorAll('[data-tokenizer-setting="jiten-key"]').forEach((label) => {
    label.style.display = usesJiten ? "" : "none";
  });
  document.querySelectorAll('[data-tokenizer-setting="jpdb-key"]').forEach((label) => {
    label.style.display = usesJpdb ? "" : "none";
  });

  [
    { ids: ["gamepadSudachiDictionary", "furiganaSudachiDictionary"], disabled: !usesSudachi },
    { ids: ["gamepadYomitanApiUrl", "furiganaYomitanApiUrl"], disabled: !usesYomitanApi },
    { ids: ["gamepadYomitanScanLength", "furiganaYomitanScanLength"], disabled: !usesYomitan },
    { ids: ["gamepadJitenApiKey", "furiganaJitenApiKey"], disabled: !usesJiten },
    { ids: ["gamepadJpdbApiKey", "furiganaJpdbApiKey"], disabled: !usesJpdb },
  ].forEach(({ ids, disabled }) => {
    ids.forEach((id) => {
      const input = document.getElementById(id);
      if (input) {
        input.disabled = disabled;
      }
    });
  });

  refreshAllResetButtons();
}

function updateGamepadSettingsVisibility(enabled) {
  const details = document.getElementById("gamepadSettingsDetails");
  if (!details) return;
  details.style.display = "";
  document.getElementById("gamepadDisabledNotice").hidden = enabled;
}

function updateControllerActivationFieldState() {
  const gamepadEnabledInput = document.getElementById("gamepadEnabled");
  const activationModeInput = document.getElementById("gamepadActivationMode");
  const controllerEnabledInput = document.getElementById("gamepadControllerEnabled");
  const modifierButtonInput = document.getElementById("gamepadModifierButton");
  const toggleButtonInput = document.getElementById("gamepadToggleButton");

  if (
    !gamepadEnabledInput ||
    !activationModeInput ||
    !controllerEnabledInput ||
    !modifierButtonInput ||
    !toggleButtonInput
  ) {
    return;
  }

  const gamepadEnabled = gamepadEnabledInput.checked !== false;
  const controllerActivationEnabled = controllerEnabledInput.checked !== false;
  const disableActivationButtons = !gamepadEnabled || !controllerActivationEnabled;
  const isModifierMode = activationModeInput.value === "modifier";

  modifierButtonInput.disabled = disableActivationButtons;
  toggleButtonInput.disabled = disableActivationButtons;
  stopGamepadBindingCaptureIfDisabled();

  const modifierLabel = modifierButtonInput.closest("label");
  const toggleLabel = toggleButtonInput.closest("label");
  const activeOpacity = disableActivationButtons ? "0.5" : "1";
  const inactiveOpacity = "0.5";

  if (modifierLabel) {
    modifierLabel.style.opacity = isModifierMode ? activeOpacity : inactiveOpacity;
  }
  if (toggleLabel) {
    toggleLabel.style.opacity = isModifierMode ? inactiveOpacity : activeOpacity;
  }
  refreshAllResetButtons();
}
