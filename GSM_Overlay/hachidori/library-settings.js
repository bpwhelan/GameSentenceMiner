// SPDX-License-Identifier: GPL-3.0-or-later

// Settings → Dictionaries → Dictionaries: the installed packages as this page holds
// them, their rows, order, selection and bulk actions, the revision-checked
// commit queue behind every Library and group edit, removal and Remove all.

import { describeErrorOrJson } from "./error-text.js";
import { renameWithBaseline } from "./dictionary-name-drafts.js";
import { normaliseDictionaryGroups } from "./dictionary-groups.js";
import {
  CUSTOM_DICTIONARY_ID,
  normaliseCustomDictionaryDocument,
  parseCustomDictionary,
} from "./custom-dictionary.js";
import {
  backingUp, dictionaryGroupController, element, memorySettings, nameDrafts, numberFormat,
  refreshMemorySettings, refreshStatus, renderEngineStatus, scheduleStatusPoll, send, setSectionStatus,
  setStatus, sharingLinkedAddress, TARGET, WORKER_TARGET,
} from "./settings.js";
import {
  importing, installingRecommended, renderRecommendedActions, setImportDragDepth,
} from "./import-settings.js";
import {
  bindDictionaryUpdate, isUpdateCheckable, renderUpdateControls, updateAvailabilityRecorded, updating,
} from "./update-settings.js";
import {
  adoptCustomDictionaryDocument, adoptCustomDictionaryState, customSaving, renderCustomDictionaryControls,
} from "./custom-dictionary-settings.js";
import { normaliseKanjiClickOption, renderOptions } from "./option-settings.js";

let dictionaryState = { schemaVersion: 1, revision: -1, dictionaries: [], groups: [] }; // NOSONAR: shared with the other Settings modules
let dictionaries = dictionaryState.dictionaries; // NOSONAR: shared with the other Settings modules
let removing = false; // NOSONAR: shared with the other Settings modules
let committing = false; // NOSONAR: shared with the other Settings modules
let pendingDictionaryCommits = 0; // NOSONAR: shared with the other Settings modules
let pendingDictionaryReorders = 0;
let pendingDictionaryOrder = null;
let dictionaryReorderEpoch = 0;
let dictionaryCommitTail = Promise.resolve();
let dictionaryCommitFailed = false;
let dictionaryRenderDeferred = false;
// A pending reorder can reuse the existing rows: only their order and the
// index-dependent controls change, not the package set or per-package metadata.
// Any other queued change clears this so a coalesced render rebuilds instead.
let reorderReuseHint = false;
let pendingManagementFocus = null;
let managementPointerDown = false;
let dictionarySearch = "";
const selectedDictionaryIds = new Set();
const expandedDictionaryIds = new Set();
let draggedDictionaryId = null;

