// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiAvailability } from "./anki.js";
import { ankiSetupFamily } from "./anki-setup.js";
import { ANKI_TEMPLATE_MARKER_OPTIONS, ankiFieldNames, ankiTemplateErrors, applyAnkiPreset, resolveAnkiTemplates } from "./anki-templates.js";
import { reorderSettingsRows, setStatusOutput } from "./settings-dom.js";

function setAttributeIfChanged(element, name, value) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function intersectingMarkerSelection(value, selectionStart, selectionEnd) {
  const collapsed = selectionStart === selectionEnd;
  for (const match of value.matchAll(/\{([^{}]*)\}/gu)) {
    const start = match.index;
    const end = start + match[0].length;
    const intersects = collapsed
      ? selectionStart > start && selectionStart < end
      : selectionStart < end && selectionEnd > start;
    if (!intersects) continue;
    return {
      start: collapsed ? start : Math.min(selectionStart, start),
      end: collapsed ? end : Math.max(selectionEnd, end),
      query: match[1],
    };
  }
  return null;
}

function partialMarkerSelection(value, selectionStart, selectionEnd) {
  const before = value.slice(0, selectionStart);
  const open = before.lastIndexOf("{");
  if (open <= before.lastIndexOf("}")) return null;
  const close = value.indexOf("}", selectionEnd);
  return {
    start: open,
    end: close < 0 ? selectionEnd : close + 1,
    query: value.slice(open + 1, selectionStart),
  };
}

function markerLikeTokenQuery(token) {
  let start = token.startsWith("{") ? 1 : 0;
  let end = token.endsWith("}") ? token.length - 1 : token.length;
  if (end < start) end = start;
  const query = token.slice(start, end);
  for (const character of query) {
    if (character === "{" || character === "}" || character.trim() === "") return null;
  }
  return query;
}

function singleTokenSelection(value, selectionStart, selectionEnd) {
  const trimmedStart = value.length - value.trimStart().length;
  const trimmedEnd = value.trimEnd().length;
  if (trimmedStart >= trimmedEnd || trimmedStart > selectionStart || selectionEnd > trimmedEnd) return null;
  const token = value.slice(trimmedStart, trimmedEnd);
  const collapsed = selectionStart === selectionEnd;
  const completeMarkerBoundary = collapsed && token.startsWith("{") && token.endsWith("}")
    && (selectionStart === trimmedStart || selectionStart === trimmedEnd);
  if (completeMarkerBoundary) return null;
  const query = markerLikeTokenQuery(token);
  return query === null ? null : { start: trimmedStart, end: trimmedEnd, query };
}

function markerSelection(value, selectionStart, selectionEnd) {
  const selection = intersectingMarkerSelection(value, selectionStart, selectionEnd)
    ?? partialMarkerSelection(value, selectionStart, selectionEnd)
    ?? singleTokenSelection(value, selectionStart, selectionEnd);
  if (selection) return selection;
  return { start: selectionStart, end: selectionEnd, query: "" };
}

