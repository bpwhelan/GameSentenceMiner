// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiAvailability } from "./anki.js";
import { ankiSetupFamily } from "./anki-setup.js";
import { ANKI_TEMPLATE_MARKERS, ankiFieldNames, applyAnkiPreset, resolveAnkiTemplates } from "./anki-templates.js";
import { reorderSettingsRows, setStatusOutput } from "./settings-dom.js";

export function createAnkiSettingsController({
  document,
  readConfig,
  editConfig,
  send,
  capabilities = { screenshot: true },
  readOwnerKey = () => "",
}) {
  const { ANKI_FIELDS, ANKI_OVERWRITE_MODES, normaliseAnkiConnectUrl } = document.defaultView.HDReaderOptions;
  const element = id => document.getElementById(id);
  const selects = new WeakMap();
  let discovery = null;
  let discoveryKey = null;
  let pendingPreset = null;
  let presetModel = null;
  let requestSequence = 0;
  let requestedKey = null;
  let loading = false;
  let findingSetup = false;
  let setupRequestSequence = 0;
  let setupSnapshot = null;
  let ownerKey = String(readOwnerKey() ?? "");
  const templateRows = new Map();
  let nextTemplateId = 0;
  const connectionKey = config => JSON.stringify([config.model, config.apiKey, config.url]);
  if (!capabilities.screenshot) {
    element("opt-anki-screenshot").disabled = true;
    element("anki-screenshot-help").textContent = "Page screenshots are unavailable in this overlay. Screenshot fields stay empty.";
  }

  function change(patch) {
    if (Object.hasOwn(patch, "fields") || Object.hasOwn(patch, "fieldTemplates")) pendingPreset = null;
    editConfig({ ...readConfig(), ...patch });
    render();
  }

  function currentFields() {
    const config = readConfig();
    return discovery?.model === config.model && discoveryKey === connectionKey(config) ? discovery.fields : [];
  }

  function materializeTemplates() {
    const config = readConfig();
    const resolved = resolveAnkiTemplates(config, currentFields());
    return Object.fromEntries([...Object.entries(resolved.templates),
      ...resolved.staleFields.map(field => [field, { ...config.fieldTemplates[field] }])]);
  }

  function editTemplate(field, patch) {
    const templates = materializeTemplates();
    templates[field] = { ...templates[field], ...patch };
    change({ fieldTemplates: templates });
  }

  function createTemplateRow(field) {
    const row = document.createElement("div");
    row.className = "anki-template-row";
    row.innerHTML = `<div class="anki-template-heading"><label class="field-label"></label><button type="button" class="ghost">Remove unavailable field</button></div>
      <textarea rows="2" spellcheck="false" placeholder="Blank disables this field"></textarea>
      <label class="anki-template-mode"><span>On overwrite</span><select></select></label>`;
    const label = row.querySelector(".field-label"), editor = row.querySelector("textarea"), mode = row.querySelector("select");
    editor.id = `opt-anki-template-${++nextTemplateId}`;
    label.htmlFor = editor.id;
    label.textContent = field;
    mode.id = `${editor.id}-mode`;
    mode.setAttribute("aria-label", `On overwrite: ${field}`);
    const names = { coalesce: "Keep existing, fill empty", "coalesce-new": "Use new, keep if empty", skip: "Keep existing",
      append: "Append", prepend: "Prepend", overwrite: "Replace" };
    for (const value of ANKI_OVERWRITE_MODES) mode.add(new document.defaultView.Option(names[value], value));
    const remove = row.querySelector("button");
    const record = { field, row, label, editor, mode, remove, modeLabel: mode.parentElement };
    editor.addEventListener("input", () => editTemplate(record.field, { value: editor.value }));
    mode.addEventListener("change", () => editTemplate(record.field, { overwriteMode: mode.value }));
    remove.addEventListener("click", () => {
      const templates = materializeTemplates();
      delete templates[record.field];
      change({ fieldTemplates: templates });
      element("opt-anki-advanced").focus();
    });
    return record;
  }

  function updateTemplateRow(row, template, advanced, showMode, unavailable) {
    if (row.editor !== document.activeElement && row.editor.value !== template.value) row.editor.value = template.value;
    if (row.mode !== document.activeElement && row.mode.value !== template.overwriteMode) row.mode.value = template.overwriteMode;
    if (row.editor.readOnly === advanced) row.editor.readOnly = !advanced;
    if (row.mode.disabled === advanced) row.mode.disabled = !advanced;
    if (row.modeLabel.hidden === showMode) row.modeLabel.hidden = !showMode;
    if (row.remove.hidden === unavailable) row.remove.hidden = !unavailable;
  }

  function renderTemplates(config, resolved) {
    const templates = [...Object.entries(resolved.templates),
      ...resolved.staleFields.map(field => [field, config.fieldTemplates[field]])];
    const retained = new Set(templates.map(([field]) => field));
    const unavailable = new Set(resolved.staleFields);
    const advanced = config.fieldTemplates !== null;
    const showMode = advanced && config.duplicateBehavior === "overwrite";
    const renamedRows = new Map([...templateRows].filter(([field]) => !retained.has(field))
      .map(([field, row]) => [field.toLowerCase(), row]));
    const container = element("anki-templates");
    for (const [field, template] of templates) {
      if (!templateRows.has(field)) {
        const previous = renamedRows.get(field.toLowerCase());
        if (previous) {
          templateRows.delete(previous.field);
          renamedRows.delete(field.toLowerCase());
          previous.field = field;
          previous.label.textContent = field;
          previous.mode.setAttribute("aria-label", `On overwrite: ${field}`);
        }
        templateRows.set(field, previous || createTemplateRow(field));
      }
      updateTemplateRow(templateRows.get(field), template, advanced, showMode, unavailable.has(field));
    }
    for (const [field, row] of templateRows) {
      if (!retained.has(field)) { row.row.remove(); templateRows.delete(field); }
    }
    reorderSettingsRows(container, templates.map(([field]) => templateRows.get(field).row));
    if (element("anki-fields").hidden !== advanced) element("anki-fields").hidden = advanced;
    element("opt-anki-advanced").checked = advanced;
    const canApply = !loading && currentFields().length > 0;
    if (element("anki-apply-preset").disabled === canApply) element("anki-apply-preset").disabled = !canApply;
    const canEnter = advanced || canApply;
    if (element("opt-anki-advanced").disabled === canEnter) element("opt-anki-advanced").disabled = !canEnter;
  }

  function selectChoices(id, names, value, placeholder, canonical = "") {
    const select = element(id);
    if (select === document.activeElement) return;
    const key = JSON.stringify([names, value, canonical]);
    if (selects.get(select) === key) return;
    const choices = [["", placeholder], ...names.filter(name => name !== canonical || name === value).map(name => [name, name])];
    if (value && !names.includes(value)) choices.push([value, canonical || `${value} (unavailable)`]);
    select.replaceChildren(...choices.map(([name, label]) => new document.defaultView.Option(label, name)));
    select.value = value;
    selects.set(select, key);
  }

  function renderDuplicateScope(config) {
    const select = element("opt-anki-duplicate-scope");
    if (select === document.activeElement) return;
    const choices = [
      ["model", `Note type: ${config.model || "Choose a note type"}`],
      ["deck", `Deck: ${config.deck || "Choose a deck"}`],
      ["all", "All of Anki"],
    ];
    const key = JSON.stringify(choices);
    if (selects.get(select) !== key) {
      select.replaceChildren(...choices.map(([value, label]) => new document.defaultView.Option(label, value)));
      selects.set(select, key);
    }
    select.value = config.duplicateScope;
  }

  function renderStatus(config, resolved) {
    const status = element("anki-status");
    // A URL/API-key/model edit retires the old discovery immediately. Its
    // fields no longer match `resolved`, and must not be rendered while the
    // replacement request (or a linked host-side save) is still pending.
    const currentDiscovery = discoveryKey === connectionKey(config) ? discovery : null;
    const errors = ankiAvailability(config, currentDiscovery, resolved);
    let state = "Not connected";
    if (currentDiscovery?.connected) state = errors.length ? "Connected · configuration needs attention" : "Connected · configuration ready";
    const message = loading ? "Checking AnkiConnect…" : [state, ...errors].join("\n");
    const invalid = !loading && errors.length > 0;
    const tone = loading ? "working" : invalid ? "error" : currentDiscovery?.connected ? "ready" : undefined;
    setStatusOutput(status, message, tone);
    if (element("anki-refresh").disabled !== loading) element("anki-refresh").disabled = loading;
  }

  function setupStatus(message, tone) {
    const status = element("anki-setup-status");
    status.hidden = message === "";
    setStatusOutput(status, message, tone);
  }

  function syncOwner() {
    const next = String(readOwnerKey() ?? "");
    if (next === ownerKey) return;
    ownerKey = next;
    pendingPreset = null;
    setupSnapshot = null;
    setupRequestSequence += 1;
    findingSetup = false;
    element("anki-find-setup").disabled = false;
    setupStatus("");
  }

  async function findSetup() {
    if (findingSetup || commitConnectionUrl() === null) return;
    syncOwner();
    const config = readConfig();
    const snapshot = JSON.stringify(config);
    const requestOwner = ownerKey;
    const sequence = ++setupRequestSequence;
    findingSetup = true;
    element("anki-find-setup").disabled = true;
    setupStatus("Finding your Anki setup…", "working");
    try {
      const reply = await send("hd_anki_setup", {
        anki: config,
        ...(ownerKey === "" ? {} : { templateId: ownerKey }),
      });
      if (sequence !== setupRequestSequence || requestOwner !== String(readOwnerKey() ?? "")) return;
      if (snapshot !== JSON.stringify(readConfig())) {
        throw new Error("Anki settings changed while checking. Your changes were kept; retry to check them.");
      }
      if (!reply.ok) throw new Error(reply.error || "Anki setup discovery did not reply.");
      const { proposal, outcome } = reply;
      if (proposal?.status === "configured") {
        change({ model: proposal.model, deck: proposal.deck, fieldTemplates: proposal.fieldTemplates });
        setupStatus(`Found ${outcome.model} in deck ‘${outcome.deck}’. Changes save automatically.`, "ready");
      } else if (outcome.status === "already-configured") {
        setupStatus(`Your saved ${outcome.model} setup for deck ‘${outcome.deck}’ is ready.`, "ready");
      } else {
        setupStatus(outcome.detail, "error");
      }
    } catch (error) {
      if (sequence !== setupRequestSequence || requestOwner !== String(readOwnerKey() ?? "")) return;
      setupStatus(error.message, "error");
    } finally {
      if (sequence === setupRequestSequence && requestOwner === String(readOwnerKey() ?? "")) {
        findingSetup = false;
        setupSnapshot = JSON.stringify(readConfig());
        element("anki-find-setup").disabled = false;
      }
    }
  }

  async function refresh() {
    const config = readConfig();
    const key = connectionKey(config);
    requestedKey = key;
    const sequence = ++requestSequence;
    loading = true;
    renderStatus(config);
    element("anki-apply-preset").disabled = true;
    if (config.fieldTemplates === null) element("opt-anki-advanced").disabled = true;
    try {
      const reply = await send("hd_anki_discover", { model: config.model, apiKey: config.apiKey, url: config.url });
      if (sequence !== requestSequence || key !== connectionKey(readConfig())) return;
      if (!reply.ok) throw new Error(reply.error);
      discovery = reply;
      discoveryKey = key;
      if (pendingPreset?.key === key && pendingPreset.owner === ownerKey && reply.connected && reply.fields.length > 0) {
        const preset = pendingPreset;
        pendingPreset = null;
        const current = readConfig();
        if (current.fieldTemplates === null && JSON.stringify(current.fields) === preset.fields) {
          editConfig(applyAnkiPreset(current, reply.fields, preset.family));
        }
      }
    } catch (error) {
      if (sequence !== requestSequence || key !== connectionKey(readConfig())) return;
      discovery = { connected: false, model: config.model, decks: [], models: [], fields: [], errors: [error.message] };
      discoveryKey = key;
    } finally {
      if (sequence === requestSequence && key === connectionKey(readConfig())) {
        loading = false;
        render();
      }
    }
  }

  const controls = [
    ["tags", "opt-anki-tags"], ["apiKey", "opt-anki-api-key"],
    ["duplicateScope", "opt-anki-duplicate-scope"], ["duplicateBehavior", "opt-anki-duplicate-behavior"],
    ["captureScreenshot", "opt-anki-screenshot"],
  ];
  function renderBasicMappings(config, fields) {
    if (config.fieldTemplates !== null) return;
    const fieldNames = ankiFieldNames(fields);
    for (const key of ANKI_FIELDS) selectChoices(`opt-anki-field-${key}`, fields, config.fields[key], "Disabled",
      fieldNames.get(config.fields[key].toLowerCase()));
  }

  function renderFormControls(config) {
    const values = { ...config, captureScreenshot: capabilities.screenshot && config.captureScreenshot };
    for (const [key, id] of controls) {
      const control = element(id);
      if (control === document.activeElement) continue;
      if (control.type === "checkbox") control.checked = values[key];
      else control.value = key === "tags" ? values.tags.join(" ") : values[key];
    }
  }

  function render() {
    syncOwner();
    const config = readConfig();
    if (!findingSetup && setupSnapshot !== null && setupSnapshot !== JSON.stringify(config)) {
      setupSnapshot = null;
      setupStatus("");
    }
    if (pendingPreset && (pendingPreset.key !== connectionKey(config) || pendingPreset.owner !== ownerKey)) pendingPreset = null;
    if (presetModel !== config.model) {
      presetModel = config.model;
      element("anki-preset").value = ankiSetupFamily(config.model) || "automatic";
    }
    selectChoices("opt-anki-deck", discovery?.decks || [], config.deck, "Choose a deck");
    selectChoices("opt-anki-model", discovery?.models || [], config.model, "Choose a note type");
    renderDuplicateScope(config);
    const fields = currentFields();
    const url = element("opt-anki-url");
    if (url !== document.activeElement && !url.validity.customError && url.value !== config.url) url.value = config.url;
    renderBasicMappings(config, fields);
    renderFormControls(config);
    const resolved = resolveAnkiTemplates(config, fields);
    renderStatus(config, resolved);
    renderTemplates(config, resolved);
    if (connectionKey(config) !== requestedKey) void refresh();
  }

  const fieldLabels = {
    captureAnimation: "Capture animation",
    captureAudio: "Capture audio",
    screenshot: "Page screenshot",
  };
  for (const key of ANKI_FIELDS) {
    const label = document.createElement("label");
    label.className = "field";
    const text = document.createElement("span");
    text.className = "field-label";
    text.textContent = fieldLabels[key] ?? key[0].toUpperCase() + key.slice(1);
    const select = document.createElement("select");
    select.id = `opt-anki-field-${key}`;
    select.addEventListener("change", () => change({ fields: { ...readConfig().fields, [key]: select.value } }));
    label.append(text, select);
    element("anki-fields").append(label);
  }
  element("opt-anki-deck").addEventListener("change", event => change({ deck: event.target.value }));
  element("opt-anki-model").addEventListener("change", event => {
    if (event.target.value === readConfig().model) return;
    const next = { ...readConfig(), model: event.target.value,
      fields: Object.fromEntries(ANKI_FIELDS.map(key => [key, ""])), fieldTemplates: null };
    const family = ankiSetupFamily(next.model);
    pendingPreset = family
      ? { family, key: connectionKey(next), fields: JSON.stringify(next.fields), owner: ownerKey }
      : null;
    editConfig(next);
    render();
  });
  for (const [key, id] of controls) {
    element(id).addEventListener("change", event => {
      const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
      change({ [key]: key === "tags" ? value.split(/\s+/u).filter(Boolean) : value });
    });
  }
  element("anki").addEventListener("focusout", () => queueMicrotask(render));
  function commitConnectionUrl() {
    const input = element("opt-anki-url");
    const url = normaliseAnkiConnectUrl(input.value);
    const error = url ? "" : "Enter a valid HTTP or HTTPS AnkiConnect URL without a username or password.";
    input.setCustomValidity(error);
    element("anki-url-error").textContent = error;
    if (!url) return null;
    input.value = url;
    if (url === readConfig().url) return false;
    change({ url });
    return true;
  }
  element("opt-anki-url").addEventListener("change", commitConnectionUrl);
  element("anki-refresh").addEventListener("click", () => {
    // A changed URL starts discovery through render; don't start it twice.
    if (commitConnectionUrl() === false) void refresh();
  });
  element("anki-find-setup").addEventListener("click", () => { void findSetup(); });
  element("anki-preset").addEventListener("change", () => { pendingPreset = null; });
  element("anki-apply-preset").addEventListener("click", () => {
    pendingPreset = null;
    editConfig(applyAnkiPreset(readConfig(), currentFields(), element("anki-preset").value));
    render();
  });
  element("opt-anki-advanced").addEventListener("change", event => {
    change({ fieldTemplates: event.target.checked ? materializeTemplates() : null });
  });
  element("anki-markers").textContent = ANKI_TEMPLATE_MARKERS.map(marker => `{${marker}}`).join("  ");
  return { render, refresh };
}