function nonnegativeCount(value) {
  const count = Math.trunc(Number(value));
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function stringValue(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function nonemptyString(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function displayName(value) {
  const name = stringValue(value).trim();
  return name === "" ? null : name;
}

function normaliseDictionary(row) {
  const title = stringValue(row?.title);
  if (title === "") {
    return null;
  }
  const sourceId = nonemptyString(row?.sourceId);
  return {
    ...(row && typeof row === "object" && !Array.isArray(row) ? row : {}),
    id: stringValue(row?.id),
    title,
    displayName: displayName(row?.displayName),
    path: nonemptyString(row?.path) ?? `/dicts/${title}`,
    enabled: row?.enabled !== false,
    favorite: row?.favorite === true,
    revision: stringValue(row?.revision),
    isUpdatable: row?.isUpdatable === true,
    indexUrl: nonemptyString(row?.indexUrl),
    downloadUrl: nonemptyString(row?.downloadUrl),
    language: nonemptyString(row?.language),
    frequencyMode: nonemptyString(row?.frequencyMode),
    termCount: nonnegativeCount(row?.termCount),
    frequencyCount: nonnegativeCount(row?.frequencyCount),
    pitchCount: nonnegativeCount(row?.pitchCount),
    kanjiCount: nonnegativeCount(row?.kanjiCount),
    mediaCount: nonnegativeCount(row?.mediaCount),
    installedAt: stringValue(row?.installedAt),
    lastUpdateCheck: row?.lastUpdateCheck ?? null,
    ...(row?.updateScheduleOverride === undefined ? {} : { updateScheduleOverride: row.updateScheduleOverride }),
    ...(sourceId === null ? {} : { sourceId }),
  };
}

function normaliseDictionaries(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normaliseDictionary).filter((entry) => entry !== null);
}

function normaliseDictionaryState(value) {
  if (value?.schemaVersion !== 1) {
    throw new Error(`Unsupported dictionary state schema ${String(value?.schemaVersion)}`);
  }
  const revision = Number.isInteger(value?.revision) && value.revision >= 0 ? value.revision : 0;
  const dictionaries = normaliseDictionaries(value?.dictionaries);
  return {
    schemaVersion: 1,
    revision,
    dictionaries,
    groups: normaliseDictionaryGroups(value?.groups, dictionaries),
  };
}

// A key-order-independent serialization for comparing two normalised package
// records: the stored state and the page produce the same values in a
// different key sequence, so JSON.stringify order cannot decide equality.
function canonicalDictionary(entry) {
  return JSON.stringify(entry, Object.keys(entry).sort((a, b) => a.localeCompare(b)));
}

function adoptDictionaryState(value) {
  const next = normaliseDictionaryState(value);
  if (next.revision <= dictionaryState.revision) {
    return false;
  }
  if (reorderReuseHint) {
    // Only the order may differ for a reuse: compare each package's fields
    // independent of key order, since the stored state and the page normalise
    // the same values in a different key sequence.
    const previous = new Map(dictionaries.map(entry => [entry.id, canonicalDictionary(entry)]));
    reorderReuseHint = next.dictionaries.length === previous.size
      && next.dictionaries.every(entry => previous.get(entry.id) === canonicalDictionary(entry));
  }
  dictionaryState = next;
  // Keep the newest local order visible across storage events and older
  // acknowledgements. The final settlement adopts the authoritative snapshot.
  if (pendingDictionaryReorders === 0) dictionaries = dictionaryState.dictionaries;
  pruneDictionarySelection();
  return true;
}

function pruneDictionarySelection() {
  const installedIds = new Set(dictionaryState.dictionaries.map((dictionary) => dictionary.id));
  for (const id of selectedDictionaryIds) {
    if (!installedIds.has(id)) {
      selectedDictionaryIds.delete(id);
    }
  }
}

function normaliseDictionarySearch(value) {
  return stringValue(value).normalize("NFKC").trim().toLowerCase();
}

function visibleDictionaries() {
  const search = normaliseDictionarySearch(dictionarySearch);
  if (search === "") {
    return dictionaries;
  }
  return dictionaries.filter((dictionary) =>
    [dictionary.title, dictionary.displayName].some((name) =>
      normaliseDictionarySearch(name).includes(search)));
}

function dictionaryLabel(dictionary) {
  return dictionary.displayName || dictionary.title;
}

function isManagedCustomDictionary(dictionary) {
  return dictionary?.id === CUSTOM_DICTIONARY_ID;
}

function setControlsDisabled(disabled) {
  const blocked = disabled || installingRecommended || removing || updating || customSaving || backingUp;
  const importBlocked = blocked || committing;
  element("import-file").disabled = importBlocked;
  element("import-drop-zone").setAttribute("aria-disabled", String(importBlocked));
  if (importBlocked) {
    setImportDragDepth(0);
    element("import-drop-zone").classList.remove("is-dragging");
  }
  element("install-recommended").disabled = blocked || committing;
  element("retry-recommended").disabled = blocked || committing;
  element("empty-install-recommended").disabled = blocked || committing;
  element("empty-import-dictionaries").disabled = blocked || committing;
  for (const control of document.querySelectorAll(".dict-row select, .dict-row input, .dict-row button")) {
    control.disabled = blocked || control.dataset.pinnedDisabled === "true"
      || (committing && control.classList.contains("dict-update-schedule"));
  }
  for (const drag of document.querySelectorAll(".dict-drag")) {
    drag.draggable = !blocked && drag.dataset.pinnedDisabled !== "true";
  }
  for (const control of document.querySelectorAll(
    "#dict-group-create-form input, #dict-group-create-form button, #dict-group-list input, #dict-group-list select, #dict-group-list button",
  )) {
    control.disabled = blocked || control.dataset.pinnedDisabled === "true";
  }
  element("dict-select-visible").disabled = blocked || visibleDictionaries().length === 0;
  for (const control of element("dict-controls").querySelectorAll(".dict-bulk-actions button")) {
    control.disabled = blocked || selectedDictionaryIds.size === 0;
  }
  element("dict-bulk-remove").disabled = blocked || !selectedRemovableDictionaries().length;
  renderLibraryReset(blocked || committing);
  renderUpdateControls();
  renderCustomDictionaryControls();
}

// Remove all needs something to remove: an ordinary package, or the explicit
// personal-source choice.
function renderLibraryReset(blocked) {
  const resetBlocked = blocked || sharingLinkedAddress !== null;
  const erasePersonal = element("library-reset-personal");
  erasePersonal.disabled = resetBlocked;
  element("library-remove-all").disabled = resetBlocked
    || (!erasePersonal.checked && !dictionaries.some(entry => !isManagedCustomDictionary(entry)));
}

function addCountBadge(container, label, count) {
  const badge = document.createElement("span");
  badge.className = "dict-badge";
  badge.dataset.capability = label.toLowerCase();
  badge.classList.toggle("is-empty", count === 0);
  badge.textContent = `${label} ${numberFormat.format(count)}`;
  container.appendChild(badge);
}

function dictionaryMetadata(entry) {
  const details = [];
  if (entry.revision) {
    details.push(`Revision ${entry.revision}`);
  }
  if (entry.language) {
    details.push(entry.language);
  }
  if (entry.installedAt) {
    const installed = new Date(entry.installedAt);
    if (!Number.isNaN(installed.getTime())) {
      details.push(`Imported ${installed.toLocaleString()}`);
    }
  }
  details.push(`Package ID ${entry.id}`, isUpdateCheckable(entry) ? "Update source available" : "Local archive");
  return details.join(" · ");
}

function updateItemById(current, id, update) {
  const index = current.findIndex((entry) => entry.id === id);
  if (index < 0) {
    return null;
  }
  const replacement = update(current[index]);
  if (replacement === current[index]) {
    return null;
  }
  const next = [...current];
  next[index] = replacement;
  return next;
}

function updateDictionary(id, update) {
  return (current) => updateItemById(current, id, update);
}

function moveListItem(values, index, target) {
  if (index < 0 || target < 0 || target >= values.length || index === target) {
    return null;
  }
  const next = [...values];
  const [entry] = next.splice(index, 1);
  next.splice(target, 0, entry);
  return next;
}

function updateSelectedDictionaries(field, value, reloadEngine) {
  const ids = new Set(selectedDictionaryIds);
  void commitDictionaries((current) => {
    let changed = false;
    const next = current.map((dictionary) => {
      if ((field === "enabled" && isManagedCustomDictionary(dictionary))
          || !ids.has(dictionary.id)
          || dictionary[field] === value) {
        return dictionary;
      }
      changed = true;
      return { ...dictionary, [field]: value };
    });
    return changed ? next : null;
  }, reloadEngine);
}

function focusedManagementControl() {
  const active = document.activeElement;
  const dictionaryRow = active?.closest?.(".dict-row");
  if (dictionaryRow?.dataset.dictionaryId) {
    const controlClass = [
      "dict-selected",
      "dict-details-toggle",
      "dict-display-name",
      "dict-enabled",
      "dict-up",
      "dict-down",
      "dict-position-input",
      "dict-move",
      "dict-update-check",
      "dict-update",
      "dict-update-schedule",
      "dict-remove",
    ].find((name) => active.classList.contains(name));
    return controlClass
      ? { kind: "dictionary", id: dictionaryRow.dataset.dictionaryId, controlClass }
      : null;
  }

  const groupRow = active?.closest?.(".dict-group");
  if (!groupRow?.dataset.groupId) return null;
  const memberRow = active.closest(".dict-group-member");
  const controlClasses = memberRow
    ? ["dict-group-member-up", "dict-group-member-down", "dict-group-member-remove"]
    : ["dict-group-name", "dict-group-up", "dict-group-down", "dict-group-delete", "dict-group-add-select", "dict-group-add"];
  const controlClass = controlClasses.find((name) => active.classList.contains(name));
  if (!controlClass) return null;

  const groupRows = [...groupRow.parentElement.children];
  const focus = {
    kind: memberRow ? "group-member" : "group",
    groupId: groupRow.dataset.groupId,
    groupIndex: groupRows.indexOf(groupRow),
    controlClass,
  };
  if (memberRow) {
    focus.dictionaryId = memberRow.dataset.dictionaryId;
    focus.memberIndex = [...memberRow.parentElement.children].indexOf(memberRow);
  }
  return focus;
}

function renderDictionarySelection(visible) {
  const visibleSelected = visible.filter((dictionary) => selectedDictionaryIds.has(dictionary.id)).length;
  const selectVisible = element("dict-select-visible");
  selectVisible.checked = visible.length > 0 && visibleSelected === visible.length;
  selectVisible.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
  element("dict-selection-count").textContent = `${selectedDictionaryIds.size} selected`;
  element("dict-bulk-actions").hidden = selectedDictionaryIds.size === 0;
  element("dict-match-count").textContent = `${visible.length} of ${dictionaries.length}`;
}

function clearDictionaryDropTargets() {
  for (const row of document.querySelectorAll("#dict-list .is-drop-target")) {
    row.classList.remove("is-drop-target");
  }
}

function bindDictionarySelection(row, entry) {
  const selected = row.querySelector(".dict-selected");
  selected.checked = selectedDictionaryIds.has(entry.id);
  selected.setAttribute("aria-label", `Select ${dictionaryLabel(entry)}`);
  selected.addEventListener("change", () => {
    if (selected.checked) {
      selectedDictionaryIds.add(entry.id);
    } else {
      selectedDictionaryIds.delete(entry.id);
    }
    renderDictionarySelection(visibleDictionaries());
    setControlsDisabled(importing);
  });
}

function bindDictionaryDrag(row, entry) {
  const drag = row.querySelector(".dict-drag");
  drag.title = `Drag ${dictionaryLabel(entry)} to reorder`;
  if (isManagedCustomDictionary(entry)) {
    drag.dataset.pinnedDisabled = "true";
    drag.draggable = false;
    return;
  }
  drag.addEventListener("dragstart", (event) => {
    draggedDictionaryId = entry.id;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", entry.id);
    }
  });
  drag.addEventListener("dragend", () => {
    draggedDictionaryId = null;
    clearDictionaryDropTargets();
  });
  row.addEventListener("dragover", (event) => {
    if (draggedDictionaryId && draggedDictionaryId !== entry.id) {
      event.preventDefault();
      clearDictionaryDropTargets();
      row.classList.add("is-drop-target");
    }
  });
  row.addEventListener("dragleave", () => {
    row.classList.remove("is-drop-target");
  });
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    clearDictionaryDropTargets();
    if (draggedDictionaryId && draggedDictionaryId !== entry.id) {
      moveDictionary(draggedDictionaryId, { targetId: entry.id });
    }
    draggedDictionaryId = null;
  });
}

