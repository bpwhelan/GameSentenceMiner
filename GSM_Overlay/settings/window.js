// Window actions, profile status, and platform-specific presentation.
const { ipcRenderer } = require("electron");

// Inject the shared Manual Mode card markup before the binding system runs so
// its element IDs (manualMode, showHotkey, etc.) are present for the bindings.
GSMManualModeCard.renderInto(document.getElementById("manualModeCardMount"));
const ELECTRON_DOCS_QUERY = "?docusaurus-data-navbar=false&docusaurus-data-sidebar=false&docusaurus-data-footer=false";
const DOCS_URLS = Object.freeze({
  overlay: `https://docs.gamesentenceminer.com/docs/features/overlay${ELECTRON_DOCS_QUERY}`,
  overlayGamepad: `https://docs.gamesentenceminer.com/docs/features/overlay-gamepad${ELECTRON_DOCS_QUERY}`,
});

async function openDocumentationLink(url) {
  try {
    const result = await ipcRenderer.invoke("docs.openWindow", { url });
    if (result && result.success === false) {
      window.open(url, "_blank");
    }
  } catch (error) {
    console.error("Failed to open documentation:", error);
    window.open(url, "_blank");
  }
}

document.querySelectorAll("[data-doc-key]").forEach((button) => {
  button.addEventListener("click", () => {
    const docKey = button.getAttribute("data-doc-key");
    const url = docKey ? DOCS_URLS[docKey] : "";
    if (url) {
      openDocumentationLink(url);
    }
  });
});

let mainBoxStartupWarningAcknowledged = false;
function syncDictionaryReaderUi() {
  const reader = document.getElementById("dictionaryReaderSelection").value === "hachidori" ? "Hachidori" : "Yomitan";
  document.querySelectorAll("[data-dictionary-settings-label]").forEach((label) => {
    label.textContent = `${reader} Settings${label.dataset.dictionarySettingsLabel}`;
  });
}

ipcRenderer.on("select-settings-tab", (_event, tab) => {
  if (tab === "system") updateSettingsTabVisibility("system-dictionary");
});
ipcRenderer.on("dictionary-reader-switching", (_event, switching) => {
  document.getElementById("dictionaryReaderSelection").disabled = switching;
  document.getElementById("openDictionarySettings").disabled = switching;
  document.getElementById("openYomitanSettings").disabled = switching;
  document.getElementById("dictionaryReaderStatus").textContent = switching
    ? "Switching dictionary reader…"
    : "Manage dictionaries, appearance, and lookup behavior for the selected reader.";
});
document.getElementById("openDictionarySettings").addEventListener("click", () => {
  ipcRenderer.send("open-yomitan-settings");
});
let overlayProfileState = {
  enabled: false,
  activeProfileName: "Default",
  currentGSMProfileName: "Default",
  profiles: [],
};
function normalizeProfileState(profileState = {}) {
  const profiles = Array.isArray(profileState.profiles) ? profileState.profiles : [];
  return {
    enabled: profileState.enabled === true,
    activeProfileName: String(profileState.activeProfileName || "Default"),
    currentGSMProfileName: String(profileState.currentGSMProfileName || "Default"),
    profiles: profiles
      .filter((profile) => profile && typeof profile === "object" && typeof profile.name === "string")
      .map((profile) => ({
        name: profile.name,
        scenes: Array.isArray(profile.scenes)
          ? profile.scenes.filter((scene) => typeof scene === "string" && scene.trim())
          : [],
        active: profile.active === true,
        current: profile.current === true,
        hasOverlaySettings: profile.hasOverlaySettings === true,
      })),
  };
}

function renderOverlayProfileState() {
  window.GSMSettingsHome?.refresh();
  const activeName = document.getElementById("overlayActiveProfileName");
  const currentName = document.getElementById("overlayCurrentGsmProfileName");
  const list = document.getElementById("overlayProfilesList");

  if (activeName) {
    activeName.textContent = overlayProfileState.enabled ? overlayProfileState.activeProfileName : "Disabled";
  }
  if (currentName) {
    currentName.textContent = overlayProfileState.currentGSMProfileName;
  }
  if (!list) return;

  if (overlayProfileState.profiles.length === 0) {
    list.innerHTML = '<div class="profile-card"><div class="profile-card-scenes">No GSM profiles found.</div></div>';
    return;
  }

  list.replaceChildren(
    ...overlayProfileState.profiles.map((profile) => {
      const card = document.createElement("div");
      card.className = "profile-card";
      card.classList.toggle(
        "active",
        overlayProfileState.enabled && profile.name === overlayProfileState.activeProfileName,
      );
      card.classList.toggle("current", profile.current);

      const header = document.createElement("div");
      header.className = "profile-card-header";

      const name = document.createElement("div");
      name.className = "profile-card-name";
      name.textContent = profile.name;
      header.appendChild(name);

      if (overlayProfileState.enabled && profile.name === overlayProfileState.activeProfileName) {
        const badge = document.createElement("span");
        badge.className = "profile-card-badge";
        badge.textContent = "Active";
        header.appendChild(badge);
      } else if (profile.current) {
        const badge = document.createElement("span");
        badge.className = "profile-card-badge";
        badge.textContent = "GSM";
        header.appendChild(badge);
      }

      const scenes = document.createElement("div");
      scenes.className = "profile-card-scenes";
      scenes.textContent = profile.scenes.length > 0 ? `Scenes: ${profile.scenes.join(", ")}` : "No scenes assigned";

      card.appendChild(header);
      card.appendChild(scenes);
      return card;
    }),
  );
}

