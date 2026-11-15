// SPDX-License-Identifier: GPL-3.0-or-later

// Advanced → User scripts (docs/user-scripts.md): the user's packages of
// JavaScript and CSS, in the order they run. A row switches its package on or
// off, moves it, opens it in the editor below the list, or deletes it once the
// row's confirmation is accepted. The editor saves explicitly, so half-typed
// code never runs. Its JavaScript and CSS are textareas until the code editor
// (code-editor.js), which the editor's first opening loads, takes their place
// with their text. A package installed from the Script Store under the list
// (script-store.js) keeps its slug and version until an edit makes it the
// user's own; once the Script Store's check finds another version of it, its
// row offers Update too.

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const BLANK = Object.freeze({ name: "", javascript: "", css: "" });

// The JavaScript Add script starts from. Saved unchanged it counts as none, so
// a script of CSS alone still needs no permission.
export const STARTER_JAVASCRIPT = `// Runs in every page and frame from its next load, and on the search page.
// What a script can use: https://github.com/bee-san/hachidori/blob/main/docs/user-scripts.md
window.addEventListener("hachidori-popup-shown", () => {
  // The popup, drawn afresh for each lookup.
  const popup = document.querySelector("hachidori-host").shadowRoot;
});
`;

// "1.2 KB" for the package's two parts together.
export function packageSize(script) {
  const bytes = new TextEncoder().encode(script.javascript + script.css).length;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

// A package's name from a file's: "copy-word.js" becomes "copy word".
export function nameFromFile(fileName) {
  return fileName.replace(/\.(?:js|css)$/iu, "").replace(/[-_]+/gu, " ").trim();
}

// A chosen file's text, or an error that names the file.
async function readText(file) {
  try {
    return await file.text();
  } catch (cause) {
    throw new Error(`${file.name} could not be read: ${cause?.message ?? cause}`);
  }
}

export function createUserScriptSettings({
  document,
  readScripts,
  saveScripts,
  createId = () => document.defaultView.crypto.randomUUID(),
  loadCodeEditor = () => import("./code-editor.js"),
  // The Script Store's last check: the versions it would update packages to,
  // by package id, and the way to apply one.
  readUpdates = () => new Map(),
  applyUpdate = () => {},
}) {
  const list = document.getElementById("user-script-list");
  const empty = document.getElementById("user-script-empty");
  const status = document.getElementById("user-script-status");
  const form = document.getElementById("user-script-form");
  const heading = document.getElementById("user-script-form-heading");
  const name = document.getElementById("user-script-name");
  const error = document.getElementById("user-script-error");
  const submit = document.getElementById("user-script-submit");
  const add = document.getElementById("user-script-add");
  const storeNote = document.getElementById("user-script-store-note");
  const parts = ["javascript", "css"].map(key => ({
    key,
    editor: document.getElementById(`user-script-${key}`),
    count: document.getElementById(`user-script-${key}-count`),
    problems: document.getElementById(`user-script-${key}-problems`),
    file: document.getElementById(`user-script-${key}-file`),
  }));
  const numberFormat = new Intl.NumberFormat();
  const listFormat = new Intl.ListFormat("en-GB");
  // The package the editor shows: `id` null for a new one, `start` its fields
  // when it opened, so Cancel and leaving the page know about unsaved edits.
  let editing = null;
  let confirming = null;
  let rendered = null;
  let codeEditors = null;

  const fields = () => ({ name: name.value, javascript: parts[0].editor.value, css: parts[1].editor.value });
  const dirty = () => editing !== null && JSON.stringify(fields()) !== JSON.stringify(editing.start);

  function button(text, label, onClick, { action, tone, icon } = {}) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = tone ? `ghost ${tone}` : "ghost";
    if (icon) {
      const glyph = document.createElement("span");
      glyph.className = "hd-icon";
      glyph.dataset.icon = icon;
      glyph.setAttribute("aria-hidden", "true");
      node.append(glyph);
    } else {
      node.textContent = text;
    }
    node.setAttribute("aria-label", label);
    if (action) node.dataset.action = action;
    node.addEventListener("click", onClick);
    return node;
  }

  function focusRow(id, action) {
    const row = [...list.children].find(item => item.dataset.id === id);
    (row?.querySelector(`[data-action="${action}"]:not(:disabled)`) ?? row?.querySelector("button:not(:disabled)") ?? add)
      .focus();
  }

  // Saves the list and redraws it now, so the save's own redraw is a no-op.
  function commit(scripts) {
    saveScripts(scripts);
    render();
  }

  function move(index, offset) {
    const scripts = readScripts().slice();
    [scripts[index], scripts[index + offset]] = [scripts[index + offset], scripts[index]];
    const { id } = scripts[index + offset];
    commit(scripts);
    focusRow(id, offset < 0 ? "up" : "down");
  }

  function remove(id) {
    const scripts = readScripts();
    const index = scripts.findIndex(script => script.id === id);
    confirming = null;
    if (editing?.id === id) closeForm();
    commit(scripts.filter(script => script.id !== id));
    const next = readScripts()[Math.min(index, readScripts().length - 1)];
    if (next) focusRow(next.id, "edit");
    else add.focus();
  }

  function confirmation(script) {
    const box = document.createElement("div");
    box.className = "user-script-confirm";
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", `Delete ${script.name}?`);
    const text = document.createElement("p");
    text.textContent = `Delete “${script.name}”? Its JavaScript and CSS are removed from this browser.`;
    const actions = document.createElement("div");
    actions.className = "options-actions";
    const keep = button("Cancel", `Keep ${script.name}`, () => {
      confirming = null;
      render();
      focusRow(script.id, "delete");
    }, { action: "keep" });
    actions.append(button("Delete", `Delete ${script.name} now`, () => remove(script.id), { tone: "danger", action: "confirm" }), keep);
    box.append(text, actions);
    return box;
  }

  function createRow(script, index, count, update) {
    const row = document.createElement("li");
    row.className = script.enabled ? "user-script-row" : "user-script-row is-off";
    row.dataset.id = script.id;
    if (editing?.id === script.id) row.setAttribute("aria-current", "true");
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "user-script-enabled";
    toggle.checked = script.enabled;
    toggle.setAttribute("aria-label", `Run ${script.name}`);
    toggle.addEventListener("change", () => {
      commit(readScripts().map(value => (value.id === script.id ? { ...value, enabled: toggle.checked } : value)));
      focusRow(script.id, "toggle");
    });
    toggle.dataset.action = "toggle";
    const text = document.createElement("div");
    text.className = "user-script-text";
    const label = document.createElement("strong");
    label.className = "user-script-name";
    label.textContent = script.name;
    const summary = document.createElement("span");
    summary.className = "user-script-summary";
    const contents = [script.javascript.trim() && "JavaScript", script.css.trim() && "CSS"].filter(Boolean);
    const source = script.store ? `Script Store v${script.store.version} · ` : "";
    summary.textContent = `${source}${contents.join(" and ") || "Empty"} · ${packageSize(script)}${script.enabled ? "" : " · Off"}`;
    text.append(label, summary);
    const actions = document.createElement("div");
    actions.className = "user-script-actions";
    // An update is the one thing in the list waiting on the user.
    if (update) {
      const install = document.createElement("button");
      install.type = "button";
      install.className = "primary-button";
      install.dataset.action = "update";
      install.textContent = `Update to ${update.version}`;
      install.setAttribute("aria-label", `Update ${script.name} to ${update.version}`);
      install.addEventListener("click", () => {
        applyUpdate(script);
        status.className = "custom-dictionary-status is-ready";
        status.textContent = `Updated ${update.name} to version ${update.version}.`;
        focusRow(script.id, "edit");
      });
      actions.append(install);
    }
    // One script has nothing to move past.
    if (count > 1) {
      const up = button("", `Move up: ${script.name}`, () => move(index, -1), { action: "up", icon: "arrow-up" });
      const down = button("", `Move down: ${script.name}`, () => move(index, 1), { action: "down", icon: "arrow-down" });
      up.disabled = index === 0;
      down.disabled = index === count - 1;
      actions.append(up, down);
    }
    actions.append(
      button("Edit", `Edit ${script.name}`, () => openForm(script), { action: "edit" }),
      button("Delete", `Delete ${script.name}`, () => {
        confirming = script.id;
        render();
        focusRow(script.id, "keep");
      }, { tone: "danger", action: "delete" }));
    row.append(toggle, text, actions);
    if (confirming === script.id) row.append(confirmation(script));
    return row;
  }

  function render() {
    const scripts = readScripts();
    if (confirming !== null && !scripts.some(script => script.id === confirming)) confirming = null;
    const updates = readUpdates();
    const key = JSON.stringify([scripts, confirming, editing?.id ?? null, [...updates].map(([id, { version }]) => [id, version])]);
    if (key === rendered) return;
    rendered = key;
    list.replaceChildren(...scripts.map((script, index) => createRow(script, index, scripts.length, updates.get(script.id))));
    empty.hidden = scripts.length > 0;
  }

  // The lines the code editor finds a syntax error on, under the part's count.
  function problemText(key, lines) {
    if (lines.length === 0) return "";
    let where = `Syntax errors on ${lines.length} lines, from line ${lines[0]}.`;
    if (lines.length === 1) where = `Syntax error on line ${lines[0]}.`;
    else if (lines.length <= 3) where = `Syntax errors on lines ${listFormat.format(lines.map(String))}.`;
    if (key === "css") return `${where} Browsers skip what they cannot read.`;
    return `${where} The JavaScript does not run until ${lines.length === 1 ? "it is" : "they are"} fixed.`;
  }

  function renderCounts() {
    for (const part of parts) {
      part.count.textContent = `${numberFormat.format(part.editor.value.length)} characters`;
      part.problems.textContent = problemText(part.key, part.editor.problems ?? []);
    }
  }

  function fill(values) {
    name.value = values.name;
    parts[0].editor.value = values.javascript;
    parts[1].editor.value = values.css;
    renderCounts();
  }

  // Each part's code editor takes over from its textarea, with what the
  // textarea holds by then. Until it loads, or if it cannot, the textareas edit.
  function loadCodeEditors() {
    codeEditors ??= loadCodeEditor().then(({ createCodeEditor }) => {
      for (const part of parts) part.editor = createCodeEditor(part.editor, { language: part.key, onChange: renderCounts });
    }).catch((cause) => {
      error.textContent = `The code editor could not load, so the plain text boxes stay: ${cause?.message ?? cause}`;
    });
  }

  // `script` is the package to edit, or the fields of a new one; `start` is
  // what counts as unchanged.
  function openForm(script, isNew = false, start = isNew ? BLANK : script) {
    const values = { name: script.name, javascript: script.javascript, css: script.css };
    editing = { id: isNew ? null : script.id, start: { name: start.name, javascript: start.javascript, css: start.css } };
    confirming = null;
    fill(values);
    heading.textContent = isNew ? "New script" : `Edit “${script.name}”`;
    storeNote.hidden = isNew || !script.store;
    submit.textContent = isNew ? "Add script" : "Save script";
    error.textContent = "";
    status.textContent = "";
    form.hidden = false;
    render();
    name.focus();
    loadCodeEditors();
  }

  function closeForm() {
    const id = editing?.id ?? null;
    editing = null;
    form.hidden = true;
    error.textContent = "";
    render();
    return id;
  }

  function fail(message, field) {
    error.textContent = message;
    field.focus();
  }

  function save() {
    const values = fields();
    if (values.javascript === STARTER_JAVASCRIPT) values.javascript = "";
    const label = values.name.trim();
    if (!label) return fail("Enter a name for the script.", name);
    if (CONTROL_CHARACTERS.test(label)) return fail("Enter a name without tabs or other control characters.", name);
    if (!values.javascript.trim() && !values.css.trim()) return fail("Add JavaScript, CSS or both.", parts[0].editor);
    const scripts = readScripts();
    const id = editing.id ?? createId();
    const saved = { name: label, javascript: values.javascript, css: values.css };
    // A changed Script Store package becomes the user's own, which Update leaves alone.
    const edited = (script) => {
      const result = { ...script, ...saved };
      if (Object.keys(saved).some(key => saved[key] !== script[key])) delete result.store;
      return result;
    };
    const next = editing.id === null
      ? [...scripts, { id, enabled: true, ...saved }]
      : scripts.map(script => (script.id === id ? edited(script) : script));
    editing = null;
    form.hidden = true;
    commit(next);
    focusRow(id, "edit");
  }

  // Import: a .js file, a .css file or one of each open as a new package.
  async function importFiles(files) {
    const javascriptFile = files.find(file => /\.js$/iu.test(file.name));
    const cssFile = files.find(file => /\.css$/iu.test(file.name));
    if (!javascriptFile && !cssFile) {
      status.className = "custom-dictionary-status is-error";
      status.textContent = "Choose a .js file, a .css file or one of each.";
      return;
    }
    try {
      const [javascript, css] = await Promise.all([javascriptFile ? readText(javascriptFile) : "", cssFile ? readText(cssFile) : ""]);
      openForm({ name: nameFromFile((javascriptFile ?? cssFile).name), javascript, css }, true);
    } catch (cause) {
      status.className = "custom-dictionary-status is-error";
      status.textContent = cause.message;
    }
  }

  add.addEventListener("click", () => {
    const starter = { ...BLANK, javascript: STARTER_JAVASCRIPT };
    openForm(starter, true, starter);
  });
  document.getElementById("user-script-import").addEventListener("change", (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    if (files.length > 0) void importFiles(files);
  });
  for (const part of parts) {
    part.editor.addEventListener("input", renderCounts);
    // Replaces this part of the package in the editor; Save keeps it.
    part.file.addEventListener("change", async (event) => {
      const [file] = event.target.files;
      event.target.value = "";
      if (!file) return;
      try {
        part.editor.value = await readText(file);
        error.textContent = "";
      } catch (cause) {
        error.textContent = cause.message;
      }
      renderCounts();
      part.editor.focus();
    });
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    save();
  });
  document.getElementById("user-script-cancel").addEventListener("click", () => {
    const id = closeForm();
    if (id) focusRow(id, "edit");
    else add.focus();
  });

  return { render, dirty };
}
