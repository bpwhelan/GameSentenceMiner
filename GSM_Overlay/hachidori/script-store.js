// SPDX-License-Identifier: GPL-3.0-or-later

// Advanced → User scripts → Script Store (docs/user-scripts.md): the packages
// people share in bee-san/hachidori-scripts, under the user's own scripts.
// Check for scripts reads the catalogue.json that the repository's
// tools/build-catalogue.mjs writes, and nothing is fetched before the user
// asks. Install copies a package into the user's scripts with its slug and
// version; Update replaces an installed package's parts with the catalogue's
// once the version differs, here or from its row in Your scripts. View code
// shows a package's code, read-only, before it is installed. A package's
// JavaScript then runs as the user's own scripts do, through the User Scripts
// API.
import { packageSize } from "./user-script-settings.js";

export const SCRIPT_STORE_REPOSITORY = "https://github.com/bee-san/hachidori-scripts";
export const SCRIPT_STORE_CATALOGUE = "https://raw.githubusercontent.com/bee-san/hachidori-scripts/main/catalogue.json";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TEXT_FIELDS = ["name", "description", "author", "version", "license"];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

// The catalogue's packages, in its order. The repository's checks keep it in
// this shape, so anything else is refused whole.
export function parseCatalogue(value) {
  if (!value || typeof value !== "object" || value.schema !== 1 || !Array.isArray(value.scripts)) {
    throw new Error("its list is in a format this version of Hachidori cannot read");
  }
  const slugs = new Set();
  return value.scripts.map((entry) => {
    const valid = entry && typeof entry === "object" && typeof entry.slug === "string" && SLUG.test(entry.slug)
      && !slugs.has(entry.slug)
      && TEXT_FIELDS.every(field => typeof entry[field] === "string" && entry[field].trim() !== ""
        && !CONTROL_CHARACTERS.test(entry[field]))
      && typeof entry.javascript === "string" && typeof entry.css === "string"
      && (entry.javascript.trim() !== "" || entry.css.trim() !== "");
    if (!valid) throw new Error("its list has a package this version of Hachidori cannot read");
    slugs.add(entry.slug);
    const { slug, name, description, author, version, license, javascript, css } = entry;
    return { slug, name, description, author, version, license, javascript, css };
  });
}