function renderDeferredAfterBlur(control) {
  control.addEventListener("blur", () => {
    if (!dictionaryRenderDeferred) {
      return;
    }
    setTimeout(() => {
      if (dictionaryRenderDeferred) renderChangedDictionaryState();
    }, 0);
  });
}

function bindDictionaryAlias(row, entry) {
  const input = row.querySelector(".dict-display-name");
  input.placeholder = entry.title;
  input.setAttribute("aria-label", `Display name for ${entry.title}`);
  input.title = `Display name for ${entry.title}`;
  bindNameDraft(input, "dictionaries", entry.id, "displayName", entry.displayName ?? "", value => value.trim());
  renderDeferredAfterBlur(input);
}

function bindDictionaryEnabled(row, entry) {
  const enabled = row.querySelector(".dict-enabled");
  enabled.checked = entry.enabled;
  enabled.setAttribute(
    "aria-label",
    isManagedCustomDictionary(entry)
      ? `Enabled for ${entry.title} (managed; always enabled)`
      : `Enabled for ${entry.title}`,
  );
  enabled.title = `Enabled for ${entry.title}`;
  if (isManagedCustomDictionary(entry)) {
    enabled.checked = true;
    enabled.dataset.pinnedDisabled = "true";
    enabled.disabled = true;
    return;
  }
  enabled.addEventListener("change", () => {
    const value = enabled.checked;
    void commitDictionaries(updateDictionary(entry.id, (dictionary) =>
      dictionary.enabled === value ? dictionary : { ...dictionary, enabled: value }), true);
  });
}

