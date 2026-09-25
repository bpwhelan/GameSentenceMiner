// SPDX-License-Identifier: GPL-3.0-or-later
import { reorderSettingsRows } from "./settings-dom.js";

// Labels of the Settings controls that own each toggleable option.
export const KEYBIND_OPTION_LABELS = {
  hoverEnabled: "Enable hover lookups",
  onlyScanJapaneseText: "Japanese text only",
  showNoResultNotice: "Show a popup when a selection has no definition",
  audioAutoplay: "Automatically play the first lookup result",
  sourceHighlightEnabled: "Highlight the word on the page",
  showPopupAudioButton: "Show the audio button",
  showLookupCounts: "Record and show lookup counts",
  definitionBlurEnabled: "Blur definitions by lookup count",
  definitionBlurAnkiMature: "Blur definitions of mature Anki cards",
  definitionBlurFrequencyEnabled: "Blur definitions by frequency threshold",
  showCompactDefinitionSummary: "Show brief definitions beside the headword",
  averageFrequency: "Show frequency averages",
  showFrequencyDictionaryNames: "Show frequency dictionary names",
  showPitchAccentFurigana: "Show pitch in furigana",
  showPitchAccentBadge: "Show pitch badges",
  hidePopupGrammarTags: "Hide grammar tags",
};
const MODIFIER_NAMES = { meta: "Meta", ctrl: "Ctrl", alt: "Alt", shift: "Shift" };
const SCOPE_LABELS = { popup: "While a popup is open", web: "Anywhere on the page" };