export function createScriptStore({
  document,
  fetch,
  readScripts,
  saveScripts,
  createId = () => document.defaultView.crypto.randomUUID(),
  loadCodeEditor = () => import("./code-editor.js"),
  // After each check, so Your scripts can offer the updates it found.
  onCatalogue = () => {},
}) {
  const list = document.getElementById("script-store-list");
  const check = document.getElementById("script-store-check");
  const status = document.getElementById("script-store-status");
  const listFormat = new Intl.ListFormat("en-GB");
  let catalogue = null;
  let rendered = null;
  // The packages whose code is shown, by slug, kept across redraws.
  const shown = new Set();

  function setStatus(message, tone = "") {
    status.className = tone ? `custom-dictionary-status is-${tone}` : "custom-dictionary-status";
    status.textContent = message;
  }

  const installedOf = entry => readScripts().find(script => script.store?.slug === entry.slug) ?? null;

  function action(entry) {
    const installed = installedOf(entry);
    if (installed?.store.version === entry.version) {
      const done = document.createElement("span");
      done.className = "script-store-installed";
      const mark = document.createElement("span");
      mark.className = "hd-icon";
      mark.dataset.icon = "checkmark";
      mark.setAttribute("aria-hidden", "true");
      done.append(mark, "Installed");
      return done;
    }
    const button = document.createElement("button");
    button.type = "button";
    // An update is the one thing in the list waiting on the user.
    button.className = installed ? "primary-button" : "ghost";
    button.dataset.action = installed ? "update" : "install";
    button.textContent = installed ? `Update to ${entry.version}` : "Install";
    button.setAttribute("aria-label", installed ? `Update ${entry.name} to ${entry.version}` : `Install ${entry.name}`);
    button.addEventListener("click", () => (installed ? update(installed, entry) : install(entry)));
    return button;
  }

  // The package's JavaScript and CSS, read-only, each named and sized. A Hide
  // or another View while the code editor loads leaves one copy, or none.
  async function showCode(region, entry) {
    try {
      const { createCodeView } = await loadCodeEditor();
      if (!shown.has(entry.slug)) return;
      region.replaceChildren();
      for (const [key, label] of [["javascript", "JavaScript"], ["css", "CSS"]]) {
        if (!entry[key].trim()) continue;
        const heading = document.createElement("p");
        heading.className = "field-label";
        heading.textContent = `${label} · ${packageSize({ javascript: entry[key], css: "" })}`;
        region.append(heading);
        createCodeView(region, { language: key, text: entry[key], label: `${label} of ${entry.name}` });
      }
    } catch (cause) {
      region.textContent = `The code could not be shown: ${cause?.message ?? cause}`;
    }
  }

  function codeRegion(entry) {
    const region = document.createElement("div");
    region.className = "script-store-code";
    region.id = `script-store-code-${entry.slug}`;
    region.hidden = !shown.has(entry.slug);
    if (!region.hidden) void showCode(region, entry);
    return region;
  }

  function codeToggle(entry, region) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ghost";
    toggle.dataset.action = "code";
    toggle.setAttribute("aria-controls", region.id);
    const sync = () => {
      toggle.textContent = shown.has(entry.slug) ? "Hide code" : "View code";
      toggle.setAttribute("aria-expanded", String(shown.has(entry.slug)));
    };
    toggle.addEventListener("click", () => {
      if (shown.delete(entry.slug)) region.replaceChildren();
      else {
        shown.add(entry.slug);
        void showCode(region, entry);
      }
      region.hidden = !shown.has(entry.slug);
      sync();
    });
    sync();
    return toggle;
  }

  function createRow(entry) {
    const row = document.createElement("li");
    row.className = "script-store-row";
    row.dataset.slug = entry.slug;
    const text = document.createElement("div");
    text.className = "script-store-text";
    const name = document.createElement("strong");
    name.className = "script-store-name";
    name.textContent = entry.name;
    const description = document.createElement("p");
    description.className = "script-store-description";
    description.textContent = entry.description;
    const details = document.createElement("span");
    details.className = "script-store-details";
    const contents = [entry.javascript.trim() && "JavaScript", entry.css.trim() && "CSS"].filter(Boolean).join(" and ");
    const source = document.createElement("a");
    source.href = `${SCRIPT_STORE_REPOSITORY}/tree/main/scripts/${entry.slug}`;
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    source.textContent = "Source";
    details.append(`By ${entry.author} · version ${entry.version} · ${entry.license} · ${contents}, ${packageSize(entry)} · `, source);
    text.append(name, description, details);
    const actions = document.createElement("div");
    actions.className = "script-store-actions";
    const region = codeRegion(entry);
    actions.append(codeToggle(entry, region), action(entry));
    row.append(text, actions, region);
    return row;
  }

  function render() {
    const key = JSON.stringify([catalogue, readScripts().map(script => script.store ?? null)]);
    if (key === rendered) return;
    rendered = key;
    list.replaceChildren(...(catalogue ?? []).map(createRow));
  }

  // Install or Update when the row still has one, else View code.
  function focusRow(slug) {
    const row = [...list.children].find(item => item.dataset.slug === slug);
    (row?.querySelector('[data-action="install"], [data-action="update"]') ?? row?.querySelector("button") ?? check).focus();
  }

  function install(entry) {
    saveScripts([...readScripts(), { id: createId(), name: entry.name, enabled: true, javascript: entry.javascript,
      css: entry.css, store: { slug: entry.slug, version: entry.version } }]);
    render();
    focusRow(entry.slug);
    setStatus(`Installed ${entry.name}. It runs on the pages you open or reload.`, "ready");
  }

  function update(installed, entry, focus = true) {
    saveScripts(readScripts().map(script => (script.id === installed.id
      ? { ...script, name: entry.name, javascript: entry.javascript, css: entry.css,
        store: { slug: entry.slug, version: entry.version } }
      : script)));
    render();
    if (focus) focusRow(entry.slug);
    setStatus(`Updated ${entry.name} to version ${entry.version}.`, "ready");
  }

  // Installed packages that the last check found another version of: the
  // version Update installs, by the package's id. Empty before a check.
  function updates() {
    const found = new Map();
    for (const entry of catalogue ?? []) {
      const installed = installedOf(entry);
      if (installed && installed.store.version !== entry.version) found.set(installed.id, entry);
    }
    return found;
  }

  // Your scripts' Update: the installed package `id` to the checked version.
  function updateScript(id) {
    const entry = updates().get(id);
    if (entry) update(readScripts().find(script => script.id === id), entry, false);
  }

  check.addEventListener("click", async () => {
    check.disabled = true;
    setStatus("Checking…");
    try {
      const response = await fetch(SCRIPT_STORE_CATALOGUE, { cache: "no-store" });
      if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`);
      catalogue = parseCatalogue(await response.json());
      render();
      onCatalogue();
      const count = catalogue.length === 1 ? "1 script is in the Script Store." : `${catalogue.length} scripts are in the Script Store.`;
      const names = [...updates().values()].map(entry => entry.name);
      let offer = "";
      if (names.length > 0) offer = ` ${names.length === 1 ? "An update is" : "Updates are"} ready for ${listFormat.format(names)}.`;
      setStatus(`${count}${offer}`, "ready");
    } catch (error) {
      setStatus(`Could not check the Script Store: ${error.message}. Check your connection, then try again.`, "error");
    } finally {
      check.disabled = false;
      // A disabled button loses focus; give it back to whoever pressed it.
      if (document.activeElement === document.body) check.focus();
    }
  });

  return { render, updates, updateScript };
}
