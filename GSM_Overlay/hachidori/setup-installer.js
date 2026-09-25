/*
 * Shared recommended dictionary installer owned by the offscreen document.
 *
 * One run at a time downloads and imports requested recommended sources through
 * the engine's ordinary import transaction. The run outlives the startup page
 * and the service worker, so a reconnecting page or a restarted worker attaches
 * to the same run instead of starting a duplicate batch. Outcomes are recorded
 * by the service worker, which applies initial source selections and updates
 * onboarding progress when startup participates in the run.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { recommendedDictionaryInstalled } from "./managed-dictionary-source.js";
import { RECOMMENDED_DICTIONARIES } from "./recommended-dictionaries.js";

export const SETUP_EVENTS_TARGET = "hachidori-setup-events";
const ENGINE_TARGET = "hoshidicts-offscreen";
const WORKER_TARGET = "hoshidicts-worker";
const ENGINE_BUSY = "the dictionary engine is busy mutating";
const IDLE_POLL_MS = 250;
const RECORD_RETRY_MS = 250;
const RECORD_RETRY_MAX_MS = 2000;

function describe(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export function requestedSetupSources(sourceIds) {
  if (!Array.isArray(sourceIds) || !sourceIds.every((sourceId) => typeof sourceId === "string")) {
    throw new TypeError("the setup install request carried no source list");
  }
  const requested = new Set(sourceIds);
  return RECOMMENDED_DICTIONARIES.filter((entry) => requested.has(entry.sourceId));
}

export function createSetupInstaller({ dispatch, ask, notify, broadcast, now = () => performance.now(),
  randomId = () => crypto.randomUUID() }) {
  let run = null;
  let counter = 0;

  function snapshot() {
    if (run === null) return { runId: null, sequence: 0, finished: true, entries: [] };
    return {
      runId: run.runId,
      sequence: run.sequence,
      finished: run.finished,
      entries: run.entries.map(({ sourceId, phase, receivedBytes, totalBytes, seconds, error }) =>
        ({ sourceId, phase, receivedBytes, totalBytes, seconds, error })),
    };
  }

  function emit() {
    run.sequence += 1;
    broadcast({ target: SETUP_EVENTS_TARGET, type: "hd_setup_progress", ...snapshot() });
  }

  function requestId(kind, sourceId = "") {
    counter += 1;
    return `setup:${run.runId}:${kind}:${sourceId}:${counter}`;
  }

  // The engine reports ready only after boot, and loading while any mutation
  // (including a user's own import) holds its lock.
  async function awaitIdleEngine() {
    for (;;) {
      const status = await dispatch({ target: ENGINE_TARGET, type: "hd_status", requestId: requestId("status") });
      if (status?.ok !== true) throw new Error(status?.error || "the dictionary engine is unavailable");
      if (status.ready === true && status.loading !== true) return;
      await sleep(IDLE_POLL_MS);
    }
  }

  async function inventory() {
    const reply = await ask({ target: WORKER_TARGET, type: "hd_state_read", requestId: requestId("inventory") });
    if (reply?.ok !== true) throw new Error(reply?.error || "the service worker could not read dictionary state");
    return reply.state?.dictionaries ?? [];
  }

  // The worker owns the only durable copy of an outcome, and a restarting
  // worker or a lost reply must not discard it: the same record is resent, with
  // backoff, until the worker answers. Records are idempotent per run, so a
  // write whose reply was lost is simply confirmed by the next attempt.
  async function record(patch) {
    const message = { target: WORKER_TARGET, type: "hd_setup_record", runId: run.runId, recordSetup: run.recordSetup, ...patch };
    for (let delay = RECORD_RETRY_MS; ; delay = Math.min(delay * 2, RECORD_RETRY_MAX_MS)) {
      try {
        const reply = await notify({ ...message, requestId: requestId("record") });
        if (reply?.ok === true) return;
        throw new Error(reply?.error || "no reply");
      } catch (error) {
        console.warn(`hoshidicts: could not record a setup outcome, retrying: ${describe(error)}`);
      }
      await sleep(delay);
    }
  }

  // The row settles only once its outcome is durable, so a reconnecting page
  // never sees a finished row whose record is still in flight. The last row's
  // record also carries the run's installation duration: a terminated document
  // must not be able to leave every outcome settled with the run accounting
  // missing, which nothing could later reconstruct.
  async function settle(entry, outcome, last = false) {
    if (outcome.seconds !== null && outcome.seconds !== undefined) {
      run.installSeconds += outcome.seconds;
    }
    await record(last
      ? { outcomes: { [entry.sourceId]: outcome }, runSeconds: run.installSeconds }
      : { outcomes: { [entry.sourceId]: outcome } });
    entry.phase = outcome.status;
    entry.seconds = outcome.seconds ?? null;
    entry.error = outcome.error ?? null;
    emit();
  }

  async function importEntry(entry, source, last) {
    entry.phase = "downloading";
    emit();
    let reply;
    do {
      await awaitIdleEngine();
      // The wait may have been another import of this very source, from
      // Settings or an earlier run: an installed source is never reimported.
      if (recommendedDictionaryInstalled(source, await inventory())) {
        await settle(entry, { status: "already-installed" }, last);
        return;
      }
      reply = await dispatch({
        target: ENGINE_TARGET,
        type: "hd_import",
        requestId: requestId("import", entry.sourceId),
        sourceId: source.sourceId,
        archiveUrl: source.downloadUrl,
        fileName: source.archiveName,
      });
    } while (reply?.ok !== true && reply?.error === ENGINE_BUSY);
    const seconds = entry.installStartedAt === null ? null : (now() - entry.installStartedAt) / 1000;
    if (reply?.ok === true && reply.report?.success === true) {
      await settle(entry, { status: "installed", seconds: seconds ?? 0 }, last);
    } else {
      await settle(entry, { status: "failed", seconds, error: reply?.error || reply?.report?.error || "the import did not complete" }, last);
    }
  }

  async function execute() {
    const lastEntry = run.entries.at(-1);
    for (const entry of run.entries) {
      const source = RECOMMENDED_DICTIONARIES.find((candidate) => candidate.sourceId === entry.sourceId);
      const last = entry === lastEntry;
      try {
        // Installed by Settings or an earlier run meanwhile: never import twice.
        if (recommendedDictionaryInstalled(source, await inventory())) {
          await settle(entry, { status: "already-installed" }, last);
          continue;
        }
        await importEntry(entry, source, last);
      } catch (error) {
        const seconds = entry.installStartedAt === null ? null : (now() - entry.installStartedAt) / 1000;
        await settle(entry, { status: "failed", seconds, error: describe(error) }, last);
      }
    }
    run.finished = true;
    emit();
  }

  return {
    snapshot,
    // Attaches to the active run, or starts one for the requested catalogue
    // sources when none is active. An empty request only observes. A source
    // that is already installed settles as such, which also gives a package
    // whose commit outlived an earlier installer its durable outcome.
    attach(sourceIds, { recordSetup = true } = {}) {
      const sources = requestedSetupSources(sourceIds);
      if ((run === null || run.finished) && sources.length > 0) {
        run = {
          runId: randomId(),
          sequence: 0,
          finished: false,
          installSeconds: 0,
          recordSetup,
          entries: sources.map((source) => ({
            sourceId: source.sourceId, phase: "waiting", receivedBytes: 0, totalBytes: null,
            seconds: null, error: null, installStartedAt: null,
          })),
        };
        execute().catch((error) => {
          console.error(`hoshidicts: the setup dictionary run stopped: ${describe(error)}`);
        });
      }
      if (run !== null && !run.finished && recordSetup) run.recordSetup = true;
      return snapshot();
    },
    // Download and installation phases reported by the engine for imports
    // this installer issued; other requests' progress is not ours to show.
    progress(event) {
      if (run === null || run.finished) return;
      const match = /^setup:([^:]+):import:([^:]+):/u.exec(String(event?.requestId ?? ""));
      if (match === null || match[1] !== run.runId) return;
      const entry = run.entries.find((candidate) => candidate.sourceId === match[2]);
      if (entry === undefined || entry.phase !== "downloading" && entry.phase !== "installing") return;
      if (event.phase === "installing") {
        entry.phase = "installing";
        entry.installStartedAt ??= now();
      } else if (event.phase === "downloading") {
        entry.receivedBytes = Number(event.receivedBytes) || 0;
        entry.totalBytes = Number.isSafeInteger(event.totalBytes) && event.totalBytes > 0 ? event.totalBytes : null;
      } else {
        return;
      }
      emit();
    },
  };
}