// The rank badge, up/down enablement, and position input all depend on where a
// package sits in the list, so a reorder must refresh them. Everything here is
// idempotent value-setting with no listeners, so it is also what a reused row
// needs after a reorder instead of a full rebuild.
function refreshDictionaryOrder(row, entry, index) {
  const fixed = isManagedCustomDictionary(entry);
  const minimumIndex = isManagedCustomDictionary(dictionaries[0]) ? 1 : 0;
  row.querySelector(".dict-rank").textContent = String(index + 1);
  const up = row.querySelector(".dict-up");
  const down = row.querySelector(".dict-down");
  up.title = `Move ${entry.title} up`;
  down.title = `Move ${entry.title} down`;
  up.dataset.pinnedDisabled = String(fixed || index <= minimumIndex);
  down.dataset.pinnedDisabled = String(fixed || index === dictionaries.length - 1);
  up.disabled = up.dataset.pinnedDisabled === "true";
  down.disabled = down.dataset.pinnedDisabled === "true";

  const position = row.querySelector(".dict-position-input");
  const move = row.querySelector(".dict-move");
  position.value = String(index + 1);
  position.min = String(minimumIndex + 1);
  position.max = String(dictionaries.length);
  position.dataset.pinnedDisabled = String(fixed);
  move.dataset.pinnedDisabled = String(fixed);
  move.title = `Move ${dictionaryLabel(entry)} to position`;
  if (fixed) {
    up.setAttribute("aria-label", `Move ${entry.title} up (managed; fixed first)`);
    down.setAttribute("aria-label", `Move ${entry.title} down (managed; fixed first)`);
    position.setAttribute("aria-label", `Position for ${dictionaryLabel(entry)} (managed; fixed first)`);
    move.setAttribute("aria-label", `Move ${dictionaryLabel(entry)} (managed; fixed first)`);
  } else {
    up.setAttribute("aria-label", `Move ${entry.title} up`);
    down.setAttribute("aria-label", `Move ${entry.title} down`);
    position.setAttribute("aria-label", `Position for ${dictionaryLabel(entry)}`);
    move.setAttribute("aria-label", `Move ${dictionaryLabel(entry)} to position`);
  }
}

function bindDictionaryOrder(row, entry, index) {
  refreshDictionaryOrder(row, entry, index);
  const up = row.querySelector(".dict-up");
  const down = row.querySelector(".dict-down");
  up.addEventListener("click", () => {
    moveDictionary(entry.id, { step: -1 });
  });
  down.addEventListener("click", () => {
    moveDictionary(entry.id, { step: 1 });
  });

  const position = row.querySelector(".dict-position-input");
  const move = row.querySelector(".dict-move");
  // Read the live index and bounds so a reused row keeps working after the
  // package moves; only the entry id is stable across reorders. An
  // out-of-range integer clamps to the nearest movable slot: with the managed
  // dictionary pinned first, typing 1 means "as high as possible", so it lands
  // on position 2 instead of being silently discarded.
  const moveToPosition = () => {
    if (isManagedCustomDictionary(entry)) return;
    const currentIndex = dictionaries.findIndex((candidate) => candidate.id === entry.id);
    const minimumIndex = isManagedCustomDictionary(dictionaries[0]) ? 1 : 0;
    const requested = Number(position.value);
    if (position.value.trim() === "" || !Number.isInteger(requested)) {
      position.value = String(currentIndex + 1);
      return;
    }
    const target = Math.min(dictionaries.length, Math.max(minimumIndex + 1, requested));
    position.value = String(target);
    moveDictionary(entry.id, { position: target });
  };
  position.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      moveToPosition();
    }
  });
  move.addEventListener("click", moveToPosition);
}

function renderDictionaryRow(template, entry, index) {
  const row = template.content.firstElementChild.cloneNode(true);
  row.dataset.dictionaryId = entry.id;
  const details = row.querySelector(".dict-details");
  details.open = expandedDictionaryIds.has(entry.id);
  const toggle = row.querySelector(".dict-details-toggle");
  toggle.setAttribute("aria-label", `Details for ${entry.title}`);
  // A reader opening Details asks for the In memory line; a rebuilt row that
  // is already open shows the last reading.
  toggle.addEventListener("click", () => { if (!details.open) refreshMemorySettings(); });
  row.querySelector(".dict-pinned").hidden = !isManagedCustomDictionary(entry);
  row.classList.toggle("is-off", !entry.enabled);
  bindDictionarySelection(row, entry);
  bindDictionaryDrag(row, entry);

  const title = row.querySelector(".dict-title");
  title.textContent = dictionaryLabel(entry);
  title.title = entry.path;

  const canonical = row.querySelector(".dict-canonical");
  canonical.textContent = entry.displayName ? entry.title : "";
  canonical.hidden = !entry.displayName;
  row.querySelector(".dict-favorite").hidden = !entry.favorite;

  const badges = row.querySelector(".dict-badges");
  addCountBadge(badges, "Terms", entry.termCount);
  addCountBadge(badges, "Frequency", entry.frequencyCount);
  addCountBadge(badges, "Pitch", entry.pitchCount);
  addCountBadge(badges, "Kanji", entry.kanjiCount);
  addCountBadge(badges, "Media", entry.mediaCount);
  const metadata = dictionaryMetadata(entry);
  row.querySelector(".dict-metadata").textContent = isManagedCustomDictionary(entry)
    ? `Managed · always enabled and first · ${metadata}`
    : metadata;
  bindDictionaryUpdate(row, entry);

  bindDictionaryAlias(row, entry);
  bindDictionaryEnabled(row, entry);
  bindDictionaryOrder(row, entry, index);

  const remove = row.querySelector(".dict-remove");
  remove.setAttribute("aria-label", `Remove ${entry.title}`);
  remove.title = `Remove ${entry.title}`;
  if (isManagedCustomDictionary(entry)) {
    remove.dataset.pinnedDisabled = "true";
    remove.disabled = true;
    remove.hidden = true;
  } else {
    remove.addEventListener("click", () => {
      void removeDictionary(entry.id, entry.title);
    });
  }
  return row;
}

function dictionaryRowsMatch(list, visible) {
  const domIds = new Set([...list.children].map((row) => row.dataset.dictionaryId));
  return domIds.size === visible.length && visible.every((entry) => domIds.has(entry.id));
}

function renderDictionaryOrder() {
  const list = element("dict-list");
  const rows = new Map([...list.children].map(row => [row.dataset.dictionaryId, row]));
  let visibleIndex = 0;
  dictionaries.forEach((entry, index) => {
    const row = rows.get(entry.id);
    if (!row) return;
    if (list.children[visibleIndex] !== row) list.insertBefore(row, list.children[visibleIndex]);
    visibleIndex += 1;
    if (row.querySelector(".dict-rank").textContent !== String(index + 1)) refreshDictionaryOrder(row, entry, index);
  });
}