function updateOverlayProfileState(profileState = {}) {
  overlayProfileState = normalizeProfileState(profileState);
  if (settingBindingMap.has("overlaySettingsProfilesEnabled")) {
    setSettingValueWithoutPersist("overlaySettingsProfilesEnabled", overlayProfileState.enabled);
  }
  renderOverlayProfileState();
}

function updateFadeTextIndicatorsState() {
  const showIndicators = document.getElementById("showTextIndicators");
  const fadeIndicators = document.getElementById("fadeTextIndicators");
  if (!showIndicators || !fadeIndicators) return;
  const enabled = showIndicators.checked;
  fadeIndicators.disabled = !enabled;
  const fadeLabel = fadeIndicators.closest("label");
  if (fadeLabel) {
    fadeLabel.style.opacity = enabled ? "1" : "0.55";
  }
}

function showMainBoxStartupWarning() {
  const modal = document.getElementById("main-box-warning-modal");
  if (modal) modal.classList.add("visible");
}

function acknowledgeMainBoxStartupWarning() {
  const modal = document.getElementById("main-box-warning-modal");
  if (modal) modal.classList.remove("visible");
  if (!mainBoxStartupWarningAcknowledged) {
    mainBoxStartupWarningAcknowledged = true;
    handleSettingChange("mainBoxStartupWarningAcknowledged", true);
  }
}

async function applyPlatformSpecifics() {
  const platform = await ipcRenderer.invoke("get-effective-platform");
  document.getElementById("windows-gamepad-listeners").hidden = process.platform !== "win32";

  // Settings that are not supported on Linux
  const disabledOnLinuxSettings = [];

  // Immediately disable listed settings when running on Linux so UI is non-interactive
  if (platform === "linux") {
    disabledOnLinuxSettings.forEach((settingId) => {
      const el = document.getElementById(settingId);
      if (el) {
        el.disabled = true;
        el.title = "This setting is disabled on Linux.";
      }
    });
  }

  // Hide Text Offset group on Windows
  GSMSettingsNavigation.setPageAvailable("capture-alignment", platform !== "win32");
  if (platform === "win32") {
    const textOffsetGroup = document.getElementById("text-offset-group");
    if (textOffsetGroup) {
      textOffsetGroup.style.display = "none";
    }
  }

  // Hide Magpie compatibility settings on non-Windows
  if (platform !== "win32") {
    const magpieLabel = document.getElementById("magpie-compatibility-label");
    if (magpieLabel) {
      magpieLabel.style.display = "none";
    }

    // Enforce manual mode on non-windows
    const manualModeCheckbox = document.getElementById("manualMode");
    if (manualModeCheckbox) {
      if (settingBindingMap.has("manualMode")) {
        setSettingValueWithoutPersist("manualMode", true);
      } else {
        manualModeCheckbox.checked = true;
      }
      manualModeCheckbox.disabled = true;
      const manualModeLabel = manualModeCheckbox.closest("label");
      if (manualModeLabel) {
        manualModeLabel.title = "Push to Show is required on Linux and macOS.";
      }
    }
  } else {
    const manualModeCheckbox = document.getElementById("manualMode");
    if (manualModeCheckbox) {
      manualModeCheckbox.disabled = false;
      const manualModeLabel = manualModeCheckbox.closest("label");
      if (manualModeLabel) {
        manualModeLabel.title = "";
      }
    }
  }

  const platformOverrideInput = document.getElementById("platform-override");
  const derivedPlatformOverride = platform !== process.platform ? platform : null;
  if (platformOverrideInput) {
    platformOverrideInput.value = derivedPlatformOverride || "null";
  }
  if (settingBindingMap.has("platformOverride")) {
    setSettingValueWithoutPersist("platformOverride", derivedPlatformOverride);
  }
  syncManualHotkeyStatusUi();
  refreshAllResetButtons();
  refreshActivePresetHighlight();
}

// Unified settings change handler
// element is optional - if provided we'll check element.disabled there
async function handleSettingChange(settingKey, value, element) {
  // If the control element is disabled, ignore the change
  try {
    if (element && element.disabled) return;
  } catch (e) {
    // ignore
  }

  // Linux-specific setting restrictions can be added here if needed

  console.log(`Setting changed: ${settingKey} = ${value}`);
  ipcRenderer.send("setting-changed", { key: settingKey, value: value });
}
