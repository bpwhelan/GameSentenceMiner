// Managed dictionary updates in the service worker: checks, installs, the schedule and its alarm.
// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";
import { describeErrorOrJson } from "./error-text.js";
import {
  httpsUrl, MANAGED_DICTIONARY_CHANGED, managedDictionaryFingerprint, managedDictionaryMatches,
  managedDictionarySource, managedUpdateSchedule, nextDictionaryUpdateCheck, nextManagedUpdateCheck,
  normaliseUpdateSettings, recommendedDictionarySource, recommendedIndexUrlMatches,
} from "./managed-dictionary-source.js";
import { sameJsonValue } from "./json-value.js";
import {
  TARGET, DICTIONARY_STATE_KEY, UPDATE_SETTINGS_KEY, writeLocalState, relay, readDictionaryStorage, serialiseStorage,
  failureReply,
} from "./background-core.js";
import { WORKER_HANDLERS } from "./background-requests.js";
import { sharingLinked, forwardToHost } from "./background-sharing.js";
import { alarms, sharingReady } from "./background.js";

const UPDATE_ALARM = "hachidori-managed-dictionary-updates";

async function readUpdateSettings() {
  const stored = await chrome.storage.local.get(UPDATE_SETTINGS_KEY);
  return normaliseUpdateSettings(stored?.[UPDATE_SETTINGS_KEY]);
}

async function writeUpdateSettings(update) {
  return serialiseStorage(async () => {
    const current = await readUpdateSettings();
    const next = update(current);
    if (next === null) return { ok: false, error: "The update settings changed elsewhere. Review the current schedule before retrying.", settings: current };
    if (sameJsonValue(next, current)) return { settings: current };
    const settings = { ...next, revision: current.revision + 1 };
    await writeLocalState({ [UPDATE_SETTINGS_KEY]: settings });
    return { settings };
  });
}

async function updateDictionaryCheck(fingerprint, lastUpdateCheck) {
  return serialiseStorage(async () => {
    const { state } = await readDictionaryStorage();
    const index = state?.dictionaries?.findIndex(
      (dictionary) => dictionary?.id === fingerprint.id,
    ) ?? -1;
    if (index < 0 || !managedDictionaryMatches(state.dictionaries[index], fingerprint)) {
      return null;
    }
    const dictionaries = [...state.dictionaries];
    dictionaries[index] = { ...dictionaries[index], lastUpdateCheck };
    const reply = await WORKER_HANDLERS.hd_state_cas({
      baseRevision: state.revision,
      dictionaries,
    });
    if (reply.ok === false) {
      throw new Error(reply.error || "the dictionary update state could not be saved");
    }
    return reply.state.dictionaries.find((dictionary) => dictionary?.id === fingerprint.id) ?? null;
  });
}

async function managedCandidates(dictionaryIds) {
  const selected = dictionaryIds === null ? null : new Set(dictionaryIds);
  const { state } = await serialiseStorage(readDictionaryStorage);
  return (state?.dictionaries ?? []).flatMap((dictionary) => {
    if (selected !== null && !selected.has(dictionary?.id)) {
      return [];
    }
    const fingerprint = managedDictionaryFingerprint(dictionary);
    return fingerprint === null ? [] : [{
      id: dictionary.id,
      title: dictionary.displayName || dictionary.title,
      fingerprint,
    }];
  });
}

async function remoteUpdate(candidate) {
  const { source } = candidate.fingerprint;
  const response = await fetch(source.indexUrl, { credentials: "omit" });
  if (!response.ok) {
    throw new Error(`update index request failed with HTTP ${response.status}`);
  }
  if (source.kind === "recommended"
      && !recommendedIndexUrlMatches(recommendedDictionarySource(source.sourceId), response.url)) {
    throw new Error("update index downloaded from an unexpected final URL");
  }
  if (source.kind === "generic" && httpsUrl(response.url) === null) {
    throw new Error("update index redirected to a non-HTTPS URL");
  }
  const index = await response.json();
  if (typeof index?.revision !== "string" || index.revision === "") {
    throw new Error("update index did not declare a revision");
  }
  let archiveUrl = source.downloadUrl;
  if (source.kind === "generic"
      && typeof index.downloadUrl === "string"
      && index.downloadUrl !== "") {
    archiveUrl = httpsUrl(index.downloadUrl);
    if (archiveUrl === null) {
      throw new Error("update index returned a non-HTTPS download URL");
    }
  }
  return { revision: index.revision, archiveUrl };
}

