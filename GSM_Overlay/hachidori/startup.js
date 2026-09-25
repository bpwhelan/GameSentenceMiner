/*
 * Startup page: the first-run setup shown once after installation.
 *
 * The service worker owns the revisioned setup state; this page reads it from
 * storage, renders the current stage in one card, and advances it through
 * compare-and-set writes so a stale tab cannot move a newer screen backward.
 * The dictionary stage attaches to the offscreen installer's run, which outlives
 * this page, and mirrors its per-dictionary phases.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { extensionApi as chrome } from "./browser-api.js";
import "./reader-options.js";
import "./visual-novel.js";
import {
  createDictionaryProgressList,
  installEntryState,
  formatSeconds,
} from "./dictionary-progress.js";
import { createRecommendedInstallClient } from "./recommended-install-client.js";
import { applyPageTheme } from "./settings-dom.js";
import { canDiscoverSharingHost } from "./sharing-protocol.js";
import { findLocalAudioSource } from "./local-audio-source.js";
import { recommendedDictionaryInstalled } from "./managed-dictionary-source.js";
import { RECOMMENDED_DICTIONARIES, describeRecommendedCatalogue } from "./recommended-dictionaries.js";
import { SETUP_STATE_KEY, SETUP_STAGES, normaliseSetupState } from "./setup-state.js";
import { createPracticeView, practiceReadiness } from "./startup-practice.js";

const WORKER_TARGET = "hoshidicts-worker";
const SETUP_TARGET = "hachidori-setup";
const ENGINE_TARGET = "hoshidicts-offscreen";
const SHARING_TARGET = "hachidori-sharing";
// How long the first render waits for the look around this computer.
const SHARED_LOOKUP_MS = 1500;
const ANKI_RESULT_DISPLAY_MS = 3000;
const COUNTDOWN_TICK_MS = 250;
const ANKI_PROGRESS_STEP_MS = 2000;
const ANKI_PROGRESS_STEPS = 3;
// A dictionary mutation refuses lookups while it holds the engine, so the
// practice probe waits for the engine to go idle and asks again rather than
// calling the sentence unanswerable. Only an idle engine that still refuses is
// counted, so a long generation cleanup cannot exhaust these attempts.
const PROBE_RETRY_MS = 400;
const PROBE_ATTEMPTS = 5;
const { normaliseOptions } = globalThis.HDReaderOptions;

let setupState = null;
let setupError = null;
let dictionaries = [];
let dictionaryRevision = -1;
let options = normaliseOptions(undefined);
let optionsRevision = -1;
let requestCounter = 0;
let saving = false;
let renderedStage;
// A Hachidori sharing itself from another browser on this computer, when one answered.
let sharedHost = null;
let countdown = null;
let countdownPaused = false;
let advanceFailed = false;
let automaticAdvance = null;
let readerLoading = null;
// What a real lookup of the practice sentence found: unknown, "ready" (the
// exact-selection shortcut answers), "passage" (another passage lookup answers),
// "missing" (nothing in the installed dictionaries) or "unavailable" (the engine
// could not answer). Probed again whenever the inventory or the options it
// depends on change, so a removed dictionary or a shortened scan cannot leave a
// stale invitation standing.
let practiceOutcome = null;
let practiceProbed = "";
let practiceLookupShown = false;
// Anki detection is asked for once per page; a failed request waits for Retry.
let ankiRequest = null;
let ankiFailed = false;
// Only a check started by this page may stage a newly configured result.
let ankiProgressRequested = false;
let ankiProgressStartedAt = null;
let ankiProgressTimer = null;
const announced = new Map();
let dictionaryProgress;
let practice;
const installation = createRecommendedInstallClient({
  send: sourceIds => send("hd_setup_install", { sourceIds }, SETUP_TARGET),
  onChange() { if (!saving) render(); },
  onError(error) { setStatus(`Could not start dictionary installation: ${describe(error)}`, "error"); },
});

function element(id) {
  return document.getElementById(id);
}

function wait(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function describe(error) {
  return typeof error?.message === "string" && error.message !== "" ? error.message : String(error);
}

async function send(type, fields, target = WORKER_TARGET) {
  requestCounter += 1;
  const reply = await chrome.runtime.sendMessage({
    target,
    type,
    requestId: `${type.replace(/^hd_/u, "")}-${requestCounter}`,
    ...fields,
  });
  if (!reply) throw new Error("the extension's service worker did not reply");
  return reply;
}

function adoptSetupState(value) {
  let state;
  try {
    state = normaliseSetupState(value);
  } catch (error) {
    setupError = describe(error);
    return true;
  }
  setupError = null;
  if (state !== null && setupState !== null && state.revision <= setupState.revision) return false;
  setupState = state;
  return true;
}

function adoptDictionaryState(value) {
  const revision = Number.isInteger(value?.revision) ? value.revision : 0;
  if (revision <= dictionaryRevision) return false;
  dictionaryRevision = revision;
  dictionaries = Array.isArray(value?.dictionaries) ? value.dictionaries : [];
  return true;
}

function adoptOptions(value) {
  const revision = Number.isInteger(value?.revision) && value.revision >= 0 ? value.revision : 0;
  if (revision <= optionsRevision) return false;
  optionsRevision = revision;
  options = normaliseOptions(value);
  applyPageTheme(document, options);
  return true;
}

function setStatus(message, tone = "") {
  const status = element("setup-status");
  status.textContent = message;
  status.classList.toggle("is-error", tone === "error");
}

function paragraph(text, className = "hint") {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = text;
  return node;
}

// Every control the card rebuilds carries a stable key so a rerender can hand
// focus back to its replacement.
function settingsNote(before, href, after = ".") {
  const node = document.createElement("p");
  node.className = "hint";
  const link = document.createElement("a");
  link.href = href;
  link.dataset.focusKey = `link:${href}`;
  link.textContent = "Settings";
  node.append(before, link, after);
  return node;
}

function button(id, text, onClick, className = "primary-button") {
  const node = document.createElement("button");
  node.type = "button";
  node.id = id;
  node.dataset.focusKey = id;
  node.className = className;
  node.textContent = text;
  node.disabled = saving;
  node.addEventListener("click", onClick);
  return node;
}

function missingEntries() {
  return RECOMMENDED_DICTIONARIES.filter((entry) => !recommendedDictionaryInstalled(entry, dictionaries));
}

// Sources setup has no settled outcome for: a missing one installs, an
// installed one is recorded as already installed. That covers a package whose
// commit outlived the installer that made it, and one the user installed from
// Settings after an automatic attempt failed — its stale failure is reconciled
// without importing anything. A failed source that is still missing waits for
// the explicit Retry.
function untouchedEntries() {
  return RECOMMENDED_DICTIONARIES.filter((entry) => {
    const outcome = setupState.dictionaries.outcomes[entry.sourceId];
    if (outcome === undefined) return true;
    return outcome.status === "failed" && recommendedDictionaryInstalled(entry, dictionaries);
  });
}

function runActive() {
  return installation.run?.finished === false;
}

// A row's text follows the live run while one is active, and otherwise the
// recorded outcome checked against the current inventory: a dictionary removed
// after setup shows as not installed rather than keeping an old time.
function rowState(entry) {
  const live = runActive() ? installation.run.entries.find((candidate) => candidate.sourceId === entry.sourceId) : undefined;
  if (live !== undefined) return installEntryState(live);
  const outcome = setupState.dictionaries.outcomes[entry.sourceId];
  if (recommendedDictionaryInstalled(entry, dictionaries)) {
    return outcome?.status === "installed" && outcome.seconds !== null
      ? { text: `Installed in ${formatSeconds(outcome.seconds)}`, tone: "ok" }
      : { text: "Already installed", tone: "ok" };
  }
  if (outcome?.status === "failed") return { text: `Failed: ${outcome.error}`, tone: "error" };
  return { text: "Not installed" };
}

function dictionaryRows() {
  if (dictionaryProgress) {
    updateDictionaryRows();
    return dictionaryProgress.element;
  }
  dictionaryProgress = createDictionaryProgressList({
    document,
    ariaLabel: "Default dictionaries",
    idPrefix: "setup-dictionary",
  });
  dictionaryProgress.setEntries(RECOMMENDED_DICTIONARIES.map((entry) => ({
    id: entry.sourceId,
    labelId: `setup-dictionary-${entry.sourceId}`,
    name: entry.name,
    purpose: entry.description,
  })));
  updateDictionaryRows();
  return dictionaryProgress.element;
}

function updateDictionaryRows() {
  for (const entry of RECOMMENDED_DICTIONARIES) {
    dictionaryProgress.update(entry.sourceId, rowState(entry));
  }
}

// Announce outcomes, not bytes: one sentence when a dictionary settles.
function announceOutcomes() {
  if (!runActive()) return;
  const run = installation.run;
  for (const entry of run.entries) {
    if (!["installed", "already-installed", "failed"].includes(entry.phase) || announced.get(`${run.runId}:${entry.sourceId}`) === entry.phase) continue;
    announced.set(`${run.runId}:${entry.sourceId}`, entry.phase);
    const name = RECOMMENDED_DICTIONARIES.find((candidate) => candidate.sourceId === entry.sourceId)?.name ?? entry.sourceId;
    if (entry.phase === "installed") setStatus(`${name} installed in ${formatSeconds(entry.seconds)}.`);
    else if (entry.phase === "already-installed") setStatus(`${name} was already installed.`);
    else setStatus(`${name} could not be installed: ${entry.error}`, "error");
  }
}

function cancelCountdown() {
  if (countdown === null) return;
  clearTimeout(countdown.timer);
  clearInterval(countdown.ticker);
  countdown = null;
}

function countdownLabel() {
  const remaining = Math.max(0, Math.ceil((countdown.durationMs - (Date.now() - countdown.startedAt)) / 1000));
  return `Continuing to ${countdown.destination} in ${remaining} ${remaining === 1 ? "second" : "seconds"}`;
}

function updateCountdown() {
  if (countdown === null) return;
  const label = element("setup-countdown-label");
  const track = element("setup-countdown-track");
  if (!label || !track) return;
  const elapsed = Math.min(1, (Date.now() - countdown.startedAt) / countdown.durationMs);
  label.textContent = countdownLabel();
  track.setAttribute("aria-valuenow", String(Math.floor(elapsed * 100)));
  track.style.setProperty("--progress", `${elapsed * 100}%`);
}

async function advanceSettledStage(stage, nextStage) {
  if (!stage || !nextStage || setupState?.stage !== stage
      || (stage === "dictionaries" && missingEntries().length > 0)) return;
  // The installer may have recorded its run total between our read and this
  // write; the second attempt carries the revision that reply delivered.
  let advanced = await advance(nextStage);
  if (!advanced && setupState?.stage === stage
      && (stage !== "dictionaries" || missingEntries().length === 0)) {
    advanced = await advance(nextStage);
  }
  if (!advanced && setupState?.stage === stage) {
    // Leave the result readable with an explicit control instead of retrying on a timer.
    advanceFailed = true;
    render();
  }
}

async function finishCountdown(stage = countdown?.stage, nextStage = countdown?.nextStage) {
  const finishing = countdown ?? { stage, nextStage };
  cancelCountdown();
  countdownPaused = false;
  await advanceSettledStage(finishing.stage, finishing.nextStage);
}

// Dictionary success moves on without a display delay. One task owns the
// automatic write across any renders it causes, including its conflict retry.
function startImmediateAdvance(stage, nextStage) {
  if (automaticAdvance?.stage === stage) return;
  const task = { stage, nextStage };
  automaticAdvance = task;
  queueMicrotask(() => {
    void advanceSettledStage(stage, nextStage).finally(() => {
      if (automaticAdvance === task) automaticAdvance = null;
    });
  });
}

// A settled Anki result stays readable briefly, then setup moves on by itself.
// The countdown label is not a live region: ticks are not news.
function startCountdown(stage, nextStage, destination, durationMs) {
  if (countdown?.stage === stage) return;
  cancelCountdown();
  countdown = {
    stage,
    nextStage,
    destination,
    durationMs,
    startedAt: Date.now(),
    ticker: setInterval(updateCountdown, COUNTDOWN_TICK_MS),
    timer: setTimeout(() => { void finishCountdown(); }, durationMs),
  };
}

function countdownView() {
  // Keep the same animated fill through installer/storage updates. Replacing
  // it would visibly restart the countdown even though its deadline is unchanged.
  if (countdown.node) return countdown.node;
  const wrapper = document.createElement("div");
  wrapper.className = "setup-countdown";
  const label = document.createElement("span");
  label.id = "setup-countdown-label";
  label.className = "setup-countdown-label";
  label.textContent = countdownLabel();
  const track = document.createElement("div");
  track.id = "setup-countdown-track";
  track.className = "track setup-track is-determinate";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-labelledby", "setup-countdown-label");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", "0");
  track.style.setProperty("--progress", "0%");
  track.style.setProperty("--countdown-duration", `${countdown.durationMs}ms`);
  track.style.setProperty("--countdown-delay", `${countdown.startedAt - Date.now()}ms`);
  track.appendChild(document.createElement("div")).className = "track-fill";
  wrapper.append(label, track);
  countdown.node = wrapper;
  return wrapper;
}

function requestInstall(sourceIds) {
  if (sourceIds.length > 0) setStatus("");
  return installation.request(sourceIds);
}

// A complete inventory is announced with this setup's own install time only
// when it installed something; a profile that already carried every source
// reads as already installed and setup moves straight on.
function installedView(rows, importNote) {
  const total = setupState.dictionaries.totalSeconds;
  const installedHere = Object.values(setupState.dictionaries.outcomes).some((outcome) => outcome.status === "installed");
  cancelCountdown();
  if (!advanceFailed) startImmediateAdvance("dictionaries", "anki");
  return {
    heading: installedHere && total !== null ? `All dictionaries installed in ${formatSeconds(total)}` : "All dictionaries are already installed",
    body: [paragraph("Your recommended dictionaries are installed. You can add your own whenever you like."), rows, importNote],
    actions: advanceFailed
      ? [button("setup-continue", "Continue now", () => { void advanceSettledStage("dictionaries", "anki"); })]
      : [],
  };
}

// A failed or later removed source waits for an explicit retry of the missing
// ones, and setup can be continued without them.
function incompleteView(rows, importNote, missing) {
  const failed = installation.failed || missing.some((entry) => setupState.dictionaries.outcomes[entry.sourceId]?.status === "failed");
  return {
    heading: failed ? "Some dictionaries could not be installed" : "Some dictionaries are not installed",
    body: [paragraph("Retry the missing dictionaries, or continue and add them later in Settings."), rows, importNote],
    actions: [
      button("setup-retry", "Retry missing dictionaries", () => { void requestInstall(missing.map((entry) => entry.sourceId)); }),
      button("setup-continue", "Continue setup", () => { void advance("anki", { continued: true }); }, "ghost"),
    ],
  };
}

// Every source without a recorded outcome is requested on its own; the run's
// live rows and the recorded result follow.
function dictionariesView() {
  const attaching = installation.pending;
  const rows = dictionaryRows();
  const importNote = settingsNote("Import your own dictionary ZIPs in ", "settings.html#add-dictionaries");
  const installingView = () => ({
    heading: "Installing default dictionaries…",
    body: [paragraph(`These ${describeRecommendedCatalogue().count} dictionaries get you started. Installation continues if you close this tab; use Resume setup in Settings to return.`), rows, importNote],
    actions: [],
  });
  if (attaching !== null && !attaching.installing && !runActive()) {
    cancelCountdown();
    return { heading: "Checking installed dictionaries…", body: [rows, importNote], actions: [] };
  }
  if (runActive() || attaching !== null) {
    cancelCountdown();
    return installingView();
  }
  const untouched = untouchedEntries();
  if (untouched.length > 0 && !installation.failed) {
    void requestInstall(untouched.map((entry) => entry.sourceId));
    return installingView();
  }
  const missing = missingEntries();
  if (missing.length === 0) return installedView(rows, importNote);
  cancelCountdown();
  return incompleteView(rows, importNote, missing);
}

function stopAnkiProgress() {
  if (ankiProgressTimer !== null) clearTimeout(ankiProgressTimer);
  ankiProgressTimer = null;
  ankiProgressStartedAt = null;
}

function startAnkiProgress() {
  stopAnkiProgress();
  ankiProgressStartedAt = Date.now();
}

function ankiProgressStep() {
  if (ankiProgressStartedAt === null) return 0;
  return Math.min(ANKI_PROGRESS_STEPS - 1,
    Math.floor((Date.now() - ankiProgressStartedAt) / ANKI_PROGRESS_STEP_MS));
}

function scheduleAnkiProgressRender() {
  if (ankiProgressStartedAt === null || ankiProgressTimer !== null) return;
  const elapsed = Date.now() - ankiProgressStartedAt;
  const total = ANKI_PROGRESS_STEPS * ANKI_PROGRESS_STEP_MS;
  if (elapsed >= total) return;
  const nextBoundary = Math.min(total,
    (Math.floor(elapsed / ANKI_PROGRESS_STEP_MS) + 1) * ANKI_PROGRESS_STEP_MS);
  ankiProgressTimer = setTimeout(() => {
    ankiProgressTimer = null;
    render();
  }, Math.max(0, nextBoundary - elapsed));
}

function ankiProgressView(anki = null, complete = false) {
  const steps = [
    "Looking for the most popular mining card",
    "Looking for the most popular deck",
    "Setting Hachidori to use them",
  ];
  const selected = anki?.status === "configured";
  const current = complete ? ANKI_PROGRESS_STEPS : ankiProgressStep();
  const details = selected
    ? [`Selected ${anki.model}`, `Selected ${anki.deck}`, "Ready for future mining"]
    : [];
  const list = document.createElement("ol");
  list.className = "setup-anki-progress";
  list.setAttribute("aria-label", "Automatic Anki setup");
  for (const [index, title] of steps.entries()) {
    const row = document.createElement("li");
    const done = index < current;
    const active = !complete && index === current;
    row.className = "setup-anki-progress-step";
    row.classList.toggle("is-done", done);
    row.classList.toggle("is-current", active);
    row.dataset.step = String(index + 1);
    if (active) row.setAttribute("aria-current", "step");
    const marker = document.createElement("span");
    marker.className = "setup-anki-progress-marker";
    marker.setAttribute("aria-hidden", "true");
    if (done) {
      const icon = document.createElement("span");
      icon.className = "hd-icon";
      icon.dataset.icon = "checkmark";
      icon.setAttribute("aria-hidden", "true");
      marker.append(icon);
    } else {
      marker.textContent = String(index + 1);
    }
    const copy = document.createElement("span");
    copy.className = "setup-anki-progress-copy";
    const label = document.createElement("strong");
    label.textContent = title;
    const detail = document.createElement("small");
    let detailText = "Waiting";
    if (done || (active && selected)) detailText = details[index];
    else if (active) detailText = "Checking Anki…";
    detail.textContent = detailText;
    copy.append(label, detail);
    row.append(marker, copy);
    list.appendChild(row);
  }
  return list;
}

function automaticAnkiView(anki = null) {
  scheduleAnkiProgressRender();
  return {
    heading: "Finding your Anki setup…",
    body: [
      paragraph("Hachidori is checking the cards and decks you already use, then choosing the setup you use most."),
      ankiProgressView(anki),
      paragraph("You can continue while the check finishes in the background."),
    ],
    actions: [button("setup-continue", "Continue now", () => { void advance("practice"); })],
  };
}

function ankiOutcomeRecorded() {
  return setupState !== null && setupState.anki !== null;
}

function requestAnkiSetup() {
  if (ankiRequest !== null) return ankiRequest;
  const showPending = ankiFailed;
  ankiFailed = false;
  ankiProgressRequested = setupState?.anki === null;
  stopAnkiProgress();
  const request = send("hd_setup_anki", {}).then((reply) => {
    if (!reply.ok) throw new Error(reply.error || "Anki could not be checked");
    adoptSetupState(reply.state);
    // The reply promises a recorded outcome; without one the check is reported, not repeated.
    if (setupState?.anki === null) throw new Error("no Anki outcome was recorded");
    if (setupState.anki.status !== "configured") ankiProgressRequested = false;
  }).catch((error) => {
    // The worker may have committed the outcome before its reply was lost.
    if (ankiOutcomeRecorded()) return;
    ankiFailed = true;
    stopAnkiProgress();
    setStatus(`Could not check Anki: ${describe(error)}`, "error");
  }).finally(() => {
    ankiRequest = null;
    render();
  });
  ankiRequest = request;
  if (showPending) {
    setStatus("Finding your Anki setup…");
    render();
  }
  return request;
}

// The settled Anki outcome, with its Settings link, as one readable sentence.
// Names come from Anki and are rendered as text, never as markup.
function ankiOutcomeNote(anki) {
  const node = document.createElement("p");
  node.className = "hint setup-anki-outcome";
  node.dataset.status = anki.status;
  const link = document.createElement("a");
  link.href = "settings.html#anki";
  link.dataset.focusKey = "link:settings.html#anki";
  link.textContent = "Settings";
  if (anki.status === "configured") {
    node.append(`Automatically set up ${anki.model} for deck ‘${anki.deck}’. Change in `, link, ".");
  } else if (anki.status === "already-configured") {
    node.append(`Anki is already set up with ${anki.model} for deck ‘${anki.deck}’. Change in `, link, ".");
  } else if (anki.status === "unavailable") {
    link.href = "https://apps.ankiweb.net/";
    link.dataset.focusKey = "link:anki-download";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Anki";
    node.append("Could not find Anki. If you want to make flashcards out of words, I suggest ", link, "!");
  } else {
    node.append(`Anki needs attention: ${anki.detail} Set up in `, link, ".");
  }
  return node;
}

function localAudioOutcomeNote() {
  const source = findLocalAudioSource(options.audioSources);
  if (source === null) return null;
  const node = paragraph(source.enabled
    ? "Local audio is configured."
    : "Local audio is configured but disabled.");
  node.classList.add("setup-local-audio-outcome");
  return node;
}

function ankiOutcomeBody(anki) {
  const audio = localAudioOutcomeNote();
  return [ankiOutcomeNote(anki), ...(audio === null ? [] : [audio])];
}

function ankiHeading(anki) {
  switch (anki.status) {
    case "configured": return "Anki is set up";
    case "already-configured": return "Anki is already set up";
    case "unavailable": return "Could not find Anki";
    default: return "Anki needs attention";
  }
}

function pendingAnkiView() {
  if (ankiFailed) {
    return {
      heading: "Anki could not be checked",
      body: [settingsNote("Anki is optional. You can set it up later in ", "settings.html#anki")],
      actions: [
        button("setup-retry", "Retry", () => { void requestAnkiSetup(); }),
        button("setup-continue", "Continue setup", () => { void advance("practice"); }, "ghost"),
      ],
    };
  }
  void requestAnkiSetup();
  return automaticAnkiView();
}

function stagedConfiguredAnkiView(anki) {
  if (anki.status !== "configured") {
    ankiProgressRequested = false;
    stopAnkiProgress();
    return null;
  }
  if (!ankiProgressRequested) return null;
  if (ankiProgressStartedAt === null) startAnkiProgress();
  if (Date.now() - ankiProgressStartedAt < ANKI_PROGRESS_STEPS * ANKI_PROGRESS_STEP_MS) {
    return automaticAnkiView(anki);
  }
  ankiProgressRequested = false;
  stopAnkiProgress();
  return null;
}

// Detection runs once per installation; its recorded outcome stays readable
// for three seconds before setup moves on by itself.
function ankiView() {
  const anki = setupState.anki;
  if (anki === null) return pendingAnkiView();
  // A fast local AnkiConnect response can finish before the browser paints.
  // Keep each real detection step visible once before revealing a successful
  // automatic choice; the worker's existing detection and saved result remain
  // the source of truth.
  const staged = stagedConfiguredAnkiView(anki);
  if (staged !== null) return staged;
  if (advanceFailed) {
    cancelCountdown();
    return { heading: ankiHeading(anki),
      body: [...(anki.status === "configured" ? [ankiProgressView(anki, true)] : []), ...ankiOutcomeBody(anki)],
      actions: [button("setup-continue", "Continue setup", () => { void advance("practice"); })] };
  }
  if (countdownPaused) cancelCountdown();
  else startCountdown("anki", "practice", "practice", ANKI_RESULT_DISPLAY_MS);
  return {
    heading: ankiHeading(anki),
    body: [...(anki.status === "configured" ? [ankiProgressView(anki, true)] : []), ...ankiOutcomeBody(anki),
      countdownPaused ? paragraph("Automatic continuation is paused. Continue when you’re ready.") : countdownView()],
    actions: [
      button("setup-continue", "Continue now", () => { void finishCountdown("anki", "practice"); }),
      button("setup-pause", countdownPaused ? "Resume countdown" : "Pause countdown", () => {
        countdownPaused = !countdownPaused;
        render();
      }, "ghost"),
    ],
  };
}

// The reader itself, in the one authoritative order: the manifest's own
// content-script list, minus `reader-options.js`, which this module already
// loaded. It arrives only when the practice step does, so nothing scans the
// installation or Anki screens.
function readerScripts() {
  const [injected] = chrome.runtime.getManifest().content_scripts ?? [];
  return (injected?.js ?? []).filter((src) => src !== "reader-options.js");
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.dataset.setupReader = "true";
    script.addEventListener("load", () => { resolve(); });
    script.addEventListener("error", () => { reject(new Error(`${src} could not be loaded`)); });
    document.head.appendChild(script);
  });
}

// One load per page: the reader initialises itself when its last script runs.
function loadReader() {
  readerLoading ??= readerScripts().reduce(
    (chain, src) => chain.then(() => loadScript(src)), Promise.resolve(),
  ).then(() => globalThis.HDReaderReady).catch((error) => {
    // The persistent practice controller also exposes its recovery link.
    setStatus(`The lookup exercise could not start: ${describe(error)}`, "error");
    throw error;
  });
  return readerLoading;
}

// The invitation is only made when this exact sentence can be answered, so the
// page asks the exact-selection shortcut first, then ordinary lookups from the
// passage offsets if needed, stopping at the first hit. A partly installed or
// unrelated library therefore cannot advertise an exercise that returns nothing.
// What the answer depends on, rather than the whole revision: the engine-visible
// library and the lookup options the probe sends. A group-only or presentation
// write leaves this unchanged, so it cannot invalidate a ready exercise.
function practiceSignature() {
  const library = dictionaries.map((dictionary) => [dictionary?.id ?? "", dictionary?.title ?? "",
    dictionary?.revision ?? "", dictionary?.path ?? "", dictionary?.enabled !== false,
    dictionary?.termCount ?? 0].join("\u001f")).join("\u001e");
  return `${library}|${options.scanLength}|${options.maxResults}|${options.frequencyDictionary}|${options.frequencyOrder}`;
}

async function probePracticeText(signature, text, exact = false) {
  let reply;
  try {
    // Selection uses the selected word's length and ignores prefix-only hits;
    // hover uses the configured scan length and needs just one term result.
    reply = await send("hd_lookup", { text,
      scanLength: exact ? [...text].length : options.scanLength,
      maxResults: exact ? options.maxResults : 1,
      options: { frequencyDictionary: options.frequencyDictionary, frequencyOrder: options.frequencyOrder, primaryReading: "" },
    }, ENGINE_TARGET);
  } catch {
    return "refused";
  }
  if (practiceProbed !== signature) return "gone";
  if (reply?.ok === false) return "refused";
  const found = Array.isArray(reply?.results) && reply.results.some((result) => result?.term
    && (!exact || result.matched === text));
  return found ? "ready" : "missing";
}

// Prove the fixed shortcut first. If it misses, one passage sweep can still
// enable ordinary hover/selection without advertising that unanswered button.
async function sweepPractice(signature) {
  const word = practice.node.querySelector("#setup-practice-word").textContent;
  const shortcut = await probePracticeText(signature, word, true);
  if (shortcut !== "missing") return shortcut;
  const characters = [...practice.node.querySelector("#setup-practice-text").textContent];
  for (let start = 0; start < characters.length; start += 1) {
    const found = await probePracticeText(signature, characters.slice(start).join(""));
    if (found === "ready") return "passage";
    if (found !== "missing") return found;
  }
  return "missing";
}

// The engine reports ready after boot and loading while any mutation, including
// a long generation cleanup, holds it. Waiting here is what keeps a refusal from
// becoming a verdict. A failed status is also worth waiting on: a status poll is
// what drives the engine's own reload recovery, so the next one can describe a
// repaired engine. Only an unreachable engine, or one that keeps failing, ends
// the wait, as does a newer signature.
async function awaitIdleEngine(signature) {
  for (let failures = 0; failures < PROBE_ATTEMPTS;) {
    let status;
    try {
      status = await send("hd_status", {}, ENGINE_TARGET);
    } catch {
      return false;
    }
    if (practiceProbed !== signature) return false;
    if (status?.ok === true && status.ready === true && status.loading !== true) return true;
    // A failure that is still loading is recovery in progress, not a verdict.
    if (status?.ok !== true && status?.loading !== true) failures += 1;
    await wait(PROBE_RETRY_MS);
    if (practiceProbed !== signature) return false;
  }
  return false;
}

function probePractice() {
  const signature = practiceSignature();
  practiceProbed = signature;
  practiceOutcome = null;
  void (async () => {
    const settle = (found) => {
      if (practiceProbed !== signature) return;
      practiceOutcome = found;
      render();
    };
    for (let refusals = 0; refusals < PROBE_ATTEMPTS; refusals += 1) {
      const found = await sweepPractice(signature);
      // A newer inventory or option has its own probe; this one's answer is stale.
      if (found === "gone" || practiceProbed !== signature) return;
      if (found !== "refused") {
        settle(found);
        return;
      }
      if (!await awaitIdleEngine(signature)) {
        settle("unavailable");
        return;
      }
    }
    settle("unavailable");
  })();
}

// Preserve the reviewed scene while the current library is proved answerable.
// Finish and saved-page guidance remain available throughout the probe.
function practiceView() {
  if (!practice) {
    practice = createPracticeView({ document, loadReader, onReaderSettled: render,
      onDismiss: () => { element("setup-finish")?.focus(); } });
    globalThis.HDVisualNovel.initialize(practice.node.querySelector(".vn-scene"));
  }
  if (!practiceReadiness(options, dictionaries).canProbe) {
    // Retire an in-flight probe when lookup becomes unavailable too.
    practiceProbed = "";
    practiceOutcome = null;
  } else if (practiceProbed !== practiceSignature()) {
    probePractice();
  }
  const readiness = practice.update(options, dictionaries, practiceOutcome);
  if (!practiceLookupShown && practiceOutcome === "ready") {
    // The first render mounts the practice node while the reader loads. As soon
    // as its real lookup control becomes enabled, select before the ready render
    // returns so the final page cannot paint ahead of its demonstration.
    practiceLookupShown = practice.lookup();
  }
  return {
    heading: readiness.heading,
    body: [practice.node, ...(setupState.anki === null ? [] : [ankiOutcomeNote(setupState.anki)])],
    actions: [button("setup-finish", "Finish setup", () => { void finish(); }, readiness.message ? "ghost" : "primary-button"), paragraph("The exercise is optional. You can finish any time.")],
  };
}

// Nothing found, or no answer within the wait, leaves the plain welcome; a
// late answer re-renders it with the offer.
async function findSharedHachidori() {
  try {
    const status = await send("hd_sharing_status", {}, SHARING_TARGET);
    if (!status.ok || !canDiscoverSharingHost(status.sharing)) return;
    const reply = await send("hd_sharing_client_probe", { address: "" }, SHARING_TARGET);
    if (!reply.ok || setupState?.stage !== "welcome") return;
    sharedHost = { address: reply.address, host: reply.host };
    if (!saving) render();
  } catch {
    // The plain welcome stays.
  }
}

// Linking mirrors the shared library here, and setup then has nothing left to do.
async function useSharedHachidori() {
  if (saving || setupState === null || sharedHost === null) return;
  saving = true;
  for (const control of element("setup-actions").querySelectorAll("button")) control.disabled = true;
  setStatus("Linking…");
  try {
    const reply = await send("hd_sharing_client_link", { address: sharedHost.address }, SHARING_TARGET);
    if (!reply.ok) throw new Error(reply.error || "the link did not complete");
  } catch (error) {
    saving = false;
    setStatus(`Could not use that Hachidori: ${describe(error)}`, "error");
    render();
    return;
  }
  saving = false;
  await advance("complete");
}

function welcomeView() {
  if (sharedHost !== null) {
    const name = sharedHost.host.name || "another browser";
    const count = sharedHost.host.dictionaryCount === 1 ? "1 dictionary" : `${sharedHost.host.dictionaryCount} dictionaries`;
    return {
      heading: "Welcome to Hachidori",
      body: [
        paragraph(`${name} on this computer already has Hachidori set up, with ${count}.`),
        paragraph("Use it here instead of setting up again? Words are looked up there, and nothing is downloaded twice."),
      ],
      actions: [
        button("setup-use-shared", `Use the Hachidori in ${name}`, () => { void useSharedHachidori(); }),
        button("setup-start", "Set up separately", () => { void advance("dictionaries"); }, "ghost"),
        button("setup-manual", "Set up manually", () => { void advance("practice"); }, "ghost"),
      ],
    };
  }
  return {
    heading: "Welcome to Hachidori",
    body: [
      paragraph("Click Start Setup to automatically set up Hachidori"),
      settingsNote("Already using Hachidori in another browser, on this computer or another one? Link to it from ", "settings.html#sharing", " instead of setting up again."),
    ],
    actions: [
      button("setup-start", "Start Setup", () => { void advance("dictionaries"); }),
      button("setup-manual", "Set up manually", () => { void advance("practice"); }, "ghost"),
    ],
  };
}

const VIEWS = {
  welcome: welcomeView,
  dictionaries: dictionariesView,
  anki: ankiView,
  practice: practiceView,
  complete: () => ({
    heading: "Setup is complete.",
    body: [paragraph("You can close this tab. Your setup progress is saved."), settingsNote("Change dictionaries, Anki and reading preferences any time in ", "settings.html")],
    actions: [],
  }),
};

function inactiveView() {
  return {
    heading: "Manage Hachidori",
    body: [settingsNote("Setup runs once after installation. Manage dictionaries and preferences in ", "settings.html")],
    actions: [],
  };
}

function failedView() {
  return {
    heading: "Setup could not be read.",
    body: [paragraph(setupError, "hint is-error"), settingsNote("Manage dictionaries and preferences in ", "settings.html")],
    actions: [button("setup-reload", "Reload setup", () => { location.reload(); })],
  };
}

function renderSteps(stage) {
  element("setup-steps").hidden = stage === "welcome";
  const position = stage === null ? -1 : SETUP_STAGES.indexOf(stage);
  for (const step of element("setup-steps").querySelectorAll(".setup-step")) {
    const index = SETUP_STAGES.indexOf(step.dataset.stage);
    const current = index === position;
    step.classList.toggle("is-current", current);
    step.classList.toggle("is-done", position > index);
    if (current) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  }
}

function currentView() {
  if (setupError !== null) return failedView();
  if (setupState === null) return inactiveView();
  if (setupState.stage !== "anki") {
    ankiProgressRequested = false;
    if (ankiProgressStartedAt !== null) stopAnkiProgress();
  }
  if (countdown !== null && countdown.stage !== setupState.stage) cancelCountdown();
  return VIEWS[setupState.stage]();
}

function renderBody(children) {
  const body = element("setup-body");
  // Remove obsolete nodes backwards before inserting replacements, keeping
  // persistent rows and the scene connected throughout the update.
  for (let index = body.children.length - 1; index >= 0; index -= 1) {
    const child = body.children[index];
    if (!children.includes(child)) child.remove();
  }
  for (const [index, child] of children.entries()) {
    if (body.children[index] !== child) body.insertBefore(child, body.children[index] ?? null);
  }
}

function recoverRecordedAnkiOutcome(view) {
  if (!ankiFailed || !ankiOutcomeRecorded()) return;
  ankiFailed = false;
  const status = element("setup-status");
  if (status.classList.contains("is-error") && status.textContent.startsWith("Could not check Anki:")) {
    setStatus(view.heading);
  }
}

function render() {
  const stage = setupError === null ? setupState?.stage ?? null : null;
  // A stage of its own starts without the previous stage's failed-advance state.
  if (stage !== renderedStage) {
    advanceFailed = false;
    countdownPaused = false;
  }
  const card = element("setup-card");
  const focusKey = card.contains(document.activeElement) ? document.activeElement.dataset.focusKey ?? "" : "";
  const view = currentView();
  recoverRecordedAnkiOutcome(view);
  renderSteps(stage);
  const heading = element("setup-heading");
  if (heading.textContent !== view.heading) heading.textContent = view.heading;
  renderBody(view.body);
  element("setup-actions").replaceChildren(...view.actions);
  announceOutcomes();
  if (heading.textContent !== lastAnnouncedHeading) {
    lastAnnouncedHeading = heading.textContent;
    if (!element("setup-status").classList.contains("is-error")) setStatus(view.heading);
  }
  if (renderedStage !== undefined && renderedStage !== stage) {
    // The control that held focus belonged to the previous stage.
    heading.focus();
  } else if (focusKey) {
    const replacement = [...card.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === focusKey);
    // Retry removes its button while work runs; keep a keyboard user's place
    // at the result heading when that action no longer exists.
    (replacement ?? heading).focus();
  }
  renderedStage = stage;
}

let lastAnnouncedHeading;

async function advance(stage, { continued = false } = {}) {
  if (saving || setupState === null) return false;
  saving = true;
  for (const control of element("setup-actions").querySelectorAll("button")) control.disabled = true;
  setStatus("Saving…");
  let advanced = false;
  try {
    const reply = await send("hd_setup_cas", { baseRevision: setupState.revision, stage, ...(continued ? { continued } : {}) });
    if (reply.state) adoptSetupState(reply.state);
    // Another tab may have already made this exact move: the conflict it leaves
    // behind is the move this page asked for, not a failure to report.
    const reached = setupState !== null && SETUP_STAGES.indexOf(setupState.stage) >= SETUP_STAGES.indexOf(stage);
    if (!reply.ok && !(reply.conflict === true && reached)) throw new Error(reply.error || "setup progress could not be saved");
    setStatus("");
    advanced = true;
  } catch (error) {
    setStatus(`Could not save setup progress: ${describe(error)}`, "error");
  } finally {
    saving = false;
    render();
  }
  return advanced;
}

async function finish() {
  if (!await advance("complete")) return;
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
  } catch {
    // The completed view stays readable when the tab cannot close itself.
  }
}

function handleStorageChange(changes, area) {
  if (area !== "local") return;
  let changed = false;
  if (changes[SETUP_STATE_KEY]) changed = adoptSetupState(changes[SETUP_STATE_KEY].newValue) || changed;
  if (changes.dictionaryState) changed = adoptDictionaryState(changes.dictionaryState.newValue) || changed;
  if (changes.options) changed = adoptOptions(changes.options.newValue) || changed;
  // A write in flight renders once its reply settles.
  if (changed && !saving) render();
}

async function start() {
  // Focus directly without a new history entry. The reader also permits the
  // native heading fragment if the link ran before this handler was attached.
  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    element("setup-heading").focus();
  });
  chrome.storage.onChanged.addListener(handleStorageChange);
  chrome.runtime.onMessage.addListener(message => { if (setupState?.stage === "dictionaries") installation.receive(message); });
  window.addEventListener("pagehide", installation.stop);
  window.addEventListener("pageshow", event => { if (event.persisted && setupState?.stage === "dictionaries") void requestInstall([]); });
  const stored = await chrome.storage.local.get([SETUP_STATE_KEY, "dictionaryState", "options"]);
  adoptSetupState(stored[SETUP_STATE_KEY]);
  adoptDictionaryState(stored.dictionaryState);
  adoptOptions(stored.options);
  if (setupError === null && setupState?.stage === "dictionaries") {
    // Reconnect first: a run started by an earlier page may still be active.
    await requestInstall(untouchedEntries().map((entry) => entry.sourceId));
  }
  if (setupError === null && setupState?.stage === "welcome") {
    await Promise.race([findSharedHachidori(), new Promise((resolveWait) => setTimeout(resolveWait, SHARED_LOOKUP_MS))]);
  }
  render();
}

try {
  await start();
} catch (error) {
  setupError = describe(error);
  render();
}
