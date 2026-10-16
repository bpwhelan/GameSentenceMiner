// Small, explicit bundles: applying a setup uses the same bindings as editing
// its controls. A recipe never resets unrelated capture, dictionary, or API settings.
const OVERLAY_PRESETS = [
  {
    id: "automatic",
    family: "activation",
    name: "Always available",
    kicker: "Mouse & keyboard",
    blurb: "Show the overlay with your game. Best when your mouse cursor stays visible.",
    effect: "Turns Push to show off.",
    values: { manualMode: false },
  },
  {
    id: "manual-hold",
    family: "activation",
    name: "Hold to look up",
    kicker: "Recommended for most games",
    blurb: "Hold Shift to reveal the overlay. Release it to return to your game.",
    effect: "Push to show · Hold · Shift · Hide when released.",
    values: {
      manualMode: true,
      manualModeType: "hold",
      showHotkey: "Shift",
      manualModeInactiveBehavior: "hide-overlay",
    },
  },
  {
    id: "manual-toggle",
    family: "activation",
    name: "Toggle on demand",
    kicker: "A shortcut instead of a held key",
    blurb: "Press Shift+Space to show the overlay. Press again to hide it.",
    effect: "Push to show · Toggle · Shift+Space · Hide when inactive.",
    values: {
      manualMode: true,
      manualModeType: "toggle",
      showHotkey: "Shift+Space",
      manualModeInactiveBehavior: "hide-overlay",
    },
  },
  {
    id: "clean-screen",
    family: "recipe",
    name: "Clean screen",
    blurb: "Hide readings and capture indicators.",
    effect: "Turns off readings, red borders, ready and recycled-line indicators.",
    values: { showFurigana: false, showTextIndicators: false, showReadyIndicator: false, showRecycledIndicator: false },
  },
  {
    id: "japanese-readings",
    family: "recipe",
    name: "Japanese readings",
    blurb: "Keep furigana visible.",
    effect: "Japanese · Readings on · Visible on startup.",
    values: { readingLanguage: "japanese", showFurigana: true, hideFuriganaOnStartup: false },
  },
  {
    id: "chinese-readings",
    family: "recipe",
    name: "Chinese readings",
    blurb: "Keep pinyin visible.",
    effect: "Chinese · Readings on · Visible on startup.",
    values: { readingLanguage: "chinese", showFurigana: true, hideFuriganaOnStartup: false },
  },
  {
    id: "controller-ready",
    family: "recipe",
    name: "Controller navigation",
    blurb: "Hold your modifier button + D-pad to select text.",
    effect: "Enables controller navigation in hold mode and hides the overlay until you activate it. Hold your assigned modifier button and use the D-pad to select text. Existing button assignments are kept.",
    values: {
      manualMode: true,
      manualModeInactiveBehavior: "hide-overlay",
      gamepadEnabled: true,
      gamepadControllerEnabled: true,
      gamepadActivationMode: "modifier",
    },
  },
  {
    id: "reading-progress",
    family: "recipe",
    name: "Reading progress",
    blurb: "Show stats and unfinished goals.",
    effect: "Stats on · Goals on · Completed goals hidden. Your selected goals are kept.",
    values: { showLiveStats: true, showLiveGoals: true, hideCompletedGoals: true },
  },
];
let applyingOverlayPreset = false;

function getOverlayPresetCardsContainer() {
  return document.getElementById("overlayPresetCards");
}

function isManualModeLocked() {
  return Boolean(document.getElementById("manualMode")?.disabled);
}

function isOverlayPresetUnavailable(preset) {
  return preset.values.manualMode === false && isManualModeLocked();
}

function presetValueMatchesCurrent(key, value) {
  const current = settingBindingState.get(key);
  if (key === "showHotkey") return normalizeHotkeyForComparison(current) === normalizeHotkeyForComparison(value);
  const binding = settingBindingMap.get(key);
  return binding ? areBindingValuesEqual(binding, current, value) : current === value;
}

function isOverlayPresetActive(preset) {
  return Object.entries(preset.values).every(([key, value]) => presetValueMatchesCurrent(key, value));
}

async function applyOverlayPreset(presetId) {
  const preset = OVERLAY_PRESETS.find((entry) => entry.id === presetId);
  if (!preset || applyingOverlayPreset || isOverlayPresetUnavailable(preset)) return;
  applyingOverlayPreset = true;
  refreshActivePresetHighlight();
  try {
    for (const [key, value] of Object.entries(preset.values)) await commitSettingValue(key, value, null);
    const status = document.getElementById("homePresetStatus");
    if (status) status.textContent = `${preset.name} applied. You can fine-tune the settings below.`;
  } finally {
    applyingOverlayPreset = false;
    refreshActivePresetHighlight();
  }
}

function renderOverlayPresetCards() {
  for (const [id, family] of [
    ["overlayPresetCards", "activation"],
    ["overlayRecipeCards", "recipe"],
  ]) {
    const container = document.getElementById(id);
    if (!container) continue;
    container.replaceChildren(
      ...OVERLAY_PRESETS.filter((preset) => preset.family === family).map((preset) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = `preset-card ${family === "activation" ? "home-mode-card" : "home-recipe-card"}`;
        card.dataset.presetId = preset.id;
        card.title = preset.effect;
        card.setAttribute("aria-describedby", `preset-effect-${preset.id}`);
        const name = document.createElement("span");
        name.className = "preset-card-name";
        const title = document.createElement("span");
        title.textContent = preset.name;
        const badge = document.createElement("span");
        badge.className = "preset-card-badge";
        badge.textContent = "Active";
        name.append(title, badge);
        const blurb = document.createElement("span");
        blurb.className = "preset-card-blurb";
        blurb.textContent = preset.blurb;
        const effect = document.createElement("span");
        effect.className = family === "activation" ? "home-preset-effect" : "sr-only";
        effect.id = `preset-effect-${preset.id}`;
        effect.textContent = preset.effect;
        if (preset.kicker) {
          const kicker = document.createElement("span");
          kicker.className = "home-preset-kicker";
          kicker.textContent = preset.kicker;
          card.append(kicker);
        }
        card.append(name, blurb, effect);
        card.addEventListener("click", () => {
          void applyOverlayPreset(preset.id);
        });
        return card;
      }),
    );
  }
  refreshActivePresetHighlight();
}

function refreshActivePresetHighlight() {
  OVERLAY_PRESETS.forEach((preset) => {
    const card = document.querySelector(`[data-preset-id="${preset.id}"]`);
    if (!card) return;
    const unavailable = isOverlayPresetUnavailable(preset);
    const active = !unavailable && isOverlayPresetActive(preset);
    card.disabled = unavailable || applyingOverlayPreset;
    card.classList.toggle("active", active);
    card.setAttribute("aria-pressed", String(active));
    card.title = unavailable ? "Push to show is required on Linux and macOS." : preset.effect;
  });
}
