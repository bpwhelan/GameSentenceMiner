// Backups in the service worker: downloads, automatic backups, preparations relayed to the engine, and
// the alarm handler, which resets the automatic-backup time.
// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";
import { describeErrorOrJson } from "./error-text.js";
import { ANKI_INDEX_ALARM } from "./anki-index-cache.js";
import { createBackupDownloads } from "./backup-downloads.js";
import { assertBackupSnapshot } from "./backup-state.js";
import {
  AUTOMATIC_BACKUP_ALARM, AUTOMATIC_BACKUPS_KEY, automaticBackupDue, automaticBackupStore, nextAutomaticBackupTime,
  replaceAutomaticBackup,
} from "./backup-automatic.js";
import { SHARING_HOST_ALARM } from "./sharing-host.js";
import { forwardableRequest } from "./sharing-protocol.js";
import {
  LOOKUP_STATS_KEY, assertLookupStatsDescriptor, assertLookupStatsRows, emptyLookupStats, lookupStatsKey,
  lookupStatsPrefix,
} from "./lookup-stats.js";
import { normaliseUpdateSettings } from "./managed-dictionary-source.js";
import { normaliseCustomDictionaryDocument, parseCustomDictionary } from "./custom-dictionary.js";
import { sameJsonValue } from "./json-value.js";
import {
  normaliseOptions, projectStoredOptions, normaliseWordStatusOverrides, OFFSCREEN_DOCUMENT, TARGET, relay,
  optionsRevision, serialiseStorage,
} from "./background-core.js";
import { WORKER_HANDLERS } from "./background-requests.js";
import { reconcileAnkiIndex } from "./background-anki.js";
import { UPDATE_ALARM, queueManagedUpdate } from "./background-updates.js";
import { getSharingHost, sharingLinked, forwardToHost } from "./background-sharing.js";
import { alarms, sharingReady } from "./background.js";

let backupDownloads;
let automaticBackupRun = null;
let automaticBackupNextAt = null; // NOSONAR: a live binding the other worker modules read
let automaticBackupWaitingForState = false; // NOSONAR: a live binding the other worker modules read

function getBackupDownloads() {
  backupDownloads ??= createBackupDownloads(chrome, relay);
  return backupDownloads;
}

const AUTOMATIC_BACKUP_RETRY_MS = 60 * 60 * 1000;

function assertBackupEngineSender(sender) {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL(OFFSCREEN_DOCUMENT)) {
    throw new Error("Backup restore and cleanup must be requested by the dictionary engine.");
  }
}

class AutomaticBackupNotReadyError extends Error {}

async function readBackupPayload() {
  const { snapshot } = await WORKER_HANDLERS.hd_backup_base_read();
  const stored = await chrome.storage.local.get(null);
  const descriptor = stored[LOOKUP_STATS_KEY] === undefined ? emptyLookupStats() : stored[LOOKUP_STATS_KEY];
  assertLookupStatsDescriptor(descriptor);
  const prefix = lookupStatsPrefix(descriptor);
  const lookupStatsRows = Object.entries(stored).filter(([key]) => key.startsWith(prefix)).map(([key, row]) => {
    if (lookupStatsKey(descriptor, row) !== key) throw new Error("The lookup statistics row does not match its key.");
    return row;
  });
  assertLookupStatsRows(descriptor, lookupStatsRows);
  return { snapshot: {
    state: snapshot.state,
    options: { ...projectStoredOptions(snapshot.options), revision: optionsRevision(snapshot.options) },
    document: normaliseCustomDictionaryDocument(snapshot.document),
    updates: normaliseUpdateSettings(snapshot.updates),
    lookupStats: descriptor,
    wordStatusOverrides: normaliseWordStatusOverrides(snapshot.wordStatusOverrides),
  }, lookupStatsRows };
}

