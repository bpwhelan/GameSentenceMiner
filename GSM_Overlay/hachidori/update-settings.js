// SPDX-License-Identifier: GPL-3.0-or-later

// Settings → Dictionaries → Updates: the default schedule, Check now and Update all,
// and each managed dictionary's update status and schedule.

import { extensionApi as chrome } from "./browser-api.js";
import { describeErrorOrJson } from "./error-text.js";
import {
  effectiveDictionarySchedule,
  managedDictionarySource,
  nextDictionaryUpdateCheck,
  normaliseUpdateSettings,
} from "./managed-dictionary-source.js";
import {
  backingUp, element, lastEngineStatus, OPTIONS_SAVE_DELAY_MS, scheduleStatusPoll, send, setSectionStatus,
  setStatus, syncNavigationStatus, UPDATE_TARGET,
} from "./settings.js";
import {
  commitDictionaries, committing, dictionaries, dictionaryLabel, reloadDictionaries, removing,
  setControlsDisabled, updateDictionary,
} from "./library-settings.js";
import { importing, installingRecommended } from "./import-settings.js";
import { customSaving } from "./custom-dictionary-settings.js";

let updateSettings = { revision: -1, schedule: "off", lastCheckedAt: null };
let pendingSchedule = null, savingSchedule = null, scheduleTimer = null; // NOSONAR: shared with the other Settings modules
let scheduleSaveFailed = false;
let updating = false; // NOSONAR: shared with the other Settings modules

function adoptUpdateSettings(value) {
  const next = normaliseUpdateSettings(value);
  if (next.revision <= updateSettings.revision) return false;
  const changedSchedule = next.schedule !== updateSettings.schedule;
  updateSettings = next;
  if (changedSchedule) refreshDictionarySchedules();
  return true;
}

function setUpdateState(message, tone = "") {
  setSectionStatus("update-state", message, tone, tone === "ready");
}

function isUpdateCheckable(dictionary) {
  return managedDictionarySource(dictionary) !== null;
}

function availableUpdates() {
  return dictionaries.filter((dictionary) =>
    isUpdateCheckable(dictionary) && dictionary.lastUpdateCheck?.status === "update-available");
}

function renderUpdateControls() {
  const schedule = element("update-schedule");
  const value = pendingSchedule?.schedule ?? savingSchedule?.schedule ?? updateSettings.schedule;
  if (schedule.value !== value) schedule.value = value;
  element("update-schedule-conflict-actions").hidden = !scheduleSaveFailed;
  const checked = updateSettings.lastCheckedAt === null
    ? null
    : new Date(updateSettings.lastCheckedAt);
  element("update-last-checked").textContent = checked !== null && !Number.isNaN(checked.getTime())
    ? `Last checked ${checked.toLocaleString()}.`
    : "Never checked.";
  const busy = updating || importing || installingRecommended || removing || committing || customSaving || backingUp;
  element("update-all").disabled = busy || availableUpdates().length === 0;
  element("update-check-now").disabled = busy;
  schedule.disabled = busy || updateSettings.revision < 0;
}

function refreshDictionarySchedules() {
  const byId = new Map(dictionaries.map(dictionary => [dictionary.id, dictionary]));
  for (const row of document.querySelectorAll(".dict-row")) {
    const entry = byId.get(row.dataset.dictionaryId);
    if (entry) renderDictionarySchedule(row, entry);
  }
}

function dictionaryUpdateStatus(entry) {
  const engineUpdating = lastEngineStatus?.updating;
  if (engineUpdating?.id === entry.id) {
    return {
      text: engineUpdating.fallback === "memory" ? "Updating… lookups pause until it finishes" : "Updating…",
      tone: "busy",
    };
  }
  if (!isUpdateCheckable(entry)) {
    return { text: "Not update-checkable", tone: "" };
  }
  const check = entry.lastUpdateCheck;
  if (check?.status === "up-to-date") {
    return { text: "Up to date", tone: "ready" };
  }
  if (check?.status === "update-available") {
    const revision = check.remoteRevision ? `: ${check.remoteRevision}` : "";
    const failure = check.error ? ` · Update failed: ${check.error}` : "";
    return { text: `Update available${revision}${failure}`, tone: "available" };
  }
  if (check?.status === "check-failed") {
    return { text: `Check failed: ${check.error || "unknown error"}`, tone: "error" };
  }
  return { text: "Not checked", tone: "" };
}

function renderDictionaryUpdateStatus(row, entry) {
  const status = dictionaryUpdateStatus(entry);
  const output = row.querySelector(".dict-update-status");
  output.textContent = status.text;
  output.hidden = !entry.lastUpdateCheck && status.tone !== "busy";
  output.classList.toggle("is-ready", status.tone === "ready");
  output.classList.toggle("is-available", status.tone === "available");
  output.classList.toggle("is-error", status.tone === "error");
}