let updateRequestCounter = 0;

async function installManagedCandidate(candidate, update, checkedAt) {
  updateRequestCounter += 1;
  const { fingerprint } = candidate;
  const reply = await relay({
    target: TARGET,
    type: "hd_import",
    requestId: `managed-update-${updateRequestCounter}`,
    managedFingerprint: fingerprint,
    sourceId: fingerprint.source.kind === "recommended" ? fingerprint.source.sourceId : null,
    archiveUrl: update.archiveUrl,
    expectedRevision: update.revision,
    checkedAt,
    fileName: candidate.title,
  });
  if (!reply?.ok || !reply.report?.success) {
    throw new Error(reply?.error || reply?.report?.error || "the dictionary update failed");
  }
}

function changedManagedOutcome(candidate) {
  return {
    id: candidate.id,
    status: "check-failed",
    error: MANAGED_DICTIONARY_CHANGED,
  };
}

async function recordManagedOutcome(candidate, lastUpdateCheck, outcome) {
  const recorded = await updateDictionaryCheck(candidate.fingerprint, lastUpdateCheck);
  return recorded === null ? changedManagedOutcome(candidate) : outcome;
}

async function checkManagedCandidate(candidate, checkedAt) {
  let update;
  try {
    update = await remoteUpdate(candidate);
  } catch (error) {
    const message = describeErrorOrJson(error);
    return {
      update: null,
      available: null,
      outcome: await recordManagedOutcome(
        candidate,
        {
          checkedAt,
          status: "check-failed",
          remoteRevision: null,
          error: message,
        },
        { id: candidate.id, status: "check-failed", error: message },
      ),
    };
  }

  if (update.revision === candidate.fingerprint.revision) {
    const outcome = await recordManagedOutcome(
      candidate,
      {
        checkedAt,
        status: "up-to-date",
        remoteRevision: update.revision,
        error: null,
      },
      { id: candidate.id, status: "up-to-date" },
    );
    return { update: null, available: null, outcome };
  }

  const available = {
    checkedAt,
    status: "update-available",
    remoteRevision: update.revision,
    error: null,
  };
  const outcome = await recordManagedOutcome(
    candidate,
    available,
    { id: candidate.id, status: "update-available" },
  );
  return {
    update: outcome.status === "update-available" ? update : null,
    available,
    outcome,
  };
}

async function installCheckedCandidate(candidate, checked, checkedAt) {
  if (checked.update === null) {
    return checked.outcome;
  }
  try {
    await installManagedCandidate(candidate, checked.update, checkedAt);
    return { id: candidate.id, status: "updated" };
  } catch (error) {
    let message = describeErrorOrJson(error);
    const failed = await updateDictionaryCheck(
      candidate.fingerprint,
      { ...checked.available, error: message },
    );
    if (failed === null) message = MANAGED_DICTIONARY_CHANGED;
    return {
      id: candidate.id,
      status: failed === null ? "check-failed" : "update-available",
      error: message,
    };
  }
}

async function readUpdatePlan() {
  const stored = await chrome.storage.local.get([DICTIONARY_STATE_KEY, UPDATE_SETTINGS_KEY]);
  return { dictionaries: stored[DICTIONARY_STATE_KEY]?.dictionaries ?? [],
    settings: normaliseUpdateSettings(stored[UPDATE_SETTINGS_KEY]) };
}

async function scheduledCandidateIsDue(candidate) {
  const { dictionaries, settings } = await serialiseStorage(readUpdatePlan);
  const current = dictionaries.find(dictionary => dictionary.id === candidate.id);
  if (!current || !managedDictionaryMatches(current, candidate.fingerprint)) return false;
  const now = Date.now();
  const due = nextDictionaryUpdateCheck(current, settings.schedule, now);
  return due !== null && due <= now;
}

