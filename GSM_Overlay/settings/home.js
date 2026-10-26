// Home is another view of the existing bindings, not a second settings store.
// Clone only the input/select; the detailed control keeps its ID and behavior.
(function (global) {
  "use strict";

  const checked = (id) => document.getElementById(id)?.checked === true;
  const value = (id) => document.getElementById(id)?.value;
  const field = (id, label, help = "", options = {}) => ({ id, label, help, ...options });
  const sections = [
    {
      id: "activation",
      title: "Interaction",
      page: "interaction-mouse",
      fields: [
        field(
          "textHoverClickThrough",
          "Click through overlay text",
          "In automatic mode, clicks reach your game while hover lookups work. Turn off to select text or use click lookups.",
          { inlineHelp: true },
        ),
        field("manualMode", "Push to show", "Keep the overlay out of the way until you activate it."),
        field("manualModeType", "Activation", "", {
          when: () => checked("manualMode"),
          optionLabels: { hold: "Hold to show", toggle: "Toggle to show" },
        }),
        field(
          "showHotkey",
          "Show / hide shortcut",
          "Click the field, then press your keys. Avoid Ctrl if your game uses it to skip text.",
        ),
        field("manualModeInactiveBehavior", "When inactive", "", {
          when: () => checked("manualMode"),
          optionLabels: { "hide-overlay": "Hide overlay", "disable-interaction": "Keep text visible" },
        }),
      ],
      links: [
        ["interaction-mouse", "Mouse & text settings →"],
        ["interaction-reveal", "Push to show settings →"],
      ],
      warning: "manual",
    },
    {
      id: "capture",
      title: "Capture source",
      page: "capture-source",
      fields: [
        field("engine_v2", "OCR engine"),
        field("monitor_to_capture", "Capture monitor"),
        field("use_overlay_area_config", "Use my capture areas", "Limit capture to the areas you have selected."),
      ],
      actions: [["selectOcrAreaButton", "Choose capture areas"]],
    },
    {
      id: "readings",
      title: "Readings & display",
      page: "reading-readings",
      fields: [
        field("showFurigana", "Show furigana / pinyin"),
        field("readingLanguage", "Reading language"),
        field("showTextIndicators", "Red borders around captured text"),
      ],
      links: [
        ["reading-readings", "Reading settings →"],
        ["reading-indicators", "Display settings →"],
      ],
    },
    {
      id: "dictionary",
      title: "Dictionary",
      page: "system-dictionary",
      fields: [
        field("dictionaryReaderSelection", "Lookup dictionary", "Changing readers restarts the overlay.", {
          inlineHelp: true,
        }),
      ],
      actions: [["openDictionarySettings", "Yomitan Settings"]],
      links: [["reading-jiten", "Jiten settings →"]],
    },
  ];
  const shortcuts = [];
  const searchTerms = new Map(
    sections.flatMap((section) => section.fields.map((config) => [config.id, `${config.label} ${config.help}`])),
  );
  let rendered = false;
  let refreshPending = false;

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function labelOptions(control, config) {
    if (!config.optionLabels) return;
    for (const option of control.options) option.textContent = config.optionLabels[option.value] || option.textContent;
  }

  function makeField(config) {
    const source = document.getElementById(config.id);
    const definition = SETTING_BINDING_DEFINITIONS.find((binding) => binding.selectors.includes(`#${config.id}`));
    if (!source || !definition || ["gamepad-binding", "keyboard-binding"].includes(definition.kind)) {
      throw new Error(`Home setting has no reusable binding: ${config.id}`);
    }
    const control = source.cloneNode(true);
    control.id = `home-${source.id}`;
    control.dataset.settingAlias = definition.key;
    control.removeAttribute("style");
    control.removeAttribute("onchange");
    control.removeAttribute("aria-describedby");
    labelOptions(control, config);
    const label = element("label", "home-field");
    label.htmlFor = control.id;
    const copy = element("span", "label-text", config.label);
    if (config.help) {
      const help = element("span", "home-field-help", config.help);
      if (config.inlineHelp) help.dataset.helpInline = "";
      help.id = `${control.id}-help`;
      control.setAttribute("aria-describedby", help.id);
      copy.append(help);
    }
    label.append(copy, control);
    shortcuts.push({ config, source, control, label, key: definition.key, options: source.innerHTML });
    return label;
  }

  function link(page, text) {
    const button = element("button", "home-detail-link", text);
    button.type = "button";
    button.dataset.openPage = page;
    return button;
  }

  function makeSection(section) {
    const card = element("section", "setting-group home-card");
    card.dataset.tab = "overview";
    card.id = `home-section-${section.id}`;
    const header = element("div", "home-card-header");
    const heading = element("h4", "", section.title);
    heading.id = `home-heading-${section.id}`;
    card.setAttribute("aria-labelledby", heading.id);
    header.append(heading);
    card.append(header);
    const fields = element("div", "home-card-fields");
    section.fields.forEach((config) => fields.append(makeField(config)));
    card.append(fields);
    if (section.warning) {
      const warning = element("p", "home-warning");
      warning.id = "homeManualWarning";
      warning.setAttribute("role", "status");
      card.append(warning);
    }
    const footer = element("div", "home-card-actions");
    for (const [id, title] of section.actions || []) {
      const button = element("button", "home-action", title);
      button.type = "button";
      button.dataset.homeAction = id;
      if (id === "openDictionarySettings") button.dataset.dictionarySettingsLabel = "";
      button.addEventListener("click", () => document.getElementById(id)?.click());
      footer.append(button);
    }
    for (const [page, title] of section.links || []) footer.append(link(page, title));
    if (!section.links) footer.append(link(section.page, "All settings →"));
    card.append(footer);
    return card;
  }

  function render() {
    const mount = document.getElementById("settingsHome");
    if (!mount || rendered) return;
    rendered = true;
    const context = element("div", "home-context");
    const profile = element("span", "home-profile");
    profile.append(element("span", "", "Active Profile"));
    const name = element("strong", "", "Default");
    name.id = "homeProfileName";
    profile.append(name);
    context.append(profile);
    const status = element("span", "home-current-setup");
    status.id = "homeCurrentSetup";
    const actions = element("div", "home-primary-actions");
    actions.append(link("system-profiles", "Manage Profiles →"));
    context.append(status, actions);
    const presets = element("section", "setting-group home-presets");
    presets.dataset.tab = "overview";
    presets.id = "overlayPresetsGroup";
    const header = element("div", "home-presets-heading");
    header.append(element("h4", "", "Quick Setup"));
    const modes = element("div", "preset-cards home-mode-cards");
    modes.id = "overlayPresetCards";
    const recipesRow = element("div", "home-recipes-row");
    const recipesLabel = element("span", "home-recipes-heading", "Presets");
    const recipes = element("div", "home-recipe-cards");
    recipes.id = "overlayRecipeCards";
    recipesRow.append(recipesLabel, recipes);
    const presetStatus = element("p", "home-preset-status");
    presetStatus.id = "homePresetStatus";
    presetStatus.setAttribute("role", "status");
    presets.append(header, modes, recipesRow, presetStatus);
    const grid = element("div", "home-settings-grid");
    grid.append(...sections.map(makeSection));
    mount.append(context, presets, grid);
    const observer = new MutationObserver(refresh);
    for (const { source } of shortcuts)
      observer.observe(source, {
        attributes: true,
        attributeFilter: ["disabled", "readonly"],
        childList: source.tagName === "SELECT",
        subtree: source.tagName === "SELECT",
      });
    window.addEventListener("beforeunload", () => observer.disconnect(), { once: true });
    refresh();
  }

  function refresh() {
    if (!rendered || refreshPending) return;
    refreshPending = true;
    // A profile applies many bindings in one batch. Update the dashboard once,
    // after all values and their dependent controls have settled.
    queueMicrotask(() => {
      refreshPending = false;
      if (global.document?.getElementById("settingsHome")) refreshPresentation();
    });
  }

  function refreshPresentation() {
    for (const entry of shortcuts) {
      const { source, control, label, config } = entry;
      control.disabled = source.disabled;
      label.hidden = config.when ? !config.when() : false;
      if (source.tagName === "SELECT" && source.innerHTML !== entry.options) {
        entry.options = source.innerHTML;
        control.replaceChildren(...Array.from(source.options, (option) => option.cloneNode(true)));
        labelOptions(control, config);
        control.value = String(settingBindingState.get(entry.key) ?? source.value);
      }
    }
    document.querySelectorAll("[data-home-action]").forEach((button) => {
      button.disabled = document.getElementById(button.dataset.homeAction)?.disabled === true;
    });
    document.getElementById("homeProfileName").textContent = overlayProfileState.currentGSMProfileName;
    const activation = checked("manualMode")
      ? `${value("manualModeType") === "toggle" ? "Toggle" : "Hold"} to show · ${value("showHotkey") || "Set a shortcut"}`
      : "Overlay always available";
    document.getElementById("homeCurrentSetup").textContent = activation;
    const warning = document.getElementById("homeManualWarning");
    const messages = [
      "manual-hotkey-platform-warning",
      "manual-hotkey-runtime-warning",
      "manual-hotkey-mouse-hold-warning",
    ]
      .map((id) => document.getElementById(id))
      .filter((el) => el && el.style.display !== "none" && el.textContent);
    warning.textContent = messages
      .map((el) =>
        el.textContent.startsWith("Electron hold mode")
          ? "If holding the shortcut is unreliable in your game, choose Toggle instead."
          : el.textContent,
      )
      .join(" ");
    warning.hidden = !checked("manualMode") || !warning.textContent;
  }

  global.GSMSettingsHome = { render, refresh, searchTermsFor: (id) => searchTerms.get(id) || "" };
})(window);
