// SPDX-License-Identifier: GPL-3.0-or-later

// Settings → Advanced → Experimental features. Rows are built once from the
// registry in reader-options.js; `render` only reflects the stored flags.
export function createExperimentalSettings({ document, features, onToggle }) {
  const list = document.getElementById("experimental-features");
  const empty = document.getElementById("experimental-empty");
  const rows = new Map();

  for (const feature of features) {
    const item = document.createElement("li");
    const label = document.createElement("label");
    label.className = "lookup-enable";
    const name = document.createElement("span");
    name.textContent = feature.label;
    const input = document.createElement("input");
    input.id = `opt-experimental-${feature.id}`;
    input.type = "checkbox";
    input.setAttribute("aria-describedby", `${input.id}-help`);
    input.addEventListener("change", () => onToggle(feature.id, input.checked));
    label.append(name, input);
    const hint = document.createElement("p");
    hint.className = "field-hint";
    hint.id = `${input.id}-help`;
    hint.textContent = feature.description;
    let link = null;
    if (feature.section) {
      link = document.createElement("a");
      link.href = `#${feature.section}`;
      link.textContent = "Open its settings";
      hint.append(" ", link);
    }
    item.append(label, hint);
    list.append(item);
    rows.set(feature.id, { input, link });
  }
  empty.hidden = features.length > 0;

  function render(experimental) {
    for (const [id, { input, link }] of rows) {
      const enabled = experimental[id] === true;
      input.checked = enabled;
      if (link) link.hidden = !enabled;
    }
  }

  return { render };
}