async function commitAutomaticBackupStore(current, next) {
  try {
    await chrome.storage.local.set({ [AUTOMATIC_BACKUPS_KEY]: next });
    return;
  } catch (commitError) {
    let readback;
    try {
      readback = (await chrome.storage.local.get(AUTOMATIC_BACKUPS_KEY))[AUTOMATIC_BACKUPS_KEY];
    } catch (readError) {
      throw new Error(
        `automatic backup metadata commit outcome is unknown: ${describeErrorOrJson(commitError)}; `
        + `readback failed: ${describeErrorOrJson(readError)}`,
      );
    }
    if (sameJsonValue(readback, next)) return;
    if (sameJsonValue(readback, current)) throw commitError;
    throw new Error(
      `automatic backup metadata commit outcome is unknown: ${describeErrorOrJson(commitError)}; `
      + "readback did not match the previous or replacement index",
    );
  }
}

function automaticBackupSummary(record) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    dictionaries: record.snapshot.state.dictionaries.map(({ title, enabled }) => ({ title, enabled })),
    customEntryCount: parseCustomDictionary(record.snapshot.document.text).entries.length,
  };
}

async function scheduleAutomaticBackup(when) {
  const scheduledTime = Math.max(Date.now(), when);
  const existing = await alarms.get(AUTOMATIC_BACKUP_ALARM);
  if (existing?.scheduledTime !== scheduledTime || existing.periodInMinutes !== undefined) {
    await alarms.create(AUTOMATIC_BACKUP_ALARM, { when: scheduledTime });
  }
  automaticBackupNextAt = when;
}

async function suppressAutomaticBackupsWhileLinked() {
  automaticBackupNextAt = null;
  automaticBackupWaitingForState = false;
  await alarms.clear(AUTOMATIC_BACKUP_ALARM);
  return { created: false, linked: true };
}

async function reconcileAutomaticBackups() {
  if (sharingLinked) return suppressAutomaticBackupsWhileLinked();
  const result = await serialiseStorage(async () => {
    if (sharingLinked) return { created: false, linked: true };
    const current = (await chrome.storage.local.get(AUTOMATIC_BACKUPS_KEY))[AUTOMATIC_BACKUPS_KEY];
    const store = automaticBackupStore(current);
    const checkedAt = Date.now();
    if (!automaticBackupDue(store, checkedAt)) {
      return { created: false, nextAt: nextAutomaticBackupTime(store, checkedAt) };
    }
    const payload = await readBackupPayload();
    try {
      await assertBackupSnapshot(payload.snapshot);
    } catch (error) {
      throw new AutomaticBackupNotReadyError(describeErrorOrJson(error), { cause: error });
    }
    const createdAt = Date.now();
    if (!automaticBackupDue(store, createdAt)) {
      return { created: false, nextAt: nextAutomaticBackupTime(store, createdAt) };
    }
    const record = {
      id: crypto.randomUUID(),
      createdAt: new Date(createdAt).toISOString(),
      snapshot: payload.snapshot,
      lookupStatsRows: payload.lookupStatsRows,
    };
    const next = await replaceAutomaticBackup(store, record, normaliseOptions(payload.snapshot.options).automaticBackupDays);
    await commitAutomaticBackupStore(current, next);
    return {
      created: true,
      record,
      nextAt: nextAutomaticBackupTime(next, createdAt),
    };
  });
  if (result.linked) return suppressAutomaticBackupsWhileLinked();
  automaticBackupWaitingForState = false;
  await scheduleAutomaticBackup(result.nextAt);
  if (result.created) {
    try {
      const cleanup = await relay({
        target: TARGET,
        type: "hd_backup_auto_cleanup",
        requestId: `automatic-backup-cleanup-${result.record.id}`,
      });
      if (!cleanup?.ok) throw new Error(cleanup?.error || "the dictionary engine refused automatic backup cleanup");
    } catch (error) {
      console.warn("hachidori: automatic backup metadata was committed; deferred generation cleanup failed:", describeErrorOrJson(error));
    }
  }
  return result;
}

