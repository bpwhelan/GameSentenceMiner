// SPDX-License-Identifier: GPL-3.0-or-later
//
// The settings a language pack defines (docs/languages.md 7.5), rendered from
// the pack's schema as experimental-settings.js renders its flags, under
// Advanced → Languages: {Language} options for `group: "lookup"`, then
// {Language} display for `group: "display"`. A display setting shows only
// while the selected theme declares that it renders `presentation` (section
// 11.3). Settings imports this module only once the edited profile's pack
// declares settings.

const GROUPS = {
  lookup: { id: "language-lookup-settings", legend: name => `${name} options` },
  display: { id: "language-display-settings", legend: name => `${name} display` },
};

function settingValue(setting, values) {
  return globalThis.HDReaderOptions.packSettingValue({ settings: [setting] }, values, setting.id);
}

function controlFor(document, setting, value, onChange) {
  const id = `opt-pack-${setting.id}`;
  const describedBy = typeof setting.description === "string" && setting.description !== "" ? `${id}-help` : "";
  const { row, control } = setting.type === "boolean" ? checkboxRow(document, setting, onChange) : fieldRow(document, setting, onChange);
  control.id = id;
  const nodes = [row];
  if (describedBy) {
    control.setAttribute("aria-describedby", describedBy);
    // A switch's description follows its row; a field's hint is in the field.
    const boolean = setting.type === "boolean";
    const hint = document.createElement(boolean ? "p" : "span");
    hint.className = "field-hint";
    hint.id = describedBy;
    hint.textContent = setting.description;
    if (boolean) nodes.push(hint);
    else row.append(hint);
  }
  setValue(document, control, setting, value);
  return { nodes, control };
}

// A boolean setting is a check row, as the Settings switches beside it are.
function checkboxRow(document, setting, onChange) {
  const row = document.createElement("label");
  row.className = "lookup-enable";
  const label = document.createElement("span");
  label.textContent = setting.label;
  const control = document.createElement("input");
  control.type = "checkbox";
  row.append(label, control);
  control.addEventListener("change", () => onChange(setting.id, control.checked));
  return { row, control };
}

// An enum or number setting is a labelled field.
function fieldRow(document, setting, onChange) {
  const row = document.createElement("label");
  row.className = "field";
  const label = document.createElement("span");
  label.className = "field-label";
  label.textContent = setting.label;
  const control = setting.type === "enum" ? selectFor(document, setting, onChange) : numberFor(document, setting, onChange);
  row.append(label, control);
  return { row, control };
}

function selectFor(document, setting, onChange) {
  const control = document.createElement("select");
  for (const choice of setting.values ?? []) control.add(new Option(choice.label ?? choice.id, choice.id));
  control.addEventListener("change", () => onChange(setting.id, control.value));
  return control;
}

function numberFor(document, setting, onChange) {
  const control = document.createElement("input");
  control.type = "number";
  for (const key of ["min", "max", "step"]) {
    if (typeof setting[key] === "number") control[key] = String(setting[key]);
  }
  control.addEventListener("change", () => {
    const number = Number(control.value);
    if (control.value !== "" && Number.isFinite(number)) onChange(setting.id, number);
  });
  return control;
}

function setValue(document, control, setting, value) {
  if (control === document.activeElement) return;
  if (setting.type === "boolean") {
    if (control.checked !== (value === true)) control.checked = value === true;
  } else if (control.value !== String(value)) control.value = String(value);
}

// Builds, updates or removes the two fieldsets for `descriptor` (null: none).
// A theme that does not declare presentation shows the stored headword, so
// the pack's display settings would change nothing (section 11.4): the card
// keeps its place and says so, with the way to Design, instead of its rows.
function renderDisplayNote(document, fieldset, presentation, themeName) {
  for (const row of fieldset.querySelectorAll(".language-setting")) {
    if (row.hidden === presentation) row.hidden = !presentation;
  }
  let note = fieldset.querySelector(".language-display-note");
  if (presentation) {
    note?.remove();
    return;
  }
  if (note === null) {
    note = document.createElement("p");
    note.className = "field-hint language-display-note";
    fieldset.append(note);
  }
  // Rebuilt only when its text changes, so a focused link keeps focus.
  const theme = themeName ? `The ${themeName} theme` : "The chosen theme";
  const text = `${theme} does not use these settings. Choose another theme in `;
  if (note.firstChild?.nodeValue !== text) {
    const link = document.createElement("a");
    link.href = "#design";
    link.textContent = "Design";
    note.replaceChildren(text, link, ".");
  }
}

export function renderLanguageSettings({ document, descriptor, name, values, presentation, themeName = null, onChange }) {
  const settings = Array.isArray(descriptor?.settings) ? descriptor.settings : [];
  // Each group's card follows Your languages, or the group before it.
  let anchor = document.getElementById("language-settings");
  for (const [group, { id, legend }] of Object.entries(GROUPS)) {
    const own = settings.filter(setting => setting?.group === group && typeof setting.id === "string");
    let fieldset = document.getElementById(id);
    const key = JSON.stringify([descriptor?.code ?? null, own.map(setting => setting.id)]);
    if (own.length === 0) {
      fieldset?.remove();
      continue;
    }
    if (fieldset === null || fieldset.dataset.languageSettings !== key) {
      fieldset?.remove();
      fieldset = document.createElement("fieldset");
      fieldset.className = "lookup-group";
      fieldset.id = id;
      fieldset.dataset.languageSettings = key;
      const caption = document.createElement("legend");
      fieldset.append(caption);
      for (const setting of own) {
        const { nodes } = controlFor(document, setting, settingValue(setting, values), onChange);
        const wrapper = document.createElement("div");
        wrapper.className = "language-setting";
        wrapper.dataset.packSetting = setting.id;
        wrapper.append(...nodes);
        fieldset.append(wrapper);
      }
      anchor.after(fieldset);
    }
    anchor = fieldset;
    fieldset.querySelector("legend").textContent = legend(name);
    for (const setting of own) {
      const control = document.getElementById(`opt-pack-${setting.id}`);
      setValue(document, control, setting, settingValue(setting, values));
    }
    if (group === "display") renderDisplayNote(document, fieldset, presentation, themeName);
  }
}