function collectReusableDictionaryRows(list, reuseRows) {
  const reusableRows = new Map();
  // Retain disclosure state by package identity, including temporarily filtered rows.
  for (const row of list.children) {
    if (row.querySelector(".dict-details").open) expandedDictionaryIds.add(row.dataset.dictionaryId);
    else expandedDictionaryIds.delete(row.dataset.dictionaryId);
    // Filtering can retain unchanged controls, but an adopted state awaiting
    // blur has newer metadata and listener inputs than the displayed rows.
    if (reuseRows && !dictionaryRenderDeferred) reusableRows.set(row.dataset.dictionaryId, row);
  }
  const installedIds = new Set(dictionaries.map((entry) => entry.id));
  for (const id of expandedDictionaryIds) {
    if (!installedIds.has(id)) expandedDictionaryIds.delete(id);
  }
  return reusableRows;
}

function renderDictionaries(reuseRows = false) {
  // A queued reorder changes only the order and the index-dependent controls,
  // so its rows can be reappended in the new order and refreshed instead of
  // rebuilt from the template. The hint is single-use per render.
  const reorderReuse = reorderReuseHint;
  reorderReuseHint = false;
  const list = element("dict-list");
  const visible = visibleDictionaries();
  // A failed or conflicting commit can restore a different set than the one
  // being reordered, so only reuse when the rows on screen still match the
  // packages about to be shown (the same visible set, only reordered).
  const reorderReuseSafe = reorderReuse && dictionaryRowsMatch(list, visible);
  if (reorderReuseSafe && !dictionaryRenderDeferred) {
    renderDictionaryOrder();
    return;
  }
  reuseRows = reuseRows || reorderReuseSafe;
  const reusableRows = collectReusableDictionaryRows(list, reuseRows);
  const template = element("dict-row-template");
  const visibleIds = new Set(visible.map((dictionary) => dictionary.id));
  draggedDictionaryId = null;
  if (reusableRows.size > 0) clearDictionaryDropTargets();
  list.textContent = "";

  dictionaries.forEach((entry, index) => {
    if (!visibleIds.has(entry.id)) {
      return;
    }
    const reused = reusableRows.get(entry.id);
    if (reused) {
      // The package set and metadata are unchanged; only its position moved.
      if (reorderReuseSafe) refreshDictionaryOrder(reused, entry, index);
      list.appendChild(reused);
    } else {
      list.appendChild(renderDictionaryRow(template, entry, index));
    }
  });

  element("dict-controls").hidden = dictionaries.length === 0;
  element("library-reset").hidden = dictionaries.length === 0;
  const empty = element("dict-empty");
  const isEmpty = dictionaries.length === 0;
  element("dict-empty-heading").textContent = isEmpty ? "Your Japanese library starts here" : "No dictionaries found";
  element("dict-empty-description").textContent = isEmpty
    ? "Install the recommended set, or bring your own Yomitan ZIP files."
    : "Try a different title or display name.";
  element("dict-empty-actions").hidden = !isEmpty;
  element("empty-clear-search").hidden = isEmpty;
  element("dict-reorder-help").hidden = isEmpty;
  empty.hidden = visible.length > 0;
  if (!element("engine-status").classList.contains("is-error")) renderEngineStatus();
  renderDictionarySelection(visible);
  setControlsDisabled(importing);
  memorySettings().renderRows();
}

function dictionaryMoveTarget(current, index, move) {
  if (move.targetId) {
    return current.findIndex((entry) => entry.id === move.targetId);
  }
  if (move.step) {
    return index + move.step;
  }
  return move.position - 1;
}

function moveDictionary(id, move) {
  const index = dictionaries.findIndex(entry => entry.id === id);
  if (index < 0 || isManagedCustomDictionary(dictionaries[index])) return;
  const minimumIndex = isManagedCustomDictionary(dictionaries[0]) ? 1 : 0;
  const target = Math.max(minimumIndex, dictionaryMoveTarget(dictionaries, index, move));
  const next = moveListItem(dictionaries, index, target);
  if (next === null) return;
  const focus = focusedManagementControl();
  dictionaries = next;
  renderDictionaryOrder();
  if (focus) restoreManagementFocus(focus);

  if (pendingDictionaryOrder === null) {
    const batch = { ids: [], epoch: dictionaryReorderEpoch, timer: null };
    batch.ready = new Promise(resolve => { batch.release = resolve; });
    pendingDictionaryOrder = batch;
    void queueDictionaryStateChange(current => {
      const byId = new Map(current.dictionaries.map(entry => [entry.id, entry]));
      return { ...current, dictionaries: batch.ids.map(id => byId.get(id)) };
    }, true, { orderBatch: batch });
  }
  pendingDictionaryOrder.ids = next.map(entry => entry.id);
  clearTimeout(pendingDictionaryOrder.timer);
  pendingDictionaryOrder.timer = setTimeout(flushDictionaryOrder, 150);
}

function flushDictionaryOrder() {
  if (pendingDictionaryOrder === null) return;
  clearTimeout(pendingDictionaryOrder.timer);
  pendingDictionaryOrder.release();
  pendingDictionaryOrder = null;
}

async function restoreAuthoritativeState(reply) {
  if (reply?.state) {
    adoptDictionaryState(reply.state);
    return;
  }
  const fresh = await send("hd_state_read", {}, WORKER_TARGET);
  if (!fresh.ok || !fresh.state) {
    throw new Error(fresh.error || "the dictionary state could not be read");
  }
  adoptDictionaryState(fresh.state);
}

function directionalFocus(row, controlClass, upClass, downClass) {
  let control = row?.querySelector(`.${controlClass}`);
  if (control?.disabled && controlClass === upClass) {
    control = row.querySelector(`.${downClass}`);
  } else if (control?.disabled && controlClass === downClass) {
    control = row.querySelector(`.${upClass}`);
  }
  return control?.disabled ? null : control;
}

