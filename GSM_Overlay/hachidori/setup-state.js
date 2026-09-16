// First-run setup state shared by the service worker, the startup page and Settings.
// SPDX-License-Identifier: GPL-3.0-or-later

import { RECOMMENDED_DICTIONARIES } from "./recommended-dictionaries.js";

export const SETUP_STATE_KEY = "setupState";
// Installation-local bookkeeping, also available when an embedded host skips setup.
export const RECOMMENDED_SELECTIONS_KEY = "recommendedDictionarySelections";
export const SETUP_STATE_SCHEMA_VERSION = 1;
export const STARTUP_PAGE = "startup.html";
// A new installation waits for informed Start setup before its automatic work.
// Existing records keep their stage, including runs already in progress.
export const SETUP_STAGES = Object.freeze(["welcome", "dictionaries", "anki", "practice", "complete"]);
export const SETUP_OUTCOME_STATUSES = Object.freeze(["installed", "already-installed", "failed"]);
export const SETUP_ANKI_STATUSES = Object.freeze(["configured", "already-configured", "unavailable", "needs-attention"]);

// Initial preferences for a new installation. They are written once into the
// stored options, so an extension update never changes an existing user's
// reader defaults or overrides a later edit.
export const FIRST_INSTALL_OPTIONS = Object.freeze({
  showCompactDefinitionSummary: true,
  compactDefinitionSummaryCount: 2,
});

// Initial preferences an overlay host seeds on top of the first-install ones.
// A viewport screenshot of a see-through overlay window has no game in it.
export const OVERLAY_MODE_OPTIONS = Object.freeze({
  lookupMode: "hover",
  sourceHighlightEnabled: false,
  anki: Object.freeze({ captureScreenshot: false }),
});

// These describe the local reading surface, even while its library is shared.
export const OVERLAY_LOCAL_OPTION_KEYS = Object.freeze([
  "hoverEnabled", "onlyScanJapaneseText", "lookupMode", "activationKey", "popupHideDelayMs",
  "sourceHighlightEnabled", "popupWidthPx", "popupHeightPx", "popupScalePercent", "popupColumns", "popupToolbarPosition", "popupNestingMaxDepth",
]);

// What mining may use in an overlay host, whatever the stored options say.
// Electron has no chrome.tabs.captureVisibleTab, and no capture host can record
// browser text-to-speech, so only downloadable pronunciations reach Anki.
export function overlayAnkiOptions(options) {
  return {
    ...options,
    anki: { ...options.anki, captureScreenshot: false },
    audioSources: options.audioSources.filter(source => !source.type.startsWith("text-to-speech")),
    mediaCapture: { ...options.mediaCapture, enabled: false },
  };
}

// How each first-install option's value is built from a committed title.
const FIRST_INSTALL_SELECTORS = Object.freeze({
  compactDefinitionSummaryDictionary: (title) => title,
  kanjiClickDictionary: (title) => ({ title, kind: "term" }),
});

// Dictionary-dependent initial preferences, applied once from the committed
// catalogue entry's exact title while the option is still Automatic. Which
// entry sets which option is declared by the catalogue.
export const FIRST_INSTALL_SELECTIONS = Object.freeze(Object.fromEntries(
  RECOMMENDED_DICTIONARIES.filter((entry) => entry.firstInstallOption !== null).map((entry) => {
    const select = FIRST_INSTALL_SELECTORS[entry.firstInstallOption];
    if (select === undefined) throw new Error(`no first-install selector for ${entry.firstInstallOption}`);
    return [entry.sourceId, Object.freeze({ option: entry.firstInstallOption, select })];
  }),
));

function emptySetupDictionaries() {
  return { outcomes: {}, totalSeconds: null, continued: false, selectionsApplied: [], recordedRuns: [] };
}

export function initialSetupState(startedAt) {
  return {
    schemaVersion: SETUP_STATE_SCHEMA_VERSION,
    revision: 1,
    startedAt,
    stage: SETUP_STAGES[0],
    completedAt: null,
    dictionaries: emptySetupDictionaries(),
    anki: null,
  };
}

// The Anki stage settles once: configured automatically, already configured
// by the user, ordinarily absent, or needing attention for a specific reason.
// A configured outcome names the model and deck and carries no reason text; the
// other two carry a reason and no names, so neither can be rendered empty.
export function normaliseSetupAnki(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !SETUP_ANKI_STATUSES.includes(value.status)
      || (value.detail !== null && typeof value.detail !== "string")
      || (value.model !== null && typeof value.model !== "string")
      || (value.deck !== null && typeof value.deck !== "string")) {
    throw new Error("the setup Anki outcome is malformed");
  }
  const configured = value.status === "configured" || value.status === "already-configured";
  if (configured ? (value.model === null || value.deck === null) : (typeof value.detail !== "string" || value.detail === "")) {
    throw new Error("the setup Anki outcome is malformed");
  }
  return {
    status: value.status,
    detail: configured ? null : value.detail,
    model: configured ? value.model : null,
    deck: configured ? value.deck : null,
  };
}