// hd_status.updating names the package an import is replacing; only that row
// (and the one a previous poll named) changes.
function renderUpdatingRows(previousId, currentId) {
  for (const id of new Set([previousId, currentId])) {
    const entry = id === null ? undefined : dictionaries.find((dictionary) => dictionary.id === id);
    const row = entry === undefined ? null
      : element("dict-list").querySelector(`.dict-row[data-dictionary-id="${CSS.escape(id)}"]`);
    if (row !== null) renderDictionaryUpdateStatus(row, entry);
  }
}

function bindDictionaryUpdate(row, entry) {
  renderDictionaryUpdateStatus(row, entry);

  const check = row.querySelector(".dict-update-check");
  check.hidden = !isUpdateCheckable(entry);
  check.setAttribute("aria-label", `Check for updates to ${dictionaryLabel(entry)}`);
  check.title = `Check for updates to ${dictionaryLabel(entry)}`;
  check.addEventListener("click", () => {
    void runManagedUpdate("hd_updates_check", [entry.id]);
  });

  const update = row.querySelector(".dict-update");
  update.hidden = entry.lastUpdateCheck?.status !== "update-available" || !isUpdateCheckable(entry);
  update.setAttribute("aria-label", `Update ${dictionaryLabel(entry)}`);
  update.title = `Update ${dictionaryLabel(entry)}`;
  update.addEventListener("click", () => {
    void runManagedUpdate("hd_updates_install", [entry.id]);
  });
  renderDictionarySchedule(row, entry);
  const schedule = row.querySelector(".dict-update-schedule");
  schedule.value = entry.updateScheduleOverride ?? "inherit";
  schedule.setAttribute("aria-label", `Automatic updates for ${dictionaryLabel(entry)}`);
  schedule.addEventListener("change", async () => {
    const value = schedule.value === "inherit" ? null : schedule.value;
    let stale = false;
    await commitDictionaries(updateDictionary(entry.id, current => {
      if ((current.updateScheduleOverride ?? null) !== (entry.updateScheduleOverride ?? null)
          || !isUpdateCheckable(current)) {
        stale = true;
        return current;
      }
      return value === (current.updateScheduleOverride ?? null) ? current : { ...current, updateScheduleOverride: value };
    }), false);
    if (stale) {
      const current = dictionaries.find(dictionary => dictionary.id === entry.id);
      if (current) {
        schedule.value = current.updateScheduleOverride ?? "inherit";
        renderDictionarySchedule(row, current);
      }
      setStatus("The dictionary schedule changed elsewhere. Review its current value before choosing again.", "error");
    }
  });
}

function renderDictionarySchedule(row, entry) {
  row.querySelector(".dict-schedule").hidden = !isUpdateCheckable(entry);
  const schedule = row.querySelector(".dict-update-schedule");
  const effective = effectiveDictionarySchedule(entry, updateSettings.schedule);
  const inherit = schedule.querySelector('[value="inherit"]');
  const label = `Use default (${updateSettings.schedule})`;
  if (inherit.textContent !== label) inherit.textContent = label;
  const now = Date.now();
  const due = nextDictionaryUpdateCheck(entry, updateSettings.schedule, now);
  const output = row.querySelector(".dict-next-check");
  let text = "Automatic updates off";
  if (due !== null) {
    const next = due <= now ? "Due now" : `Next check ${new Date(due).toLocaleString()}`;
    text = `${effective.charAt(0).toUpperCase()}${effective.slice(1)} · ${next}`;
  }
  if (output.textContent !== text) output.textContent = text;
}

function updateOutcomeSummary(type, outcomes) {
  const failed = outcomes.filter((outcome) => outcome.status === "check-failed" || outcome.error).length;
  if (type === "hd_updates_check") {
    const available = outcomes.filter((outcome) => outcome.status === "update-available").length;
    const dictionariesLabel = outcomes.length === 1 ? "managed dictionary" : "managed dictionaries";
    const updatesLabel = available === 1 ? "update" : "updates";
    return {
      message: `Checked ${outcomes.length} ${dictionariesLabel} — ${available} ${updatesLabel} available, ${failed} failed.`,
      tone: failed === 0 ? "ready" : "error",
    };
  }
  const updated = outcomes.filter((outcome) => outcome.status === "updated").length;
  const updatesLabel = outcomes.length === 1 ? "dictionary update" : "dictionary updates";
  return {
    message: `Finished ${outcomes.length} ${updatesLabel} — ${updated} updated, ${failed} failed.`,
    tone: failed === 0 ? "ready" : "error",
  };
}