function restoreManagementFocus(focus) {
  const section = focus.kind === "dictionary" ? "dictionaries" : "dictionary-groups";
  if (element(section).hidden) return;
  if (focus.kind === "dictionary") {
    const row = [...element("dict-list").children]
      .find((candidate) => candidate.dataset.dictionaryId === focus.id);
    const control = directionalFocus(row, focus.controlClass, "dict-up", "dict-down")
      ?? row?.querySelector(".dict-details-toggle");
    control?.focus();
    return;
  }

  const groupRows = [...element("dict-group-list").children];
  const groupRow = groupRows.find((candidate) => candidate.dataset.groupId === focus.groupId)
    ?? groupRows[Math.min(focus.groupIndex, groupRows.length - 1)];
  if (!groupRow) {
    element("dict-group-name-new").focus();
    return;
  }

  if (focus.kind === "group") {
    const control = directionalFocus(groupRow, focus.controlClass, "dict-group-up", "dict-group-down")
      ?? groupRow.querySelector(".dict-group-name");
    control?.focus();
    return;
  }

  const memberRows = [...groupRow.querySelectorAll(".dict-group-member")];
  const memberRow = memberRows.find((candidate) => candidate.dataset.dictionaryId === focus.dictionaryId)
    ?? memberRows[Math.min(focus.memberIndex, memberRows.length - 1)];
  const control = directionalFocus(
    memberRow,
    focus.controlClass,
    "dict-group-member-up",
    "dict-group-member-down",
  ) ?? groupRow.querySelector(".dict-group-add-select:not(:disabled), .dict-group-name");
  control?.focus();
}

function renderDictionaryState() {
  const focus = focusedManagementControl()
    ?? (document.activeElement === document.body ? pendingManagementFocus : null);
  pendingManagementFocus = null;
  dictionaries = dictionaryState.dictionaries;
  nameDrafts.retain(new Set([
    ...dictionaries.map(entry => `dictionaries:${entry.id}`),
    ...dictionaryState.groups.map(group => `groups:${group.id}`),
  ]));
  dictionaryRenderDeferred = false;
  renderDictionaries();
  dictionaryGroupController.render();
  renderRecommendedActions();
  setControlsDisabled(importing);
  normaliseKanjiClickOption();
  renderOptions();
  if (focus) restoreManagementFocus(focus);
}

async function commitDictionaryStateChange(update, reloadEngine, baseState = dictionaryState) {
  const next = update(baseState);
  if (next === null) {
    return { ok: true, state: baseState };
  }
  const baseRevision = baseState.revision;
  try {
    const target = reloadEngine ? TARGET : WORKER_TARGET;
    const type = reloadEngine ? "hd_apply_state" : "hd_state_cas";
    const fields = {
      baseRevision,
      dictionaries: next.dictionaries,
    };
    if (!reloadEngine) {
      fields.groups = next.groups;
    }
    const reply = await send(type, fields, target);
    if (!reply.ok) {
      await restoreAuthoritativeState(reply);
      reorderReuseHint = false;
      dictionaryCommitFailed = true;
      dictionaryReorderEpoch += 1;
      setStatus(`Dictionary change was not saved: ${reply.error ?? "the state changed elsewhere"}`, "error");
      return reply;
    }
    adoptDictionaryState(reply.state);
    return reply;
  } catch (error) {
    try {
      await restoreAuthoritativeState();
    } catch {
      // Keep the visible error from the failed write; a later storage event or
      // page reload will supply the authoritative state.
    }
    reorderReuseHint = false;
    dictionaryCommitFailed = true;
    dictionaryReorderEpoch += 1;
    setStatus(`Dictionary change was not saved: ${describeErrorOrJson(error)}`, "error");
    return { ok: false, error: describeErrorOrJson(error) };
  }
}

function queueDictionaryStateChange(update, reloadEngine, { orderBatch = null } = {}) {
  const reorder = orderBatch !== null;
  // A different edit ends the current burst, so later moves cannot jump ahead
  // of an enable, alias, favourite, or group edit in the existing CAS queue.
  if (!reorder) flushDictionaryOrder();
  const queuedBehindChange = pendingDictionaryCommits > 0;
  const baseState = dictionaryState;
  if (pendingDictionaryCommits === 0) {
    dictionaryCommitFailed = false;
  }
  // The next render can reuse the existing rows only if every change coalesced
  // into it was a reorder: reorders touch just the order and index-dependent
  // controls, while any other change can alter per-package metadata.
  reorderReuseHint = reorder && (pendingDictionaryCommits === 0 || reorderReuseHint);
  pendingDictionaryCommits += 1;
  if (reorder) pendingDictionaryReorders += 1;
  committing = true;
  pendingManagementFocus = focusedManagementControl() ?? pendingManagementFocus;
  setControlsDisabled(importing);

  const run = dictionaryCommitTail.then(async previous => {
    if (orderBatch === null) return commitDictionaryStateChange(update, reloadEngine);
    await orderBatch.ready;
    // Every failed commit bumps the epoch after restoring the authoritative
    // state, so a batch drafted before that rollback is stale and dropped.
    if (orderBatch.epoch !== dictionaryReorderEpoch) return { ok: false, state: dictionaryState };
    // Advance only through this page's preceding successful commit. Adopting
    // another page's revision here would silently overwrite its winning order.
    return commitDictionaryStateChange(update, reloadEngine, queuedBehindChange ? previous.state : baseState);
  });
  const settled = run.finally(async () => {
    pendingDictionaryCommits -= 1;
    if (reorder) pendingDictionaryReorders -= 1;
    if (pendingDictionaryCommits > 0) {
      return;
    }
    committing = false;
    renderChangedDictionaryState();
    if (!dictionaryCommitFailed && !reorder) {
      await refreshStatus();
    }
  });
  dictionaryCommitTail = settled.then(
    reply => reply,
    error => ({ ok: false, error: describeErrorOrJson(error) }),
  );
  return settled;
}