async function runManagedUpdateCycle({ dictionaryIds = null, install = false, dueOnly = false } = {}) {
  const candidates = await managedCandidates(dictionaryIds);
  const outcomes = [];

  for (const candidate of candidates) {
    // A later package can be switched Off while an earlier fetch is in flight.
    if (dueOnly && !await scheduledCandidateIsDue(candidate)) continue; // NOSONAR: candidates update one at a time
    const checkedAt = new Date().toISOString();
    const checked = await checkManagedCandidate(candidate, checkedAt); // NOSONAR: candidates update one at a time
    outcomes.push(install
      ? await installCheckedCandidate(candidate, checked, checkedAt) // NOSONAR: candidates update one at a time
      : checked.outcome);
  }

  if (dueOnly && outcomes.length === 0) return { outcomes, settings: await readUpdateSettings() };
  const { settings } = await writeUpdateSettings((current) => ({
    ...current,
    lastCheckedAt: new Date().toISOString(),
  }));
  return { outcomes, settings };
}

let updateTail = Promise.resolve();
let updateCycleActive = false; // NOSONAR: a live binding the other worker modules read

function queueManagedUpdate(options) {
  const execute = async () => {
    updateCycleActive = true;
    try { return await runManagedUpdateCycle(options); }
    finally {
      updateCycleActive = false;
      await refreshUpdateAlarm();
    }
  };
  const run = updateTail.then(execute, execute);
  updateTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

let alarmTail = Promise.resolve();

function reconcileUpdateAlarm() {
  const run = alarmTail.then(async () => {
    await sharingReady;
    if (sharingLinked) {
      await alarms.clear(UPDATE_ALARM);
      return;
    }
    if (updateCycleActive) return;
    const { dictionaries, settings } = await serialiseStorage(readUpdatePlan);
    const now = Date.now();
    const when = nextManagedUpdateCheck(dictionaries, settings.schedule, now);
    const existing = await alarms.get(UPDATE_ALARM);
    if (updateCycleActive) return;
    if (when === null) {
      if (existing) await alarms.clear(UPDATE_ALARM);
      return;
    }
    if (existing && existing.periodInMinutes === undefined
        && (existing.scheduledTime === when || (when === now && existing.scheduledTime <= now))) {
      return;
    }
    await alarms.create(UPDATE_ALARM, { when });
  });
  alarmTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function refreshUpdateAlarm() {
  return reconcileUpdateAlarm().catch(error => {
    console.error("hoshidicts: could not reconcile the dictionary update alarm:", describeErrorOrJson(error));
  });
}

function updateTiming(dictionaries = []) {
  return dictionaries.map(dictionary => [managedDictionarySource(dictionary) !== null,
    dictionary.updateScheduleOverride ?? null, dictionary.lastUpdateCheck?.checkedAt ?? null]);
}

const UPDATE_HANDLERS = {
  async hd_updates_schedule(message) {
    const schedule = managedUpdateSchedule(message?.schedule);
    if (schedule === null) {
      throw new Error("the dictionary update schedule is invalid");
    }
    const result = await writeUpdateSettings(current =>
      message.baseRevision === current.revision ? { ...current, schedule } : null);
    if (result.ok !== false) await reconcileUpdateAlarm();
    return result;
  },

  async hd_updates_check(message) {
    if (message.dictionaryIds !== undefined && !Array.isArray(message.dictionaryIds)) {
      throw new TypeError("the dictionary update request carried no dictionary IDs");
    }
    return queueManagedUpdate({ dictionaryIds: message.dictionaryIds, install: false });
  },

  async hd_updates_install(message) {
    if (!Array.isArray(message?.dictionaryIds)) {
      throw new TypeError("the dictionary update request carried no dictionary IDs");
    }
    return queueManagedUpdate({ dictionaryIds: message.dictionaryIds, install: true });
  },
};

async function handleUpdatesRequest(message) {
  const type = typeof message.type === "string" ? message.type : "";
  if (!Object.hasOwn(UPDATE_HANDLERS, type)) {
    return failureReply(message, new Error(`unknown update request type ${JSON.stringify(type)}`));
  }
  await sharingReady;
  if (sharingLinked) return forwardToHost(message);
  return Promise.resolve().then(() => UPDATE_HANDLERS[type](message)).then(
    (result) => {
      const { ok = true, error = null, ...payload } = result ?? {};
      return { type: `${type}_result`, requestId: message.requestId ?? null, ok, error, ...payload };
    },
    (error) => failureReply(message, error),
  );
}

export {
  UPDATE_ALARM, updateCycleActive, queueManagedUpdate, reconcileUpdateAlarm, refreshUpdateAlarm, updateTiming,
  handleUpdatesRequest,
};