// Yomitan's HotkeyUtil display: modifiers first, a letter key without "Key".
export function formatKeybind(key, modifiers) {
  const keyName = typeof key === "string" && key.length === 4 && key.startsWith("Key") ? key.slice(3) : key;
  return [...modifiers.map(modifier => MODIFIER_NAMES[modifier]), ...(keyName === null ? [] : [keyName])].join(" + ");
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function labelControl(control, label) {
  if (control.getAttribute("aria-label") !== label) control.setAttribute("aria-label", label);
}

function renderScopes(row, action, bind) {
  for (const [scope, { label, input }] of Object.entries(row.scopes)) {
    if (input.checked !== bind.scopes.includes(scope)) input.checked = bind.scopes.includes(scope);
    const offered = action.scopes.includes(scope);
    if (input.disabled === offered) input.disabled = !offered;
    if (label.hidden === offered) label.hidden = !offered;
  }
}

export function createKeybindSettingsController({ document, readKeybinds, editKeybinds, readAudioSources,
  getBrowserCommands, openBrowserShortcuts, browserShortcutsAvailable = true }) {
  const window = document.defaultView;
  const { KEYBIND_ACTIONS, KEYBIND_ARGUMENT_DEFAULTS, KEYBIND_MODIFIERS, KEYBIND_MODIFIER_CODES, KEYBIND_SCOPES,
    KEYBIND_TOGGLE_OPTIONS, AUDIO_SOURCE_LABELS, DEFAULT_OPTIONS } = window.HDReaderOptions;
  const actions = new Map(KEYBIND_ACTIONS.map(action => [action.id, action]));
  const list = document.getElementById("keybind-list");
  const rows = [];

  const copy = bind => ({ ...bind, modifiers: [...bind.modifiers], scopes: [...bind.scopes] });
  const defaultFor = action => DEFAULT_OPTIONS.keybinds.find(bind => bind.action === action);

  function change(row, patch) {
    editKeybinds(readKeybinds().map((bind, index) => index === row.index ? { ...bind, ...patch } : bind));
    render();
  }

  // Yomitan's key field: every key press replaces the modifiers, and a
  // non-modifier key replaces the key. Plain Tab still moves focus.
  function capture(row, event) {
    if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const bind = readKeybinds()[row.index];
    const modifiers = KEYBIND_MODIFIERS.filter(modifier => event[`${modifier}Key`] === true);
    const code = event.code && event.code !== "Unidentified" && !KEYBIND_MODIFIER_CODES.has(event.code) ? event.code : bind.key;
    if (code === bind.key && modifiers.join() === bind.modifiers.join()) return;
    change(row, { key: code, modifiers });
  }

  function createRow() {
    const element = document.createElement("li");
    element.className = "keybind-row";
    // Only static markup. Labels and values are assigned below.
    element.innerHTML = `<div class="keybind-heading">
      <label class="keybind-enabled"><input class="keybind-enabled-input" type="checkbox"><span class="keybind-number"></span></label>
      <div class="keybind-buttons"><button type="button" class="ghost keybind-clear">Clear</button>
      <button type="button" class="ghost keybind-reset">Reset</button><button type="button" class="ghost keybind-remove">Remove</button></div></div>
      <div class="keybind-fields">
      <label class="field"><span class="field-label">Keys</span><input class="keybind-input" type="text" readonly spellcheck="false" autocomplete="off" placeholder="Press keys"></label>
      <label class="field"><span class="field-label">Action</span><select class="keybind-action"></select></label>
      <label class="field keybind-count-field"><span class="field-label">Count</span><input class="keybind-count" type="number" min="1" step="1" inputmode="numeric"></label>
      <label class="field keybind-source-field"><span class="field-label">Source</span><select class="keybind-source"></select></label>
      <label class="field keybind-option-field"><span class="field-label">Option</span><select class="keybind-option"></select></label>
      </div>
      <div class="keybind-scopes"></div>`;
    const row = { element, index: -1, sourceKey: "" };
    for (const name of ["enabled-input", "number", "clear", "reset", "remove", "input", "action", "count", "source", "option"]) {
      row[name.replace("-input", "")] = element.querySelector(`.keybind-${name}`);
    }
    row.fields = { count: element.querySelector(".keybind-count-field"), audioSource: element.querySelector(".keybind-source-field"),
      option: element.querySelector(".keybind-option-field") };
    for (const action of KEYBIND_ACTIONS) row.action.add(new window.Option(action.label, action.id));
    row.option.add(new window.Option("Choose an option", ""));
    for (const key of KEYBIND_TOGGLE_OPTIONS) row.option.add(new window.Option(KEYBIND_OPTION_LABELS[key], key));
    row.scopes = Object.fromEntries(KEYBIND_SCOPES.map(scope => {
      const label = document.createElement("label");
      label.className = "keybind-scope";
      const input = document.createElement("input");
      input.type = "checkbox";
      label.append(input, SCOPE_LABELS[scope]);
      element.querySelector(".keybind-scopes").append(label);
      input.addEventListener("change", () => {
        const scopes = readKeybinds()[row.index].scopes;
        change(row, { scopes: KEYBIND_SCOPES.filter(item => item === scope ? input.checked : scopes.includes(item)) });
      });
      return [scope, { label, input }];
    }));
    row.enabled.addEventListener("change", () => change(row, { enabled: row.enabled.checked }));
    row.input.addEventListener("keydown", event => capture(row, event));
    row.clear.addEventListener("click", () => change(row, { key: null, modifiers: [] }));
    row.reset.addEventListener("click", () => {
      const fallback = defaultFor(readKeybinds()[row.index].action);
      if (fallback) change(row, { key: fallback.key, modifiers: [...fallback.modifiers], argument: fallback.argument });
    });
    row.remove.addEventListener("click", () => {
      editKeybinds(readKeybinds().filter((_, index) => index !== row.index));
      render();
      document.getElementById("keybind-add").focus();
    });
    // Yomitan resets the argument and offers the new action's scopes.
    row.action.addEventListener("change", () => {
      const action = actions.get(row.action.value);
      change(row, { action: action.id, argument: action.argument ? KEYBIND_ARGUMENT_DEFAULTS[action.argument] : "",
        scopes: [...action.scopes] });
    });
    row.count.addEventListener("input", () => {
      if (/^[1-9]\d*$/u.test(row.count.value)) change(row, { argument: row.count.value });
    });
    row.source.addEventListener("change", () => change(row, { argument: row.source.value }));
    row.option.addEventListener("change", () => change(row, { argument: row.option.value }));
    element.addEventListener("focusout", () => { window.queueMicrotask(render); });
    return row;
  }

  function renderSources(row, bind) {
    const sources = readAudioSources();
    const key = JSON.stringify([sources.map(({ id, type }) => [id, type]), bind.argument]);
    if (row.source === document.activeElement || row.sourceKey === key) return;
    row.source.replaceChildren(new window.Option("Choose a source", ""));
    sources.forEach((source, index) => row.source.add(
      new window.Option(`${index + 1}. ${AUDIO_SOURCE_LABELS[source.type]}`, source.id)));
    if (bind.argument && !sources.some(source => source.id === bind.argument)) {
      row.source.add(new window.Option("Removed source", bind.argument));
    }
    row.source.value = bind.argument;
    row.sourceKey = key;
  }

  // Settings never overwrites the control a reader is editing.
  function setValue(control, value) {
    if (control !== document.activeElement && control.value !== value) control.value = value;
  }

  function renderArgument(row, action, bind) {
    for (const [kind, field] of Object.entries(row.fields)) {
      if (field.hidden !== (action.argument !== kind)) field.hidden = action.argument !== kind;
    }
    if (action.argument === "count") setValue(row.count, bind.argument);
    if (action.argument === "audioSource") renderSources(row, bind);
    if (action.argument === "option") setValue(row.option, bind.argument);
  }

  function renderRow(row, bind, index) {
    const action = actions.get(bind.action);
    const number = `keybind ${index + 1}`;
    row.index = index;
    if (row.enabled.checked !== bind.enabled) row.enabled.checked = bind.enabled;
    setText(row.number, `Keybind ${index + 1}`);
    const display = formatKeybind(bind.key, bind.modifiers);
    if (row.input.value !== display) row.input.value = display;
    setValue(row.action, bind.action);
    renderArgument(row, action, bind);
    renderScopes(row, action, bind);
    row.reset.disabled = !defaultFor(bind.action);
    labelControl(row.enabled, `Enable ${number}`);
    labelControl(row.input, `Keys for ${number}: press a key combination`);
    for (const [key, label] of [["clear", "Clear keys"], ["reset", "Reset"], ["remove", "Remove"]]) {
      labelControl(row[key], `${label}: ${number}`);
    }
  }

  function render() {
    const keybinds = readKeybinds();
    while (rows.length > keybinds.length) rows.pop().element.remove();
    while (rows.length < keybinds.length) rows.push(createRow());
    keybinds.forEach((bind, index) => renderRow(rows[index], bind, index));
    reorderSettingsRows(list, rows.map(row => row.element));
    const empty = document.getElementById("keybind-empty");
    if (empty.hidden !== (keybinds.length > 0)) empty.hidden = keybinds.length > 0;
  }

  document.getElementById("keybind-add").addEventListener("click", () => {
    editKeybinds([...readKeybinds(), { action: "", argument: "", key: null, modifiers: [], scopes: ["popup"], enabled: true }]);
    render();
    rows.at(-1).input.focus();
  });
  document.getElementById("keybind-reset-all").addEventListener("click", () => {
    editKeybinds(DEFAULT_OPTIONS.keybinds.map(copy));
    render();
  });

  // Chrome owns its extension commands; Settings lists them and links there.
  async function renderBrowserCommands() {
    if (!browserShortcutsAvailable) return;
    const commands = await getBrowserCommands();
    document.getElementById("browser-shortcut-list").replaceChildren(...commands.map(({ name, description, shortcut }) => {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = description || (name === "_execute_action" ? "Open the Hachidori toolbar" : name);
      const keys = document.createElement("kbd");
      keys.textContent = shortcut || "Not set";
      item.append(label, keys);
      return item;
    }));
  }
  document.getElementById("browser-shortcuts").disabled = !browserShortcutsAvailable;
  document.getElementById("browser-shortcuts-overlay-help").hidden = browserShortcutsAvailable;
  if (browserShortcutsAvailable) {
    document.getElementById("browser-shortcuts-open").addEventListener("click", () => { void openBrowserShortcuts(); });
    // Returning from Chrome's shortcut page shows the shortcuts it saved.
    window.addEventListener("focus", () => { void renderBrowserCommands(); });
    void renderBrowserCommands();
  }
  return { render, renderBrowserCommands };
}