function validSeconds(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

export function normaliseSetupOutcome(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !SETUP_OUTCOME_STATUSES.includes(value.status)
      || !validSeconds(value.seconds ?? null)
      || (value.error !== undefined && value.error !== null && typeof value.error !== "string")) {
    throw new Error("the setup dictionary outcome is malformed");
  }
  return {
    status: value.status,
    seconds: value.status === "already-installed" ? null : value.seconds ?? null,
    error: value.status === "failed" ? value.error ?? "" : null,
  };
}

function normaliseSetupDictionaries(value) {
  if (value === undefined) return emptySetupDictionaries();
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !value.outcomes || typeof value.outcomes !== "object" || Array.isArray(value.outcomes)
      || !validSeconds(value.totalSeconds)
      || typeof value.continued !== "boolean"
      || !Array.isArray(value.selectionsApplied)
      || !value.selectionsApplied.every((sourceId) => Object.hasOwn(FIRST_INSTALL_SELECTIONS, sourceId))
      || !Array.isArray(value.recordedRuns)
      || !value.recordedRuns.every((runId) => typeof runId === "string" && runId !== "")) {
    throw new Error("the setup state is malformed");
  }
  return {
    outcomes: Object.fromEntries(Object.entries(value.outcomes).map(([sourceId, outcome]) =>
      [sourceId, normaliseSetupOutcome(outcome)])),
    totalSeconds: value.totalSeconds,
    continued: value.continued,
    selectionsApplied: [...new Set(value.selectionsApplied)],
    recordedRuns: [...new Set(value.recordedRuns)],
  };
}

/**
 * @returns {null | {schemaVersion: 1, revision: number, startedAt: string, stage: string, completedAt: string | null,
 *   dictionaries: {outcomes: object, totalSeconds: number | null, continued: boolean, selectionsApplied: string[]}}}
 */
export function normaliseSetupState(value) {
  if (value === undefined || value === null) return null;
  if (value?.schemaVersion !== SETUP_STATE_SCHEMA_VERSION) {
    throw new Error(`unsupported setup state schema ${String(value?.schemaVersion)}`);
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1
      || typeof value.startedAt !== "string"
      || !SETUP_STAGES.includes(value.stage)
      || (value.completedAt !== null && typeof value.completedAt !== "string")) {
    throw new Error("the setup state is malformed");
  }
  return {
    schemaVersion: SETUP_STATE_SCHEMA_VERSION,
    revision: value.revision,
    startedAt: value.startedAt,
    stage: value.stage,
    completedAt: value.completedAt,
    dictionaries: normaliseSetupDictionaries(value.dictionaries),
    anki: normaliseSetupAnki(value.anki),
  };
}

export function recordSetupAnki(current, outcome) {
  const anki = normaliseSetupAnki(outcome);
  if (anki === null) throw new Error("the setup Anki outcome is malformed");
  return { ...current, revision: current.revision + 1, anki };
}

export function setupIncomplete(state) {
  return state !== null && state.stage !== "complete";
}

// Setup only moves forward: a stale or unexpected write can neither reopen a
// finished setup nor return to an earlier stage. Leaving the dictionary stage
// with `continued` records that the user accepted an incomplete dictionary set.
export function advanceSetupState(current, stage, now, { continued = false } = {}) {
  if (!SETUP_STAGES.includes(stage)) throw new Error("the setup stage is invalid");
  if (SETUP_STAGES.indexOf(stage) <= SETUP_STAGES.indexOf(current.stage)) {
    throw new Error("the setup stage cannot move backwards");
  }
  return {
    ...current,
    revision: current.revision + 1,
    stage,
    completedAt: stage === "complete" ? now : null,
    dictionaries: continued && current.stage === "dictionaries"
      ? { ...current.dictionaries, continued: true }
      : current.dictionaries,
  };
}

// The installer reports one outcome per dictionary and the summed installation
// duration for each run. Retries accumulate into the stage total; a superseded
// outcome is replaced.
// A record is idempotent: the installer resends it until the reply arrives, so
// a run whose duration already landed is not counted again.
export function recordSetupDictionaries(current, { runId, outcomes = {}, runSeconds = null, selectionsApplied = [] }) {
  if (typeof runId !== "string" || runId === "") throw new Error("the setup record names no run");
  if (!validSeconds(runSeconds)) throw new Error("the setup run installation duration is invalid");
  const recorded = Object.fromEntries(Object.entries(outcomes).map(([sourceId, outcome]) =>
    [sourceId, normaliseSetupOutcome(outcome)]));
  if (!selectionsApplied.every((sourceId) => Object.hasOwn(FIRST_INSTALL_SELECTIONS, sourceId))) {
    throw new Error("the setup selection is unknown");
  }
  // Settings records the same outcomes for initial selections without onboarding.
  if (current === null) return null;
  const dictionaries = current.dictionaries;
  const countRun = runSeconds !== null && !dictionaries.recordedRuns.includes(runId);
  return {
    ...current,
    revision: current.revision + 1,
    dictionaries: {
      ...dictionaries,
      outcomes: { ...dictionaries.outcomes, ...recorded },
      totalSeconds: countRun ? (dictionaries.totalSeconds ?? 0) + runSeconds : dictionaries.totalSeconds,
      selectionsApplied: [...new Set([...dictionaries.selectionsApplied, ...selectionsApplied])],
      recordedRuns: countRun ? [...dictionaries.recordedRuns, runId] : dictionaries.recordedRuns,
    },
  };
}