function commitDictionaries(update, reloadEngine) {
  return queueDictionaryStateChange((current) => {
    const dictionaries = update(current.dictionaries);
    return dictionaries === null ? null : { ...current, dictionaries };
  }, reloadEngine);
}

function commitGroups(update) {
  return queueDictionaryStateChange((current) => {
    const groups = update(current.groups);
    return groups === null ? null : { ...current, groups };
  }, false);
}

function bindNameDraft(input, collection, id, field, value, normalise, validate) {
  nameDrafts.bind(`${collection}:${id}`, input, {
    value, normalise,
    readName: () => {
      const entry = dictionaryState[collection].find(item => item.id === id);
      return entry ? entry[field] ?? "" : undefined;
    },
    async save(baseName, name) {
      let renamed;
      const reply = await queueDictionaryStateChange(current => {
        renamed = renameWithBaseline(current[collection], id, field, baseName, name, validate);
        return renamed.error || renamed.items === current[collection] ? null : { ...current, [collection]: renamed.items };
      }, false);
      return renamed?.error ? { ok: false, ...renamed } : reply;
    },
  });
}

async function removeDictionary(id, title) {
  if (!window.confirm(`Remove ${title}? Its imported data is deleted and has to be imported again.`)) {
    return;
  }
  await removeDictionaries([{ id, title }]);
}

function selectedRemovableDictionaries() {
  return dictionaries.filter((entry) => selectedDictionaryIds.has(entry.id)
    && !isManagedCustomDictionary(entry));
}

async function removeSelectedDictionaries() {
  const selected = selectedRemovableDictionaries();
  if (!selected.length || !window.confirm(`Remove ${selected.length} selected dictionaries? Their imported data is deleted and has to be imported again. The personal dictionary is kept.`)) {
    return;
  }
  await removeDictionaries(selected);
}

async function removeDictionaries(entries) {
  removing = true;
  setControlsDisabled(true);
  try {
    const failures = await removePackages(entries);
    if (failures.length) setStatus(`Could not remove ${failures.join("; ")}`, "error");
  } finally {
    removing = false;
    setControlsDisabled(importing);
  }
}

// One engine removal per package, in order; a failure does not stop the rest.
// Returns "title: reason" for each package that is still installed.
async function removePackages(entries) {
  const failures = [];
  await dictionaryCommitTail;
  for (const { id, title } of entries) {
    try {
      const reply = await send("hd_remove", { id, title }); // NOSONAR: packages are removed one at a time, in order
      if (!reply.ok) throw new Error(reply.error ?? "unknown error");
      selectedDictionaryIds.delete(id);
    } catch (error) {
      failures.push(`${title}: ${describeErrorOrJson(error)}`);
    }
  }
  if (await reloadDictionaries()) {
    await refreshStatus();
  }
  return failures;
}

function countLabel(count, singular, plural) {
  return `${numberFormat.format(count)} ${count === 1 ? singular : plural}`;
}

function setLibraryResetStatus(message, tone = "", completed = false) {
  setSectionStatus("library-reset-status", message, tone, completed);
}

function removeAllConfirmation(count, personal, erasePersonal) {
  const entries = personal === null ? 0 : parseCustomDictionary(personal.text).entries.length;
  const source = `the personal dictionary source and its ${countLabel(entries, "entry", "entries")}`;
  const packages = countLabel(count, "imported dictionary", "imported dictionaries");
  const parts = count === 0 ? [`Erase ${source}?`] : [
    personal === null ? `Remove ${packages}?` : `Remove ${packages} and erase ${source}?`,
    "That is every imported dictionary, including disabled ones and any the search hides.",
  ];
  if (!erasePersonal) parts.push("The personal dictionary is kept.");
  parts.push("This deletes them from this browser. Anki notes are not changed, and existing backups still hold them.");
  return parts.join(" ");
}

// Empty source through the existing save transaction. The revision is the one
// the confirmation described, so a Note or save since then is refused.
async function erasePersonalSource(confirmed) {
  try {
    const reply = await send("hd_custom_save", { baseDocumentRevision: confirmed.revision, text: "" });
    if (reply.document !== undefined) adoptCustomDictionaryDocument(reply.document);
    adoptCustomDictionaryState(reply.state);
    if (reply.ok) return { erased: true, message: "Erased the personal dictionary source." };
    if (reply.stale === true) {
      return { erased: false,
        message: "The personal dictionary changed after you confirmed, so it was kept. Review it and try again." };
    }
    throw new Error(reply.error || "unknown error");
  } catch (error) {
    return { erased: false, message: `Could not erase the personal dictionary source: ${describeErrorOrJson(error)}.` };
  }
}

// What Remove all would remove now: every ordinary package once pending
// dictionary edits settle, and the personal source when chosen and not empty.
async function removeAllSnapshot(erasePersonal) {
  flushDictionaryOrder();
  await dictionaryCommitTail;
  if (!await reloadDictionaries()) return null;
  const entries = dictionaries.filter(entry => !isManagedCustomDictionary(entry));
  if (!erasePersonal) return { entries, personal: null };
  const reply = await send("hd_custom_read", {}, WORKER_TARGET);
  if (!reply.ok || reply.document === undefined) {
    throw new Error(reply.error || "the personal dictionary source could not be read");
  }
  const personal = normaliseCustomDictionaryDocument(reply.document);
  return { entries, personal: personal.text === "" ? null : personal };
}

function removedSummary(entries, failures) {
  const total = countLabel(entries.length, "dictionary", "dictionaries");
  if (failures.length === 0) return `Removed ${total}.`;
  const removed = numberFormat.format(entries.length - failures.length);
  return `Removed ${removed} of ${total}. Could not remove ${failures.join("; ")}.`;
}