async function runManagedUpdate(type, dictionaryIds = null) {
  if (updating) {
    return;
  }
  updating = true;
  setControlsDisabled(true);
  setUpdateState(type === "hd_updates_check" ? "Checking managed dictionaries…" : "Updating dictionaries…");
  // The engine names the package it is replacing (hd_status.updating); polls
  // continue while this operation runs so that row can say so.
  scheduleStatusPoll(0);
  try {
    const fields = dictionaryIds === null ? {} : { dictionaryIds };
    const reply = await send(type, fields, UPDATE_TARGET);
    if (!reply.ok) {
      throw new Error(reply.error || "the dictionary update operation failed");
    }
    adoptUpdateSettings(reply.settings);
    await reloadDictionaries();
    const summary = updateOutcomeSummary(type, reply.outcomes ?? []);
    setUpdateState(summary.message, summary.tone);
  } catch (error) {
    setUpdateState(`Dictionary updates failed: ${describeErrorOrJson(error)}`, "error");
  } finally {
    updating = false;
    syncNavigationStatus("update-state");
    setControlsDisabled(importing);
  }
}

function writeUpdateSchedule(schedule) {
  pendingSchedule = { schedule, baseRevision: pendingSchedule?.baseRevision ?? savingSchedule?.baseRevision ?? updateSettings.revision };
  window.clearTimeout(scheduleTimer);
  scheduleTimer = null;
  if (scheduleSaveFailed) return;
  setUpdateState("Unsaved schedule…", "");
  scheduleTimer = window.setTimeout(() => { void flushUpdateSchedule(); }, OPTIONS_SAVE_DELAY_MS);
}

async function flushUpdateSchedule() {
  window.clearTimeout(scheduleTimer);
  scheduleTimer = null;
  if (savingSchedule || scheduleSaveFailed || !pendingSchedule) return;
  const sent = pendingSchedule;
  pendingSchedule = null;
  savingSchedule = sent;
  renderUpdateControls();
  setUpdateState("Saving schedule…", "");
  try {
    const reply = await send("hd_updates_schedule", sent, UPDATE_TARGET);
    if (reply.settings) adoptUpdateSettings(reply.settings);
    if (!reply.ok) throw new Error(reply.error || "the dictionary update schedule could not be saved");
    // Advance a queued draft only through our own commit, never through an
    // unrelated newer event that happened to arrive before this reply.
    if (pendingSchedule) pendingSchedule.baseRevision = Math.max(pendingSchedule.baseRevision, reply.settings.revision);
    setUpdateState(pendingSchedule ? "Unsaved schedule…" : "Schedule saved.", pendingSchedule ? "" : "ready");
  } catch (error) {
    pendingSchedule ??= sent;
    scheduleSaveFailed = true;
    try {
      const stored = await chrome.storage.local.get("dictionaryUpdates");
      adoptUpdateSettings(stored.dictionaryUpdates);
    } catch { /* Keep the draft even if the committed state cannot be read. */ }
    setUpdateState(`Could not save the schedule: ${describeErrorOrJson(error)} Current schedule: ${updateSettings.schedule}. Your draft is retained.`, "error");
  } finally {
    savingSchedule = null;
    renderUpdateControls();
    syncNavigationStatus("update-state");
    if (!scheduleSaveFailed && scheduleTimer === null && pendingSchedule) void flushUpdateSchedule();
  }
}

function attachUpdateHandlers() {
  element("update-check-now").addEventListener("click", () => {
    void runManagedUpdate("hd_updates_check");
  });
  element("update-all").addEventListener("click", () => {
    void runManagedUpdate("hd_updates_install", availableUpdates().map((dictionary) => dictionary.id));
  });
  element("update-schedule").addEventListener("change", (event) => {
    writeUpdateSchedule(event.target.value);
  });
  element("update-schedule-retry").addEventListener("click", () => {
    if (!pendingSchedule) return;
    pendingSchedule.baseRevision = updateSettings.revision;
    scheduleSaveFailed = false;
    void flushUpdateSchedule();
  });
  element("update-schedule-discard").addEventListener("click", () => {
    window.clearTimeout(scheduleTimer);
    scheduleTimer = pendingSchedule = null;
    scheduleSaveFailed = false;
    renderUpdateControls();
    setUpdateState("Current schedule restored.", "ready");
  });
}

// A scheduled update records that an update is available immediately before
// installing it; that write is the page's cue to start polling hd_status so
// the row can show which package is being replaced.
function updateAvailabilityRecorded(previous, next) {
  const before = new Map((previous?.dictionaries ?? []).map((entry) => [entry?.id, JSON.stringify(entry?.lastUpdateCheck ?? null)]));
  return (next?.dictionaries ?? []).some((entry) =>
    entry?.lastUpdateCheck?.status === "update-available"
      && before.get(entry.id) !== JSON.stringify(entry.lastUpdateCheck));
}

export {
  adoptUpdateSettings, attachUpdateHandlers, bindDictionaryUpdate, isUpdateCheckable, pendingSchedule,
  renderUpdateControls, renderUpdatingRows, savingSchedule, updateAvailabilityRecorded, updating
};
