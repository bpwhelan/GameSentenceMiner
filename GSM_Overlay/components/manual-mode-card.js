/*
 * Shared "Manual Mode" settings card component.
 *
 * Single source of truth for the Manual Mode card markup + hotkey-capture
 * behaviour, used by BOTH the full settings window (settings.html) and the
 * lightweight manual-mode recommendation window (manual-mode-recommendation.html).
 *
 * Loaded as a plain script (not a CommonJS module) so it works whether the host
 * page is served from file:// (production) or the dev server (http://). It
 * exposes a single global: window.GSMManualModeCard.
 *
 * Two integration styles:
 *   - settings.html calls renderInto() to inject the markup (same element IDs),
 *     then its own binding system wires the controls. It also delegates its
 *     generic hotkey helpers to the ones exported here so the capture logic is
 *     genuinely shared.
 *   - The recommendation window calls mount(), which both renders AND wires the
 *     controls, reporting changes through an onChange callback.
 */
(function (global) {
  "use strict";

  // --- Pure hotkey helpers (extracted verbatim from settings.html) ---

  function splitHotkeyParts(hotkey) {
    return String(hotkey || "")
      .split("+")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  function isModifierOnlyHotkey(hotkey) {
    const modifierTokens = new Set(["ctrl", "cmd", "alt", "shift"]);
    const parts = splitHotkeyParts(hotkey).map((part) => part.toLowerCase());
    return parts.length > 0 && parts.every((part) => modifierTokens.has(part));
  }

  function predictManualHotkeyBackend(hotkey) {
    return isModifierOnlyHotkey(hotkey) ? "input_server" : "electron";
  }

  function captureKeyboardEvent(event) {
    const modifiers = [];

    // Capture modifiers in the correct order for Electron
    if (event.ctrlKey || event.metaKey) modifiers.push(event.metaKey ? "Cmd" : "Ctrl");
    if (event.altKey) modifiers.push("Alt");
    if (event.shiftKey) modifiers.push("Shift");

    // Map special keys to Electron accelerator format
    const keyMap = {
      " ": "Space",
      Enter: "Return",
      Escape: "Escape",
      Backspace: "Backspace",
      Delete: "Delete",
      Tab: "Tab",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
      Insert: "Insert",
      F1: "F1", F2: "F2", F3: "F3", F4: "F4",
      F5: "F5", F6: "F6", F7: "F7", F8: "F8",
      F9: "F9", F10: "F10", F11: "F11", F12: "F12",
      F13: "F13", F14: "F14", F15: "F15", F16: "F16",
      F17: "F17", F18: "F18", F19: "F19", F20: "F20",
      F21: "F21", F22: "F22", F23: "F23", F24: "F24",
    };

    // Get the main key
    let mainKey = "";
    if (keyMap[event.key]) {
      mainKey = keyMap[event.key];
    } else if (event.key.length === 1) {
      mainKey = event.key.toUpperCase();
    } else if (event.key.startsWith("Digit")) {
      mainKey = event.key.replace("Digit", "");
    } else if (event.key.startsWith("Key")) {
      mainKey = event.key.replace("Key", "");
    } else {
      mainKey = event.key;
    }

    if (!mainKey) {
      return null;
    }

    const modifierOnlyTokens = [];
    if (modifiers.includes("Ctrl")) modifierOnlyTokens.push("Ctrl");
    if (modifiers.includes("Cmd")) modifierOnlyTokens.push("Cmd");
    if (modifiers.includes("Alt")) modifierOnlyTokens.push("Alt");
    if (modifiers.includes("Shift")) modifierOnlyTokens.push("Shift");

    if (["Control", "Alt", "Shift", "Meta", "Cmd"].includes(mainKey)) {
      return modifierOnlyTokens.length > 0 ? modifierOnlyTokens.join("+") : null;
    }

    // Build the accelerator string
    let accelerator;
    if (modifiers.length > 0) {
      accelerator = [...modifiers, mainKey].join("+");
    } else {
      accelerator = mainKey;
    }

    return accelerator;
  }

  function validateHotkey(hotkey) {
    if (
      !hotkey ||
      hotkey.trim() === "" ||
      hotkey === "Press keys..." ||
      hotkey === "Add a modifier key (Ctrl, Alt, Shift)"
    ) {
      return false;
    }

    const validModifiers = ["Ctrl", "Cmd", "Alt", "Shift"];
    const validKeys = [
      "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
      "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
      "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
      "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
      "F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
      "Space", "Return", "Escape", "Backspace", "Delete", "Tab",
      "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown", "Insert",
      "+", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`",
      "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_",
    ];

    const parts = hotkey.split("+").map((part) => part.trim());

    if (parts.every((part) => validModifiers.includes(part))) {
      return true;
    }

    if (parts.length === 1) {
      return validKeys.includes(parts[0]);
    }

    const mainKey = parts[parts.length - 1];
    const modifiers = parts.slice(0, -1);

    for (const modifier of modifiers) {
      if (!validModifiers.includes(modifier)) {
        return false;
      }
    }

    return validKeys.includes(mainKey);
  }

  function resolveElement(elementOrId) {
    if (!elementOrId) return null;
    return typeof elementOrId === "string" ? document.getElementById(elementOrId) : elementOrId;
  }

  function updateCtrlWarning(hotkey, warningElementOrId) {
    const warningElement = resolveElement(warningElementOrId);
    if (!warningElement) return;
    warningElement.style.display = hotkey && hotkey.includes("Ctrl") ? "block" : "none";
  }

  // --- Value normalizers ---

  function normalizeManualModeType(value) {
    return value === "toggle" ? "toggle" : "hold";
  }

  function normalizeManualModeInactiveBehavior(value) {
    return value === "disable-interaction" ? "disable-interaction" : "hide-overlay";
  }

  // --- Backend status (pure logic extracted from settings' syncManualHotkeyStatusUi) ---

  function computeManualHotkeyStatus({ hotkey, manualModeType, runtimeState = {}, platform } = {}) {
    const predictedBackend = predictManualHotkeyBackend(hotkey || "");
    const backend = runtimeState.backend || predictedBackend;
    const backendLabel = backend === "input_server" ? "Input Server" : "Electron";
    const type = normalizeManualModeType(manualModeType);

    let statusText = `Backend: ${backendLabel}`;
    if (backend === "electron" && predictedBackend !== "electron") {
      statusText = "Backend: Electron (pending reconfiguration)";
    } else if (backend === "input_server" && runtimeState.backendReason === "electron-registration-failed") {
      statusText = "Backend: Input Server (Electron registration fallback)";
    }
    if (backend === "electron" && type === "hold") {
      statusText += " | Hold detection is best-effort";
    }

    let platformWarning = "";
    let runtimeWarning = "";

    if (backend === "input_server") {
      if (platform === "darwin") {
        platformWarning = "Input-server manual hotkeys on macOS require Accessibility permission.";
      } else if (platform === "linux") {
        platformWarning = "Linux manual hotkeys are best-effort. Wayland may block global keyboard hooks.";
      }
    } else if (backend === "electron" && type === "hold") {
      platformWarning =
        "Electron hold mode uses repeat/watchdog release detection because global shortcuts do not expose key-up.";
    }

    if (backend === "input_server" && (runtimeState.keyboardAvailable === false || runtimeState.keyboardError)) {
      runtimeWarning = runtimeState.keyboardError || "Input-server keyboard listener unavailable.";
    }

    return { statusText, platformWarning, runtimeWarning };
  }

  // --- Host-agnostic hotkey capture (the shared "hotkey handler") ---

  function attachHotkeyCapture(input, options = {}) {
    const {
      placeholder = "Press keys...",
      showCtrlWarning = false,
      warningElement = null,
      onValidate = null,
      onCapture = null,
      onStatus = null,
    } = options;

    if (!input) return;

    let isCapturing = false;
    let previousValue = input.value;

    input.addEventListener("focus", (event) => {
      isCapturing = true;
      previousValue = event.target.value;
      event.target.value = placeholder;
      event.target.classList.add("capturing-hotkey");
    });

    input.addEventListener("blur", (event) => {
      isCapturing = false;
      event.target.classList.remove("capturing-hotkey");

      if (event.target.value === placeholder || event.target.value.trim() === "") {
        event.target.value = previousValue;
        if (onStatus) onStatus();
        return;
      }

      if (showCtrlWarning && warningElement) {
        updateCtrlWarning(event.target.value, warningElement);
      }

      if (validateHotkey(event.target.value)) {
        previousValue = event.target.value;
        if (onValidate) onValidate(event.target.value);
      } else {
        alert("Invalid hotkey format. Use a key like Shift+Space or a modifier-only hotkey like Shift.");
        event.target.value = previousValue;
      }
      if (onStatus) onStatus();
    });

    input.addEventListener("keydown", (event) => {
      if (!isCapturing) return;
      event.preventDefault();
      event.stopPropagation();

      const accelerator = captureKeyboardEvent(event);
      if (accelerator) {
        event.target.value = accelerator;
        if (onCapture) onCapture(accelerator);
        if (onStatus) onStatus();
      }
    });

    input.addEventListener("keyup", (event) => {
      if (isCapturing && event.target.value !== placeholder) {
        if (showCtrlWarning && warningElement) {
          updateCtrlWarning(event.target.value, warningElement);
        }
        setTimeout(() => {
          if (validateHotkey(event.target.value)) {
            if (onValidate) onValidate(event.target.value);
            event.target.blur();
          }
        }, 500);
      }
    });
  }

  // --- Card markup ---
  // Inner markup only (no outer .setting-group); the host supplies the container.
  // Element IDs match settings.html so its binding system keeps working unchanged.
  const HOTKEY_INPUT_TITLE =
    "Enter a valid hotkey (e.g., Shift + Space)\n\n" +
    "⚠️ WARNING: Avoid Ctrl key in games/visual novels\n" +
    "(Ctrl is commonly used for text skipping)\n\n" +
    "Note: Some keys may not work (e.g., numpad +, certain special keys)\n" +
    "Use regular keyboard keys for best compatibility";

  const CARD_HTML = `
    <h4>Manual Mode</h4>
    <label>
      <span class="label-text">Only Show Overlay on Hotkey (Enabled)</span>
      <input type="checkbox" id="manualMode" />
    </label>
    <label>
      <span class="label-text">Manual Mode Type</span>
      <select id="manualModeType">
        <option value="hold">Hold (press and hold to show)</option>
        <option value="toggle">Toggle (press once to show, press again to hide)</option>
      </select>
    </label>
    <label>
      <span class="label-text">
        Inactive Behavior
        <div class="hotkey-info">Choose what happens before the manual hotkey activates text interaction</div>
      </span>
      <select id="manualModeInactiveBehavior">
        <option value="hide-overlay">Hide overlay until hotkey</option>
        <option value="disable-interaction">Keep overlay visible, disable interaction</option>
      </select>
    </label>
    <div class="hotkey-info">Standard hotkeys use Electron when possible. Modifier-only hotkeys like Shift use the input server.</div>
    <div id="manualHotkeyBackendStatus" class="hotkey-info">Backend: Electron</div>
    <div id="manual-hotkey-platform-warning" class="hotkey-info" style="color: #ff6b6b; font-size: 10px; display: none;"></div>
    <div id="manual-hotkey-runtime-warning" class="hotkey-info" style="color: #ff6b6b; font-size: 10px; display: none;"></div>
    <label>
      <span class="label-text">
        Re-Scan When Entering Manual Mode
        <div class="hotkey-info">Trigger the same backend scan used by GSM's manual overlay scan actions</div>
      </span>
      <input type="checkbox" id="manualModeRescanOnShow" />
    </label>
    <label>
      <span class="label-text">
        Hotkey
        <div class="hotkey-info">Used for the selected manual mode type above</div>
        <div class="hotkey-info" style="color: #4CAF50; font-size: 10px;">Click input and press your desired key (modifiers optional)</div>
        <div id="ctrl-warning" class="hotkey-info" style="color: #ff6b6b; font-size: 10px; display: none;">⚠️ Warning: Ctrl key may interfere with game controls (text skipping)</div>
      </span>
      <div class="input-container">
        <input type="text" id="showHotkey" value="Shift + Space" title="${HOTKEY_INPUT_TITLE.replace(/"/g, "&quot;").replace(/\n/g, "&#10;")}" />
        <button type="button" class="guide-button" onclick="window.open('https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts', '_blank')">
          Guide
        </button>
      </div>
    </label>
  `;

  function renderInto(container, options = {}) {
    if (!container) return;
    const { intro = "" } = options;
    const introHtml = intro ? `<div class="shared-setting-note">${intro}</div>` : "";
    container.innerHTML = introHtml + CARD_HTML;
  }

  // --- High-level mount: render + wire controls (used by the recommendation window) ---

  function mount(container, options = {}) {
    const { initial = {}, runtimeState = {}, platform, onChange = () => {}, intro = "" } = options;
    renderInto(container, { intro });

    const get = (id) => container.querySelector(`#${id}`);
    const manualMode = get("manualMode");
    const manualModeType = get("manualModeType");
    const inactiveBehavior = get("manualModeInactiveBehavior");
    const rescanOnShow = get("manualModeRescanOnShow");
    const showHotkey = get("showHotkey");
    const statusEl = get("manualHotkeyBackendStatus");
    const platformWarn = get("manual-hotkey-platform-warning");
    const runtimeWarn = get("manual-hotkey-runtime-warning");
    const ctrlWarn = get("ctrl-warning");

    let runtime = { ...runtimeState };

    function applyStatus() {
      const { statusText, platformWarning, runtimeWarning } = computeManualHotkeyStatus({
        hotkey: showHotkey ? showHotkey.value : "",
        manualModeType: manualModeType ? manualModeType.value : "hold",
        runtimeState: runtime,
        platform,
      });
      if (statusEl) statusEl.textContent = statusText;
      if (platformWarn) {
        platformWarn.textContent = platformWarning;
        platformWarn.style.display = platformWarning ? "block" : "none";
      }
      if (runtimeWarn) {
        runtimeWarn.textContent = runtimeWarning;
        runtimeWarn.style.display = runtimeWarning ? "block" : "none";
      }
    }

    // Seed initial values.
    if (manualMode) manualMode.checked = !!initial.manualMode;
    if (manualModeType) manualModeType.value = normalizeManualModeType(initial.manualModeType);
    if (inactiveBehavior) inactiveBehavior.value = normalizeManualModeInactiveBehavior(initial.manualModeInactiveBehavior);
    if (rescanOnShow) rescanOnShow.checked = !!initial.manualModeRescanOnShow;
    if (showHotkey && typeof initial.showHotkey === "string" && initial.showHotkey) {
      showHotkey.value = initial.showHotkey;
    }
    updateCtrlWarning(showHotkey ? showHotkey.value : "", ctrlWarn);
    applyStatus();

    if (manualMode) {
      manualMode.addEventListener("change", () => onChange("manualMode", manualMode.checked));
    }
    if (manualModeType) {
      manualModeType.addEventListener("change", () => {
        const value = normalizeManualModeType(manualModeType.value);
        manualModeType.value = value;
        onChange("manualModeType", value);
        applyStatus();
      });
    }
    if (inactiveBehavior) {
      inactiveBehavior.addEventListener("change", () => {
        const value = normalizeManualModeInactiveBehavior(inactiveBehavior.value);
        inactiveBehavior.value = value;
        onChange("manualModeInactiveBehavior", value);
      });
    }
    if (rescanOnShow) {
      rescanOnShow.addEventListener("change", () => onChange("manualModeRescanOnShow", rescanOnShow.checked));
    }
    if (showHotkey) {
      attachHotkeyCapture(showHotkey, {
        showCtrlWarning: true,
        warningElement: ctrlWarn,
        onValidate: (value) => {
          onChange("showHotkey", value);
          applyStatus();
        },
        onStatus: applyStatus,
      });
    }

    return {
      applyValues(partial = {}) {
        if (!partial) return;
        if ("manualMode" in partial && manualMode) manualMode.checked = !!partial.manualMode;
        if ("manualModeType" in partial && manualModeType) {
          manualModeType.value = normalizeManualModeType(partial.manualModeType);
        }
        if ("manualModeInactiveBehavior" in partial && inactiveBehavior) {
          inactiveBehavior.value = normalizeManualModeInactiveBehavior(partial.manualModeInactiveBehavior);
        }
        if ("manualModeRescanOnShow" in partial && rescanOnShow) {
          rescanOnShow.checked = !!partial.manualModeRescanOnShow;
        }
        if ("showHotkey" in partial && showHotkey && typeof partial.showHotkey === "string" && partial.showHotkey) {
          showHotkey.value = partial.showHotkey;
          updateCtrlWarning(showHotkey.value, ctrlWarn);
        }
        applyStatus();
      },
      setRuntimeState(state = {}) {
        runtime = { ...runtime, ...state };
        applyStatus();
      },
    };
  }

  global.GSMManualModeCard = {
    splitHotkeyParts,
    isModifierOnlyHotkey,
    predictManualHotkeyBackend,
    captureKeyboardEvent,
    validateHotkey,
    updateCtrlWarning,
    normalizeManualModeType,
    normalizeManualModeInactiveBehavior,
    computeManualHotkeyStatus,
    attachHotkeyCapture,
    renderInto,
    mount,
    CARD_HTML,
  };
})(typeof window !== "undefined" ? window : globalThis);