function createMarkerCombobox(document, id, labelText, onValue) {
  const root = document.createElement("div");
  root.className = "anki-marker-combobox";
  root.innerHTML = `<div class="anki-marker-combobox-editor">
      <textarea rows="2" spellcheck="false" autocomplete="off" autocapitalize="off"
        placeholder="Blank disables this field"
        role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false"></textarea>
      <button type="button" class="anki-marker-combobox-toggle" tabindex="-1"
        aria-haspopup="listbox" aria-expanded="false"><span aria-hidden="true">▾</span></button>
      <div class="anki-marker-listbox" role="listbox" hidden></div>
    </div>
    <span class="anki-marker-combobox-status" role="status" aria-live="polite"></span>
    <output class="anki-template-error field-hint is-error" aria-live="polite"></output>`;
  const editor = root.querySelector("textarea");
  const toggle = root.querySelector("button");
  const listbox = root.querySelector('[role="listbox"]');
  const status = root.querySelector('[role="status"]');
  const error = root.querySelector("output");
  editor.id = id;
  listbox.id = `${id}-listbox`;
  status.id = `${id}-status`;
  error.id = `${id}-error`;
  editor.setAttribute("aria-controls", listbox.id);
  editor.setAttribute("aria-describedby", `${status.id} ${error.id}`);
  toggle.setAttribute("aria-controls", listbox.id);

  const empty = document.createElement("div");
  empty.className = "anki-marker-empty";
  empty.setAttribute("role", "presentation");
  empty.setAttribute("aria-hidden", "true");
  empty.textContent = "No markers match. Keep typing to use this text as-is.";
  empty.hidden = true;
  const options = ANKI_TEMPLATE_MARKER_OPTIONS.map((marker, index) => {
    const option = document.createElement("div");
    option.id = `${id}-option-${index + 1}`;
    option.className = "anki-marker-option";
    option.dataset.marker = marker.value;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    option.setAttribute("aria-label", `${marker.value}: ${marker.description}`);
    const value = document.createElement("code");
    value.textContent = marker.value;
    const description = document.createElement("span");
    description.textContent = marker.description;
    option.append(value, description);
    option.addEventListener("pointerenter", () => {
      if (!option.hidden) setActive(index);
    });
    option.addEventListener("pointerdown", event => event.preventDefault());
    option.addEventListener("click", () => select(index));
    listbox.append(option);
    return {
      ...marker,
      element: option,
      search: `${marker.marker} ${marker.value}`.toLocaleLowerCase(),
    };
  });
  listbox.append(empty);

  let open = false;
  let showAll = false;
  let active = -1;
  let composing = false;
  let committedValue = "";

  function updateLabel(value) {
    setAttributeIfChanged(toggle, "aria-label", `${open ? "Hide" : "Show"} marker suggestions for ${value}`);
    setAttributeIfChanged(listbox, "aria-label", `Marker suggestions for ${value}`);
  }

  function setActive(index) {
    active = index;
    for (const [optionIndex, option] of options.entries()) {
      option.element.setAttribute("aria-selected", `${open && optionIndex === active}`);
    }
    if (open && active >= 0) {
      editor.setAttribute("aria-activedescendant", options[active].element.id);
      options[active].element.scrollIntoView?.({ block: "nearest" });
    } else {
      editor.removeAttribute("aria-activedescendant");
    }
  }

  function visibleOptions() {
    return options.map((option, index) => option.element.hidden ? -1 : index).filter(index => index >= 0);
  }

  function refreshOptions() {
    const selection = markerSelection(editor.value, editor.selectionStart, editor.selectionEnd);
    const query = showAll ? "" : selection.query.toLocaleLowerCase();
    for (const option of options) option.element.hidden = query !== "" && !option.search.includes(query);
    const visible = visibleOptions();
    empty.hidden = visible.length !== 0;
    if (!visible.includes(active)) {
      const exact = visible.find(index => options[index].value === editor.value);
      setActive(exact ?? visible[0] ?? -1);
    } else {
      setActive(active);
    }
    if (visible.length === 0) {
      status.textContent = query
        ? `No marker suggestions match ${selection.query}. Keep typing to use this text as-is.`
        : "No marker suggestions are available.";
    } else {
      status.textContent = `${visible.length} marker suggestion${visible.length === 1 ? "" : "s"} available. Use Arrow keys and Enter to select.`;
    }
  }

  function setOpen(value, all = false) {
    open = value;
    showAll = value && all;
    editor.setAttribute("aria-expanded", `${open}`);
    toggle.setAttribute("aria-expanded", `${open}`);
    listbox.hidden = !open;
    updateLabel(labelText);
    if (open) refreshOptions();
    else {
      status.textContent = "";
      setActive(-1);
    }
  }

  function commit() {
    if (editor.value === committedValue) return;
    onValue(editor.value);
  }

  function select(index) {
    if (index < 0 || options[index].element.hidden) return;
    const selection = markerSelection(editor.value, editor.selectionStart, editor.selectionEnd);
    const value = options[index].value;
    editor.value = `${editor.value.slice(0, selection.start)}${value}${editor.value.slice(selection.end)}`;
    const caret = selection.start + value.length;
    editor.setSelectionRange(caret, caret);
    commit();
    setOpen(false);
    editor.focus({ preventScroll: true });
  }

  function moveActive(offset) {
    const visible = visibleOptions();
    if (visible.length === 0) return;
    const position = visible.indexOf(active);
    let next = 0;
    if (position >= 0) next = (position + offset + visible.length) % visible.length;
    else if (offset < 0) next = visible.length - 1;
    setActive(visible[next]);
  }

  function moveActiveToEdge(last) {
    const visible = visibleOptions();
    setActive(last ? visible.at(-1) ?? -1 : visible[0] ?? -1);
  }

  function handleOpenKey(event) {
    if (!open) return false;
    if (event.key === "Tab") {
      setOpen(false);
      return false;
    }
    switch (event.key) {
      case "Home":
        moveActiveToEdge(false);
        return true;
      case "End":
        moveActiveToEdge(true);
        return true;
      case "Enter":
        if (event.shiftKey || active < 0) return false;
        select(active);
        return true;
      case "Escape":
        setOpen(false);
        return true;
      default:
        return false;
    }
  }

  function handleKeydown(event) {
    if (composing || event.isComposing) return;
    let handled = false;
    if (event.altKey && event.key === "ArrowUp" && open) {
      setOpen(false);
      handled = true;
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!open) setOpen(true, true);
      else moveActive(event.key === "ArrowDown" ? 1 : -1);
      handled = true;
    } else {
      handled = handleOpenKey(event);
    }
    if (handled) event.preventDefault();
  }

  editor.addEventListener("input", event => {
    showAll = false;
    if (!composing && !event.isComposing) commit();
    if (!open) setOpen(true);
    else refreshOptions();
  });
  editor.addEventListener("compositionstart", () => { composing = true; });
  editor.addEventListener("compositionend", () => {
    composing = false;
    commit();
    if (!open) setOpen(true);
    else refreshOptions();
  });
  editor.addEventListener("keydown", handleKeydown);
  toggle.addEventListener("pointerdown", event => event.preventDefault());
  toggle.addEventListener("click", () => {
    const wasOpen = open;
    editor.focus({ preventScroll: true });
    setOpen(!wasOpen, true);
  });
  root.addEventListener("focusout", () => {
    document.defaultView.queueMicrotask(() => {
      if (root.contains(document.activeElement)) return;
      if (composing) {
        composing = false;
        commit();
      }
      setOpen(false);
    });
  });

  updateLabel(labelText);
  return {
    root,
    editor,
    error,
    close: () => setOpen(false),
    update({ value, label, errors }) {
      labelText = label;
      committedValue = value;
      updateLabel(label);
      if (editor !== document.activeElement && editor.value !== value) editor.value = value;
      const message = errors.join("\n");
      if (error.textContent !== message) error.textContent = message;
      setAttributeIfChanged(editor, "aria-invalid", `${errors.length > 0}`);
      if (open) refreshOptions();
    },
  };
}

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
  let apiKeyPanelInitialized = false;
  let findingSetup = false;
  let setupRequestSequence = 0;
  let setupSnapshot = null;
  let ownerKey = String(readOwnerKey() ?? "");
  const templateRows = new Map();
  let nextTemplateId = 0;
  const connectionKey = config => JSON.stringify([config.model, config.apiKey, config.url]);

  function setApiKeyExpanded(expanded) {
    setAttributeIfChanged(element("anki-api-key-toggle"), "aria-expanded", `${expanded}`);
    if (element("anki-api-key-panel").hidden !== !expanded) element("anki-api-key-panel").hidden = !expanded;
  }

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

  function templatePresentation(config = readConfig()) {
    const fields = currentFields();
    const resolved = resolveAnkiTemplates(config, fields);
    if (config.fieldTemplates !== null) {
      return {
        resolved,
        entries: [...Object.entries(resolved.templates),
          ...resolved.staleFields.map(field => [field, config.fieldTemplates[field]])],
        unavailable: new Set(resolved.staleFields),
      };
    }
    const names = [...fields];
    const folded = new Set(names.map(field => field.toLowerCase()));
    for (const semantic of ANKI_FIELDS) {
      const field = config.fields[semantic];
      if (field && !folded.has(field.toLowerCase())) {
        names.push(field);
        folded.add(field.toLowerCase());
      }
    }
    const display = resolveAnkiTemplates(config, names);
    const available = ankiFieldNames(fields);
    return {
      resolved,
      entries: Object.entries(display.templates),
      unavailable: new Set(names.filter(field => !available.has(field.toLowerCase()))),
    };
  }

  function materializeTemplates() {
    return Object.fromEntries(templatePresentation().entries.map(([field, template]) => [field, { ...template }]));
  }

  function editTemplate(field, patch) {
    const templates = materializeTemplates();
    templates[field] = { ...templates[field], ...patch };
    change({ fieldTemplates: templates });
  }

  function createTemplateRow(field) {
    const row = document.createElement("div");
    row.className = "anki-template-row";
    row.innerHTML = `<div class="anki-template-heading"><span class="anki-field-index" aria-hidden="true"></span><label class="field-label"></label><button type="button" class="ghost">Remove unavailable field</button></div>
      <label class="anki-template-mode"><span>On overwrite</span><select></select></label>`;
    const label = row.querySelector(".field-label"), mode = row.querySelector("select");
    const indexBadge = row.querySelector(".anki-field-index");
    const id = `opt-anki-template-${++nextTemplateId}`;
    let record;
    const combobox = createMarkerCombobox(document, id, field, value => editTemplate(record.field, { value }));
    const editor = combobox.editor;
    row.querySelector(".anki-template-mode").before(combobox.root);
    label.htmlFor = editor.id;
    label.id = `${editor.id}-label`;
    label.textContent = field;
    mode.id = `${editor.id}-mode`;
    mode.setAttribute("aria-label", `On overwrite: ${field}`);
    const names = { coalesce: "Keep existing, fill empty", "coalesce-new": "Use new, keep if empty", skip: "Keep existing",
      append: "Append", prepend: "Prepend", overwrite: "Replace" };
    for (const value of ANKI_OVERWRITE_MODES) mode.add(new document.defaultView.Option(names[value], value));
    const remove = row.querySelector("button");
    remove.setAttribute("aria-label", `Remove unavailable field: ${field}`);
    record = { field, row, label, editor, combobox, mode, remove, indexBadge, modeLabel: mode.parentElement };
    mode.addEventListener("change", () => editTemplate(record.field, { overwriteMode: mode.value }));
    remove.addEventListener("click", () => {
      const templates = materializeTemplates();
      delete templates[record.field];
      change({ fieldTemplates: templates });
      element("anki-apply-preset").focus();
    });
    return record;
  }

  function updateTemplateRow(row, template, showMode, unavailable, index) {
    const errors = ankiTemplateErrors(template.value);
    row.combobox.update({ value: template.value, label: row.field, errors });
    if (row.mode !== document.activeElement && row.mode.value !== template.overwriteMode) row.mode.value = template.overwriteMode;
    if (row.modeLabel.hidden === showMode) row.modeLabel.hidden = !showMode;
    if (row.remove.hidden === unavailable) row.remove.hidden = !unavailable;
    if (row.row.dataset.ankiField !== row.field) row.row.dataset.ankiField = row.field;
    const displayIndex = String(index + 1).padStart(2, "0");
    if (row.indexBadge.textContent !== displayIndex) row.indexBadge.textContent = displayIndex;
    const unmapped = template.value.trim() === "";
    if (row.row.classList.contains("is-unmapped") !== unmapped) row.row.classList.toggle("is-unmapped", unmapped);
  }

  function renderTemplates(config, presentation) {
    const templates = presentation.entries;
    const retained = new Set(templates.map(([field]) => field));
    const showMode = config.duplicateBehavior === "overwrite";
    const renamedRows = new Map([...templateRows].filter(([field]) => !retained.has(field))
      .map(([field, row]) => [field.toLowerCase(), row]));
    const container = element("anki-templates");
    for (const [index, [field, template]] of templates.entries()) {
      if (!templateRows.has(field)) {
        const previous = renamedRows.get(field.toLowerCase());
        if (previous) adoptRenamedRow(previous, field, renamedRows);
        templateRows.set(field, previous || createTemplateRow(field));
      }
      updateTemplateRow(templateRows.get(field), template, showMode, presentation.unavailable.has(field), index);
    }
    for (const [field, row] of templateRows) {
      if (!retained.has(field)) { row.row.remove(); templateRows.delete(field); }
    }
    reorderSettingsRows(container, templates.map(([field]) => templateRows.get(field).row));
    filterTemplateRows(templates.map(([field]) => field));
    const canApply = !loading && currentFields().length > 0;
    if (element("anki-apply-preset").disabled === canApply) element("anki-apply-preset").disabled = !canApply;
  }

  function adoptRenamedRow(previous, field, renamedRows) {
    templateRows.delete(previous.field);
    renamedRows.delete(field.toLowerCase());
    previous.field = field;
    previous.label.textContent = field;
    previous.mode.setAttribute("aria-label", `On overwrite: ${field}`);
    previous.remove.setAttribute("aria-label", `Remove unavailable field: ${field}`);
  }

  // Rows are hidden, never dropped, so the mapping keeps Anki's field order.
  function filterTemplateRows(fields) {
    const query = element("anki-field-filter").value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const field of fields) {
      const row = templateRows.get(field).row;
      const hidden = query !== "" && !field.toLocaleLowerCase().includes(query);
      if (row.hidden !== hidden) row.hidden = hidden;
      if (!hidden) visible += 1;
    }
    const count = query === "" ? `Showing ${fields.length} fields` : `Showing ${visible} of ${fields.length} fields`;
    if (element("anki-field-count").textContent !== count) element("anki-field-count").textContent = count;
  }

  function optionGroup(label, choices, optionLabel) {
    const group = document.createElement("optgroup");
    group.label = label;
    group.append(...choices.map(name => new document.defaultView.Option(optionLabel(name), name)));
    return group;
  }

  // A saved value that discovery no longer lists stays selectable as "(unavailable)".
  function selectChoices(id, names, value, placeholder, { suggested = "", allLabel, labels = {} }) {
    const select = element(id);
    if (select === document.activeElement) return;
    const key = JSON.stringify([names, value, suggested, allLabel, labels]);
    if (selects.get(select) === key) return;
    const optionLabel = name => {
      if (Object.hasOwn(labels, name)) return labels[name];
      return names.includes(name) ? name : `${name} (unavailable)`;
    };
    const groups = [];
    if (suggested) groups.push(optionGroup("Suggested", [suggested], name => `Suggested: ${optionLabel(name)}`));
    const rest = names.filter(name => name !== suggested);
    if (value && !names.includes(value) && value !== suggested) rest.push(value);
    groups.push(optionGroup(allLabel, rest, optionLabel));
    select.replaceChildren(new document.defaultView.Option(placeholder, ""), ...groups);
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
    const connected = currentDiscovery?.connected === true;
    let state = "Not connected";
    if (connected) state = errors.length ? "Connected · configuration needs attention" : "Connected · configuration ready";
    const message = loading ? "Checking AnkiConnect…" : [state, ...errors].join("\n");
    let tone;
    let connection = "offline";
    if (loading) {
      tone = "working";
      connection = "checking";
    } else if (connected) {
      tone = errors.length ? "error" : "ready";
      connection = "connected";
    } else if (errors.length) {
      tone = "error";
    }
    setAttributeIfChanged(status, "data-state", connection);
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
    for (const row of templateRows.values()) row.combobox.close();
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
    if (!apiKeyPanelInitialized) {
      apiKeyPanelInitialized = true;
      setApiKeyExpanded(config.apiKey !== "");
    }
    if (!findingSetup && setupSnapshot !== null && setupSnapshot !== JSON.stringify(config)) {
      setupSnapshot = null;
      setupStatus("");
    }
    if (pendingPreset && (pendingPreset.key !== connectionKey(config) || pendingPreset.owner !== ownerKey)) pendingPreset = null;
    if (presetModel !== config.model) {
      presetModel = config.model;
      element("anki-preset").value = ankiSetupFamily(config.model) || "automatic";
    }
    const models = discovery?.models || [];
    const suggestedModel = ankiSetupFamily(config.model)
      ? config.model
      : models.find(model => ankiSetupFamily(model)) || "";
    const modelLabels = {};
    if (discoveryKey === connectionKey(config) && discovery?.connected && discovery.model === config.model
        && models.includes(config.model)) {
      modelLabels[config.model] = `${config.model} (${discovery.fields.length} fields)`;
    }
    selectChoices("opt-anki-deck", discovery?.decks || [], config.deck, "Choose a deck", {
      suggested: config.deck,
      allLabel: "All decks",
    });
    selectChoices("opt-anki-model", models, config.model, "Choose a note type", {
      suggested: suggestedModel,
      allLabel: "All note types",
      labels: modelLabels,
    });
    renderDuplicateScope(config);
    const url = element("opt-anki-url");
    if (url !== document.activeElement && !url.validity.customError && url.value !== config.url) url.value = config.url;
    renderFormControls(config);
    const presentation = templatePresentation(config);
    renderStatus(config, presentation.resolved);
    renderTemplates(config, presentation);
    if (connectionKey(config) !== requestedKey) void refresh();
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
  element("anki-api-key-toggle").addEventListener("click", event => {
    setApiKeyExpanded(event.currentTarget.getAttribute("aria-expanded") !== "true");
  });
  element("anki-refresh").addEventListener("click", () => {
    // A changed URL starts discovery through render; don't start it twice.
    if (commitConnectionUrl() === false) void refresh();
  });
  element("anki-find-setup").addEventListener("click", () => { void findSetup(); });
  element("anki-preset").addEventListener("change", () => { pendingPreset = null; });
  element("anki-field-filter").addEventListener("input", () => {
    const config = readConfig();
    renderTemplates(config, templatePresentation(config));
  });
  element("anki-apply-preset").addEventListener("click", () => {
    pendingPreset = null;
    editConfig(applyAnkiPreset(readConfig(), currentFields(), element("anki-preset").value));
    render();
  });
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

  function reorder(anki, index, destination) {
    if (destination < 0 || destination >= anki.templates.length || destination === index) return false;
    const templates = anki.templates.slice();
    const [template] = templates.splice(index, 1);
    templates.splice(destination, 0, template);
    saveTemplates(anki, templates);
    render();
    return true;
  }

  function move(offset) {
    const { anki, index } = selected();
    if (!reorder(anki, index, index + offset)) return;
    const preferred = element(offset < 0 ? "anki-template-up" : "anki-template-down");
    let focusTarget = preferred;
    if (preferred.disabled) {
      focusTarget = element(offset < 0 ? "anki-template-down" : "anki-template-up");
    }
    focusTarget.focus();
  }

  function setBuiltin() {
    const { anki, index } = selected();
    reorder(anki, index, 0);
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

  function handleTemplateSelection(event) {
    setSelected(event.currentTarget.value);
  }

  function renderChoices(anki) {
    const select = element("anki-template-select");
    const pills = element("anki-template-pills");
    const key = JSON.stringify(anki.templates.map(({ id, name }) => [id, name]));
    if (renderedChoices !== key) {
      select.replaceChildren(...anki.templates.map(template => new document.defaultView.Option(template.name, template.id)));
      pills.replaceChildren(...anki.templates.map((template, index) => {
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "anki-template-pill";
        pill.value = template.id;
        pill.append(template.name);
        if (index === 0) {
          const badge = document.createElement("span");
          badge.className = "anki-template-pill-badge";
          badge.textContent = "Built-in";
          pill.append(badge);
        }
        pill.addEventListener("click", handleTemplateSelection);
        return pill;
      }));
      renderedChoices = key;
    }
    select.value = selectedId;
    for (const pill of pills.children) pill.setAttribute("aria-pressed", `${pill.value === selectedId}`);
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
    element("anki-template-set-builtin").disabled = index === 0;
    element("anki-template-delete").disabled = anki.templates.length === 1;
  }

  function render() {
    renderManager();
    editor.render();
  }

  element("anki-template-select").addEventListener("change", handleTemplateSelection);
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
  element("anki-template-set-builtin").addEventListener("click", setBuiltin);
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