export function createAnkiTemplateSettingsController({
  document,
  readAnki,
  editAnki,
  readButtons = () => [],
  send,
  capabilities = { screenshot: true },
  createId = () => document.defaultView.crypto.randomUUID(),
}) {
  const {
    ANKI_TEMPLATE_CONFIG_KEYS,
    DEFAULT_ANKI_TEMPLATE,
    ankiTemplateConfig,
    normaliseAnki,
  } = document.defaultView.HDReaderOptions;
  const element = id => document.getElementById(id);
  let selectedId = null;
  let renderedChoices = null;

  function currentAnki() {
    return normaliseAnki(readAnki());
  }

  function selected(anki = currentAnki()) {
    let index = anki.templates.findIndex(template => template.id === selectedId);
    if (index < 0) {
      index = 0;
      selectedId = anki.templates[0].id;
    }
    return { anki, index, template: anki.templates[index] };
  }

  function saveTemplates(anki, templates) {
    editAnki(normaliseAnki({ url: anki.url, apiKey: anki.apiKey, templates }));
  }

  function editSelectedConfig(config) {
    const { anki, template } = selected();
    const templates = anki.templates.map(value => value.id === template.id
      ? {
        id: value.id,
        name: value.name,
        ...Object.fromEntries(ANKI_TEMPLATE_CONFIG_KEYS.map(key => [key, config[key]])),
      }
      : value);
    editAnki(normaliseAnki({ url: config.url, apiKey: config.apiKey, templates }));
  }

  const editor = createAnkiSettingsController({
    document,
    readConfig: () => {
      const { anki, template } = selected();
      return ankiTemplateConfig(anki, template.id);
    },
    editConfig: editSelectedConfig,
    send,
    capabilities,
    readOwnerKey: () => selected().template.id,
  });

  function uniqueId() {
    const ids = new Set(currentAnki().templates.map(template => template.id));
    let id;
    do id = createId();
    while (typeof id !== "string" || id === "" || ids.has(id));
    return id;
  }

  function uniqueName(base = "Template") {
    const names = new Set(currentAnki().templates.map(template => template.name));
    if (!names.has(base)) return base;
    for (let suffix = 2; ; suffix++) {
      const name = `${base} ${suffix}`;
      if (!names.has(name)) return name;
    }
  }

  function setSelected(id, focus = false) {
    selectedId = id;
    element("anki-template-status").textContent = "";
    render();
    if (focus) element("anki-template-select").focus();
  }

  function move(offset) {
    const { anki, index } = selected();
    const destination = index + offset;
    if (destination < 0 || destination >= anki.templates.length) return;
    const templates = anki.templates.slice();
    [templates[index], templates[destination]] = [templates[destination], templates[index]];
    saveTemplates(anki, templates);
    render();
    const preferred = element(offset < 0 ? "anki-template-up" : "anki-template-down");
    let focusTarget = preferred;
    if (preferred.disabled) {
      focusTarget = element(offset < 0 ? "anki-template-down" : "anki-template-up");
    }
    focusTarget.focus();
  }

  function add() {
    const anki = currentAnki();
    const template = {
      ...DEFAULT_ANKI_TEMPLATE,
      id: uniqueId(),
      name: uniqueName(),
      tags: [...DEFAULT_ANKI_TEMPLATE.tags],
      fields: { ...DEFAULT_ANKI_TEMPLATE.fields },
      fieldTemplates: null,
    };
    selectedId = template.id;
    saveTemplates(anki, [...anki.templates, template]);
    render();
    element("opt-anki-template-name").focus();
    element("opt-anki-template-name").select();
  }

  function duplicate() {
    const { anki, index, template } = selected();
    const copy = normaliseAnki({
      url: anki.url,
      apiKey: anki.apiKey,
      templates: [{ ...template, id: uniqueId(), name: uniqueName(`${template.name} copy`) }],
    }).templates[0];
    selectedId = copy.id;
    saveTemplates(anki, [...anki.templates.slice(0, index + 1), copy, ...anki.templates.slice(index + 1)]);
    render();
    element("opt-anki-template-name").focus();
    element("opt-anki-template-name").select();
  }

  function remove() {
    const { anki, index, template } = selected();
    if (anki.templates.length === 1) return;
    const references = readButtons().filter(button => button.type === "anki" && button.templateId === template.id);
    if (references.length > 0) {
      let usage = `${references.length} custom buttons`;
      if (references.length === 1) usage = `the “${references[0].label}” custom button`;
      element("anki-template-status").textContent =
        `“${template.name}” is used by ${usage}. Choose another Template for those buttons before deleting it.`;
      return;
    }
    const templates = anki.templates.filter(value => value.id !== template.id);
    selectedId = templates[Math.min(index, templates.length - 1)].id;
    saveTemplates(anki, templates);
    render();
    element("anki-template-select").focus();
  }

  function renderChoices(anki) {
    const select = element("anki-template-select");
    const key = JSON.stringify(anki.templates.map(({ id, name }) => [id, name]));
    if (renderedChoices !== key) {
      select.replaceChildren(...anki.templates.map(template => new document.defaultView.Option(template.name, template.id)));
      renderedChoices = key;
    }
    select.value = selectedId;
  }

  function renderManager() {
    const { anki, index, template } = selected();
    renderChoices(anki);
    const name = element("opt-anki-template-name");
    if (name !== document.activeElement && name.value !== template.name) name.value = template.name;
    element("anki-template-position").textContent = `${index + 1} of ${anki.templates.length}`;
    element("anki-template-role").hidden = index !== 0;
    element("anki-template-previous").disabled = index === 0;
    element("anki-template-next").disabled = index === anki.templates.length - 1;
    element("anki-template-up").disabled = index === 0;
    element("anki-template-down").disabled = index === anki.templates.length - 1;
    element("anki-template-delete").disabled = anki.templates.length === 1;
  }

  function render() {
    renderManager();
    editor.render();
  }

  element("anki-template-select").addEventListener("change", event => setSelected(event.target.value));
  element("anki-template-previous").addEventListener("click", () => {
    const { anki, index } = selected();
    if (index > 0) setSelected(anki.templates[index - 1].id, true);
  });
  element("anki-template-next").addEventListener("click", () => {
    const { anki, index } = selected();
    if (index + 1 < anki.templates.length) setSelected(anki.templates[index + 1].id, true);
  });
  element("opt-anki-template-name").addEventListener("input", () => {
    element("anki-template-status").textContent = "";
  });
  element("opt-anki-template-name").addEventListener("change", event => {
    const name = event.target.value.trim();
    if (!name || /[\u0000-\u001f\u007f]/u.test(name)) {
      element("anki-template-status").textContent = "Enter a name for the Template.";
      return;
    }
    const { anki, template } = selected();
    if (name === template.name) return;
    saveTemplates(anki, anki.templates.map(value => value.id === template.id ? { ...value, name } : value));
    render();
  });
  element("anki-template-add").addEventListener("click", add);
  element("anki-template-duplicate").addEventListener("click", duplicate);
  element("anki-template-up").addEventListener("click", () => move(-1));
  element("anki-template-down").addEventListener("click", () => move(1));
  element("anki-template-delete").addEventListener("click", remove);

  return {
    render,
    refresh: () => editor.refresh(),
    dirty: () => {
      const { template } = selected();
      return element("opt-anki-template-name").value !== template.name;
    },
  };
}