// Settings → Dictionaries → Remove all imported dictionaries. The confirmation names
// the packages left once pending edits settle; each is removed in turn, so a
// failure is reported by title rather than undoing the others.
async function removeAllDictionaries() {
  const erasePersonal = element("library-reset-personal").checked;
  removing = true;
  setControlsDisabled(true);
  try {
    const snapshot = await removeAllSnapshot(erasePersonal);
    if (snapshot === null) return;
    const { entries, personal } = snapshot;
    if (entries.length === 0 && personal === null) {
      setLibraryResetStatus("There is nothing to remove.", "ready");
      return;
    }
    if (!window.confirm(removeAllConfirmation(entries.length, personal, erasePersonal))) return;
    if (sharingLinkedAddress !== null) throw new Error("this browser is now linked to another Hachidori");
    setLibraryResetStatus("Removing dictionaries…", "working");
    const failures = await removePackages(entries);
    const personalOutcome = personal === null ? null : await erasePersonalSource(personal);
    const messages = entries.length > 0 ? [removedSummary(entries, failures)] : [];
    if (personalOutcome !== null) messages.push(personalOutcome.message);
    const succeeded = failures.length === 0 && personalOutcome?.erased !== false;
    setLibraryResetStatus(messages.join(" "), succeeded ? "ready" : "error", succeeded);
  } catch (error) {
    setLibraryResetStatus(`Could not remove the dictionaries: ${describeErrorOrJson(error)}`, "error");
  } finally {
    removing = false;
    setControlsDisabled(importing);
  }
}

async function reloadDictionaries() {
  try {
    let reply = await send("hd_state_read", {}, WORKER_TARGET);
    if (!reply.ok) {
      throw new Error(reply.error || "the dictionary state could not be read");
    }
    if (!reply.state) {
      const reloaded = await send("hd_reload");
      if (!reloaded.ok) {
        throw new Error(reloaded.error || "the dictionary state could not be migrated");
      }
      reply = await send("hd_state_read", {}, WORKER_TARGET);
    }
    if (!reply.ok || !reply.state) {
      throw new Error(reply.error || "the dictionary state could not be read");
    }
    adoptDictionaryState(reply.state);
  } catch (error) {
    setStatus(`Could not read the dictionary list: ${describeErrorOrJson(error)}`, "error");
    return false;
  }
  renderDictionaryState();
  return true;
}

function attachLibraryHandlers() {
  element("dict-search").addEventListener("input", (event) => {
    dictionarySearch = event.target.value;
    renderDictionaries(true);
  });

  element("dict-select-visible").addEventListener("change", (event) => {
    const visible = visibleDictionaries();
    for (const dictionary of visible) {
      if (event.target.checked) {
        selectedDictionaryIds.add(dictionary.id);
      } else {
        selectedDictionaryIds.delete(dictionary.id);
      }
    }
    if (dictionaryRenderDeferred) {
      renderDictionaries();
    } else {
      for (const row of element("dict-list").children) {
        row.querySelector(".dict-selected").checked = selectedDictionaryIds.has(row.dataset.dictionaryId);
      }
      renderDictionarySelection(visible);
      setControlsDisabled(importing);
    }
  });

  element("dict-bulk-enable").addEventListener("click", () => {
    updateSelectedDictionaries("enabled", true, true);
  });
  element("dict-bulk-disable").addEventListener("click", () => {
    updateSelectedDictionaries("enabled", false, true);
  });
  element("dict-bulk-favorite").addEventListener("click", () => {
    updateSelectedDictionaries("favorite", true, false);
  });
  element("dict-bulk-unfavorite").addEventListener("click", () => {
    updateSelectedDictionaries("favorite", false, false);
  });
  element("dict-bulk-remove").addEventListener("click", removeSelectedDictionaries);
  element("library-reset-personal").addEventListener("change", () => setControlsDisabled(importing));
  element("library-remove-all").addEventListener("click", () => { void removeAllDictionaries(); });
}

function attachGroupHandlers() {
  element("dict-group-create-form").addEventListener("submit", (event) => {
    event.preventDefault();
    dictionaryGroupController.create();
  });
  document.querySelector("main").addEventListener("pointerdown", (event) => {
    if (event.target.closest("#dict-list, #dict-group-list")) managementPointerDown = true;
  });
  const finishManagementPointer = () => {
    managementPointerDown = false;
    setTimeout(() => {
      if (dictionaryRenderDeferred) renderChangedDictionaryState();
    }, 0);
  };
  window.addEventListener("pointerup", finishManagementPointer, true);
  window.addEventListener("pointercancel", finishManagementPointer, true);
}

function dictionaryNameIsBeingEdited() {
  const active = document.activeElement;
  return active instanceof HTMLInputElement
    && (active.classList.contains("dict-display-name") || active.classList.contains("dict-group-name"));
}

function renderChangedDictionaryState() {
  if (committing || nameDrafts.hasInFlightSave() || managementPointerDown || dictionaryNameIsBeingEdited()) {
    dictionaryRenderDeferred = true;
    return;
  }
  renderDictionaryState();
}

function handleDictionaryStateChange(change) {
  let adopted;
  try {
    adopted = adoptDictionaryState(change.newValue);
  } catch (error) {
    setStatus(describeErrorOrJson(error), "error");
    return false;
  }
  if (adopted) {
    renderChangedDictionaryState();
    if (updateAvailabilityRecorded(change.oldValue, change.newValue)) scheduleStatusPoll(0);
  }
  return true;
}

// showSettingsSection() in settings.js clears the pending focus through this:
// an imported binding is read-only.
function setPendingManagementFocus(value) {
  pendingManagementFocus = value;
}

export {
  adoptDictionaryState, attachGroupHandlers, attachLibraryHandlers, bindNameDraft, commitDictionaries,
  commitGroups, committing, dictionaries, dictionaryLabel, dictionaryState, handleDictionaryStateChange,
  moveListItem, pendingDictionaryCommits, reloadDictionaries, removing, renderChangedDictionaryState,
  renderDeferredAfterBlur, setControlsDisabled, setPendingManagementFocus, stringValue, updateDictionary,
  updateItemById
};