function queueAutomaticBackup(force = false) {
  if (!force && automaticBackupNextAt !== null && Date.now() < automaticBackupNextAt) {
    return automaticBackupRun ?? Promise.resolve();
  }
  if (automaticBackupRun !== null) return automaticBackupRun;
  const run = sharingReady.then(reconcileAutomaticBackups).catch(async (error) => {
    if (error instanceof AutomaticBackupNotReadyError) {
      automaticBackupNextAt = null;
      automaticBackupWaitingForState = true;
      return;
    }
    automaticBackupWaitingForState = false;
    const retryAt = Date.now() + AUTOMATIC_BACKUP_RETRY_MS;
    try { await scheduleAutomaticBackup(retryAt); }
    catch (alarmError) {
      console.warn("hachidori: could not schedule an automatic backup retry:", describeErrorOrJson(alarmError));
    }
    console.warn("hachidori: could not create the automatic backup:", describeErrorOrJson(error));
  }).finally(() => {
    if (automaticBackupRun === run) automaticBackupRun = null;
  });
  automaticBackupRun = run;
  return run;
}

async function reconcileAutomaticBackupsAfterSharingTransition() {
  const previous = automaticBackupRun;
  if (previous !== null) await previous;
  await queueAutomaticBackup(true);
}

const backupPreparations = new Map();
let backupCancelTail = Promise.resolve();

async function relayEngineRequest(message) {
  // Pushed by the options storage listener only; a page cannot relay it.
  if (message.type === "hd_engine_config") throw new Error("Unknown engine request.");
  await sharingReady;
  if (sharingLinked && forwardableRequest(message)) return forwardToHost(message);
  if (message.type === "hd_backup_cancel") {
    const preparation = backupPreparations.get(message.token);
    if (preparation) preparation.cancelled = true;
    // Retire startup/retries now, then let an already-dispatched prepare finish
    // before cancellation reaches the engine. Otherwise Chrome 128 can deliver
    // pagehide while prepare is awaiting a storage reply: the early cancel sees
    // no prepared token, then prepare publishes fresh roots with nobody left to
    // discard them. Admit only one cleanup request at a time.
    const cancel = async () => {
      if (preparation) await preparation.settled;
      return relay(message);
    };
    const cancelled = backupCancelTail.then(cancel, cancel);
    backupCancelTail = cancelled.catch(() => {});
    return cancelled;
  }
  if (!["hd_backup_prepare", "hd_backup_auto_prepare"].includes(message.type)) return relay(message);
  let settlePreparation;
  const preparation = {
    cancelled: false,
    settled: new Promise(resolve => { settlePreparation = resolve; }),
  };
  backupPreparations.set(message.token, preparation);
  try {
    return await relay(message, () => !preparation.cancelled);
  } finally {
    settlePreparation();
    if (backupPreparations.get(message.token) === preparation) backupPreparations.delete(message.token);
  }
}

function validBackupPreparationToken(token) {
  return typeof token === "string" && token.length > 0 && token.length <= 128;
}

async function cancelOwnedBackupPreparation(token) {
  const reply = await relayEngineRequest({
    target: TARGET,
    type: "hd_backup_cancel",
    token,
    requestId: `backup-lifecycle-${crypto.randomUUID()}`,
  });
  if (!reply?.ok) throw new Error(reply?.error || "The abandoned backup preparation could not be discarded.");
  return reply;
}

function handleAlarm(alarm) {
  if (alarm.name === AUTOMATIC_BACKUP_ALARM) {
    automaticBackupNextAt = null;
    void queueAutomaticBackup(true);
    return;
  }
  if (alarm.name === ANKI_INDEX_ALARM) {
    void reconcileAnkiIndex();
    return;
  }
  if (alarm.name === SHARING_HOST_ALARM) {
    getSharingHost().reconnect();
    return;
  }
  if (alarm.name !== UPDATE_ALARM) {
    return;
  }
  void sharingReady.then(() => (sharingLinked ? undefined : queueManagedUpdate({ install: true, dueOnly: true }))).catch((error) => {
    console.error("hoshidicts: scheduled dictionary updates failed:", describeErrorOrJson(error));
  });
}

export {
  automaticBackupNextAt, automaticBackupWaitingForState, getBackupDownloads, assertBackupEngineSender,
  readBackupPayload, automaticBackupSummary, scheduleAutomaticBackup, queueAutomaticBackup,
  reconcileAutomaticBackupsAfterSharingTransition, relayEngineRequest, validBackupPreparationToken,
  cancelOwnedBackupPreparation, handleAlarm,
};
