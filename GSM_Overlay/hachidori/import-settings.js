// SPDX-License-Identifier: GPL-3.0-or-later

// Settings → Dictionaries → Add dictionaries: Yomitan ZIP and MDX imports, the
// replace-or-install decision, the drop zone, the recommended installer and
// the import progress list.

import { LINKED_IMPORT_TARGET } from "./sharing-protocol.js";
import { uploadDictionary } from "./linked-import.js";
import {
  createDictionaryProgressList,
  installEntryState,
  formatSeconds,
} from "./dictionary-progress.js";
import { recommendedDictionaryInstalled } from "./managed-dictionary-source.js";
import {
  RECOMMENDED_DICTIONARIES, describeRecommendedCatalogue, packDictionaryItem, packDictionaryLinks,
} from "./recommended-dictionaries.js";
import { readDictionaryArchiveIdentity } from "./dictionary-import-archive.js";
import { IMPORT_ATTEMPTS, importWithRetries } from "./dictionary-import-attempts.js";
import { dictionaryImportError } from "./dictionary-import-errors.js";
import { recordUserError } from "./debug-log.js";
import {
  describeRevisionComparison,
  dictionaryImportMatches,
  dictionaryImportTarget,
  mdxImportNotes,
} from "./dictionary-import.js";
import {
  editedProfile, element, languageName, numberFormat, profileFields, recommendedInstallation, refreshStatus, send,
  setSectionStatus, sharingLinkedAddress, storedOptionsRecord, syncNavigationStatus, WORKER_TARGET,
} from "./settings.js";
import {
  dictionaries, libraryHasProfiles, moveToProfile, reloadDictionaries, setControlsDisabled, storedDictionaryState,
} from "./library-settings.js";

let importing = false; // NOSONAR: shared with the other Settings modules
let installingRecommended = false; // NOSONAR: shared with the other Settings modules
// The running batch's Cancel: it ends a wait at once and starts no further import.
let importAbort = null;
let renderedInstallRun = null;
let importProgress;
let importDragDepth = 0;
// Titles imported in this page's current batch, for the language hint below.
let importedTitles = [];
// Each pack's recommended dictionaries, from its vendored language.json.
const recommendedLinks = new Map();

function setImportState(message, tone, error = null) {
  setSectionStatus("import-state", message, tone, tone === "ready", error);
}

function clearImportResults() {
  importProgressView().clear();
}

function importProgressView() {
  if (importProgress) return importProgress;
  importProgress = createDictionaryProgressList({
    document,
    ariaLabel: "Dictionary import progress",
    idPrefix: "settings-import",
  });
  element("import-progress").appendChild(importProgress.element);
  return importProgress;
}

function setImportEntries(entries) {
  importProgressView().setEntries(entries);
}

// A failed row is kept in the debug log as the reader sees it, with `error`.
function updateImportResult(index, state, error = null) {
  importProgressView().update(String(index), state);
  if (state.tone === "error") recordUserError(window, "import-progress", state.text, error);
}

function importDuration(started) {
  return formatSeconds(Math.max(0, (Date.now() - started) / 1000));
}

function renderRecommendedCatalogue() {
  const { count, topics } = describeRecommendedCatalogue();
  element("recommended-dictionaries-hint").textContent =
    `${count[0].toUpperCase()}${count.slice(1)} trusted sources for ${topics}. Already installed sources are skipped.`;
  const list = element("recommended-dictionary-list");
  for (const entry of RECOMMENDED_DICTIONARIES) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.className = "recommended-dictionary-link";
    link.href = entry.publisherUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = entry.name;
    const description = document.createElement("span");
    description.textContent = entry.description;
    item.append(link, description);
    list.appendChild(item);
  }
}

function missingRecommendedDictionaries() {
  return RECOMMENDED_DICTIONARIES.filter((entry) => !recommendedDictionaryInstalled(entry, dictionaries));
}

function renderRecommendedActions() {
  // The catalogue is Japanese and installs into the Japanese profile; other
  // languages link to their recommended dictionaries (docs/languages.md 14).
  const japanese = editedProfile.language === "ja";
  const missing = japanese ? missingRecommendedDictionaries() : [];
  element("recommended-starter").hidden = missing.length === 0;
  element("install-recommended").hidden = missing.length < RECOMMENDED_DICTIONARIES.length;
  element("recommended-retry").hidden =
    missing.length === 0 || missing.length === RECOMMENDED_DICTIONARIES.length;
  void renderLanguageRecommendations();
}

async function packRecommendations(code) {
  if (!recommendedLinks.has(code)) {
    recommendedLinks.set(code, fetch(new URL(`vendor/languages/${code}/language.json`, document.baseURI))
      .then(response => (response.ok ? response.json() : null))
      .then(packDictionaryLinks)
      .catch(() => []));
  }
  return recommendedLinks.get(code);
}

// A pack's recommended dictionaries are links to their download pages; the
// user imports the file (decision record 0006).
async function renderLanguageRecommendations() {
  const code = editedProfile.language;
  const links = code === "ja" ? [] : await packRecommendations(code);
  if (editedProfile.language !== code) return;
  let block = element("recommended-language");
  if (links.length === 0) {
    block?.remove();
    return;
  }
  if (block === null) {
    block = document.createElement("div");
    block.className = "recommendations";
    block.id = "recommended-language";
    block.setAttribute("aria-labelledby", "recommended-language-heading");
    const head = document.createElement("div");
    head.className = "recommendations-head";
    const heading = document.createElement("h2");
    heading.id = "recommended-language-heading";
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Open a dictionary's page, download its Yomitan ZIP file and import it above.";
    head.append(heading, hint);
    const list = document.createElement("ul");
    list.className = "recommended-dictionary-list";
    list.id = "recommended-language-list";
    block.append(head, list);
    element("recommended-starter").after(block);
  }
  element("recommended-language-heading").textContent = `Recommended ${languageName(code)} dictionaries`;
  element("recommended-language-list").replaceChildren(...links.map(entry => packDictionaryItem(document, entry)));
}

// An import whose archive names another profile's language says so and offers
// Move to {Language} (docs/languages.md 14), while Multiple languages is on.
function renderLanguageMoves() {
  for (const offer of document.querySelectorAll(".import-language-move")) offer.remove();
  if (!libraryHasProfiles() || !globalThis.HDReaderOptions.languagesEnabled(storedOptionsRecord)) return;
  const profiles = globalThis.HDReaderOptions.profiles(storedOptionsRecord);
  for (const { title, index } of importedTitles) {
    const row = storedDictionaryState.dictionaries.find(entry => entry.title === title);
    const language = typeof row?.language === "string" ? row.language.toLowerCase().split("-")[0] : "";
    const target = profiles.find(profile => profile.language === language && profile.id !== editedProfile.id);
    const notes = element("import-progress")
      .querySelector(`.setup-dictionary[data-source-id="${CSS.escape(String(index))}"] .setup-dictionary-notes`);
    if (!target || !notes || !dictionaries.some(entry => entry.id === row?.id)) continue;
    notes.append(languageMoveOffer(row, target));
    notes.hidden = false;
  }
}

// One finished import's offer, among its entry's notes: the dictionary is for
// another profile's language, and Move to {Language} moves it there.
function languageMoveOffer(row, target) {
  const item = document.createElement("li");
  item.className = "import-language-move";
  const name = languageName(target.language);
  const text = document.createElement("span");
  text.textContent = `This dictionary is for ${name}. It was added to ${languageName()}.`;
  const move = document.createElement("button");
  move.type = "button";
  move.className = "ghost";
  move.textContent = `Move to ${name}`;
  move.addEventListener("click", () => {
    const focused = document.activeElement === move;
    move.disabled = true;
    void moveToProfile(row.id, target.id).then(error => {
      if (error === null) {
        text.textContent = `Moved to ${name}.`;
        if (focused) element("import-file").focus();
        move.remove();
      } else {
        text.textContent = `Could not move ${row.displayName || row.title}: ${error}`;
        move.disabled = false;
        if (focused) move.focus();
      }
    });
  });
  item.append(text, move);
  return item;
}

function elapsedSince(started) {
  const seconds = Math.round((Date.now() - started) / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function summariseReport(report) {
  const counts = [
    [report.termCount, "term", "terms"],
    [report.frequencyCount, "frequency entry", "frequency entries"],
    [report.pitchCount, "pitch entry", "pitch entries"],
    [report.kanjiCount, "kanji", "kanji"],
    [report.mediaCount, "media file", "media files"],
  ]
    .filter(([value]) => Number(value) > 0)
    .map(([value, singular, plural]) => `${numberFormat.format(value)} ${value === 1 ? singular : plural}`);
  return counts.length === 0 ? "no entries" : counts.join(", ");
}

function revisionLabel(value) {
  return value === null || value === "" ? "(missing)" : value;
}

function chooseDictionaryImport(identity, matches) {
  const dialog = element("import-decision-dialog");
  const target = element("import-decision-target");
  const imported = element("import-decision-imported");
  const installed = element("import-decision-installed");
  const description = element("import-decision-description");
  target.replaceChildren(...matches.map(({ dictionary }, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    const name = dictionary.displayName
      ? `${dictionary.displayName} (${dictionary.title})`
      : dictionary.title;
    option.textContent = `${name} — revision ${revisionLabel(dictionary.revision)}`
      + ` · ID ${dictionary.id.slice(0, 8)}`;
    return option;
  }));
  element("import-decision-target-row").hidden = matches.length === 1;
  imported.textContent = `${identity.title} — revision ${revisionLabel(identity.revision)}`;

  const renderTarget = () => {
    const match = matches[Number(target.value) || 0];
    installed.textContent = `${match.dictionary.displayName || match.dictionary.title}`
      + ` — revision ${revisionLabel(match.dictionary.revision)}`;
    description.textContent = describeRevisionComparison(
      identity.revision,
      match.dictionary.revision,
    );
  };
  target.value = "0";
  target.onchange = renderTarget;
  renderTarget();
  dialog.returnValue = "";

  return new Promise((resolve) => {
    const finish = () => {
      dialog.removeEventListener("cancel", cancel);
      const action = ["replace", "separate"].includes(dialog.returnValue)
        ? dialog.returnValue
        : "cancel";
      const match = matches[Number(target.value) || 0];
      target.onchange = null;
      resolve(action === "cancel" ? null : {
        action,
        identity,
        matchKind: match.kind,
        target: dictionaryImportTarget(match.dictionary),
      });
    };
    const cancel = (event) => {
      event.preventDefault();
      dialog.close("cancel");
    };
    dialog.addEventListener("close", finish, { once: true });
    dialog.addEventListener("cancel", cancel, { once: true });
    dialog.showModal();
  });
}

async function importFile(file, index, total, request = {}, label = file.name) {
  // The package joins the profile edited when the import starts (docs/languages.md 5.2).
  const target = profileFields();
  updateImportResult(index, { text: "Reading dictionary metadata…", progress: { value: null } });
  let identity;
  try {
    identity = await readDictionaryArchiveIdentity(file);
  } catch (error) {
    const failure = dictionaryImportError(error, file.name, "reading dictionary metadata");
    updateImportResult(index, { text: `Failed before import: ${failure.message}`, tone: "error" }, failure);
    return "failed";
  }

  const matches = dictionaryImportMatches(identity, dictionaries);
  let importDecision = {
    action: "install",
    identity,
    matchKind: null,
    target: null,
  };
  if (matches.length > 0) {
    importDecision = await chooseDictionaryImport(identity, matches);
    if (importDecision === null) {
      updateImportResult(index, {
        text: "Cancelled before import. Existing dictionary unchanged.",
      });
      return "cancelled";
    }
  }

  // The decision happens before this URL exists, so Cancel cannot start a
  // native import, create a generation, or mutate persistent storage.
  // A linked browser sends the archive to the host, which applies the same
  // choice against its own library (the one mirrored here).
  if (sharingLinkedAddress !== null) {
    return importArchive(() => uploadDictionary({
      blob: file, fileName: file.name, replace: importDecision.action === "replace",
      send: (type, fields) => send(type, fields, LINKED_IMPORT_TARGET),
    }), index, total, label);
  }
  const blobUrl = URL.createObjectURL(file);
  try {
    return await importArchive(() => send("hd_import", {
      blobUrl,
      fileName: file.name,
      ...request,
      importDecision,
      ...target,
    }), index, total, label);
  } finally {
    // The offscreen document has read the bytes by now; holding the URL any
    // longer just pins the file.
    URL.revokeObjectURL(blobUrl);
  }
}

// Why an attempt failed, from the engine's reply or the request's own error.
function failureReason({ reply, error }, label) {
  if (reply === undefined) return dictionaryImportError(error, label, "requesting the import").message;
  return dictionaryImportError(reply.error || reply.report?.error || "The engine gave no reason.", label,
    "importing the dictionary").message;
}

// Imports one archive once the engine is free, retrying a failed attempt
// (dictionary-import-attempts.js). The row says whether it is waiting for
// another change, importing or about to retry.
async function importArchive(runImport, index, total, label) {
  const { signal } = importAbort;
  // Until the first status poll says whether this archive waits or imports.
  let phase = "starting";
  let attempt = 1;
  let retryText = "";
  let since = Date.now();
  let firstAttemptAt = since;
  const tick = () => {
    if (phase === "starting") return;
    const elapsed = elapsedSince(since);
    const position = `(${index + 1} of ${total}) — ${index} of ${total} complete — ${elapsed} elapsed`;
    if (phase === "waiting") {
      setImportState(`Waiting to import ${label} ${position}`, "busy");
      updateImportResult(index, { text: `Waiting for the previous import to finish… ${elapsed} elapsed`,
        progress: { value: null } });
      return;
    }
    setImportState(signal.aborted ? `Cancelling after ${label} finishes importing — ${elapsed} elapsed`
      : `Importing ${label} ${position}`, "busy");
    const attemptLabel = attempt > 1 ? ` (attempt ${attempt} of ${IMPORT_ATTEMPTS})` : "";
    const text = phase === "retrying" ? retryText : `Importing${attemptLabel}… ${elapsed} elapsed`;
    updateImportResult(index, { text, progress: { value: null } });
  };
  const ticker = setInterval(tick, 1000);
  signal.addEventListener("abort", tick);

  let outcome;
  try {
    outcome = await importWithRetries({
      attempt: runImport,
      readStatus: () => send("hd_status"),
      readRevision: async () => {
        const reply = await send("hd_state_read", {}, WORKER_TARGET);
        if (!reply.ok) throw new Error(reply.error || "the dictionary state could not be read");
        return reply.state?.revision ?? 0;
      },
      signal,
      onWait: () => {
        if (phase === "waiting") return;
        phase = "waiting";
        since = Date.now();
        tick();
      },
      onAttempt: (number) => {
        phase = "importing";
        attempt = number;
        since = Date.now();
        if (number === 1) firstAttemptAt = since;
        tick();
      },
      onRetry: (number, failure) => {
        phase = "retrying";
        retryText = `Attempt ${number} of ${IMPORT_ATTEMPTS} failed: ${failureReason(failure, label)} Retrying…`;
        tick();
      },
    });
  } catch (error) {
    // Nothing was attempted: the wait was cancelled or the engine stayed busy.
    if (signal.aborted) {
      updateImportResult(index, { text: "Cancelled before import." });
      return "cancelled";
    }
    updateImportResult(index, { text: `Failed before import: ${error?.message ?? String(error)}`, tone: "error" },
      error);
    return "failed";
  } finally {
    clearInterval(ticker);
    signal.removeEventListener("abort", tick);
  }

  if (outcome.ok) {
    const { report } = outcome.reply;
    importedTitles.push({ title: report.title, index });
    // What an MDX import left out. Notes never turn a success into a
    // failure: the dictionary is installed and counts as imported.
    const notes = mdxImportNotes(report, numberFormat);
    updateImportResult(index, {
      text: `Imported ${report.title} in ${importDuration(since)}: ${summariseReport(report)}.`,
      tone: "ok",
      notes,
    });
    return notes.length > 0 ? "imported-with-notes" : "imported";
  }
  const duration = importDuration(firstAttemptAt);
  const spent = outcome.attempts > 1 ? `${outcome.attempts} attempts in ${duration}` : duration;
  // A request that threw keeps its Error in the debug log; an engine reply has none.
  const thrown = outcome.reply === undefined ? dictionaryImportError(outcome.error, label, "requesting the import") : null;
  updateImportResult(index, {
    text: `Failed after ${spent}: ${failureReason(outcome, label)}`,
    tone: "error",
  }, thrown);
  return "failed";
}

function renderRecommendedInstallation() {
  const { run, failed, pending } = recommendedInstallation;
  const wasInstalling = installingRecommended;
  installingRecommended = !failed && (run?.finished === false || pending?.installing === true);
  setControlsDisabled(importing);
  if (failed || importing) return;
  if (!run?.runId) {
    if (wasInstalling) setImportState("Installation was interrupted. Retry missing dictionaries.", "error");
    return;
  }
  if (renderedInstallRun !== run.runId) {
    renderedInstallRun = run.runId;
    clearImportResults();
    setImportEntries(run.entries.map(entry => {
      const source = RECOMMENDED_DICTIONARIES.find(source => source.sourceId === entry.sourceId);
      return { id: entry.sourceId, name: source?.name ?? entry.sourceId, purpose: source?.description ?? "" };
    }));
  }
  for (const entry of run.entries) importProgressView().update(entry.sourceId, installEntryState(entry));
  const failedCount = run.entries.filter(entry => entry.phase === "failed").length;
  const complete = run.entries.filter(entry => ["installed", "already-installed", "failed"].includes(entry.phase)).length;
  const total = run.entries.length;
  const label = total === 1 ? "recommended dictionary" : "recommended dictionaries";
  if (run.finished) {
    setImportState(`Finished ${total} of ${total} ${label} — ${total - failedCount} imported, ${failedCount} failed.`,
      failedCount ? "error" : "ready");
    if (wasInstalling) void reloadDictionaries().then(refreshStatus);
  } else {
    setImportState(`Installing recommended dictionaries — ${complete} of ${total} complete. You can close this page.`, "busy");
  }
  renderRecommendedActions();
}

// The batch's last line. #import-state is the polite live region, so it
// announces the notes.
function batchSummary({ total, imported, withNotes, cancelled, aborted, singular, plural }) {
  const failed = total - imported - cancelled;
  const itemLabel = total === 1 ? singular : plural;
  const importedLabel = withNotes === 0
    ? `${imported} imported`
    : `${imported} imported (${withNotes} with notes)`;
  const outcomes = [
    importedLabel,
    ...(cancelled === 0 ? [] : [`${cancelled} cancelled`]),
    `${failed} failed`,
  ].join(", ");
  return {
    text: aborted ? `Import cancelled — ${outcomes}.` : `Finished ${total} of ${total} ${itemLabel} — ${outcomes}.`,
    tone: failed === 0 ? "ready" : "error",
  };
}

async function runImportBatch(items, importOne, singular, plural, describeItem) {
  if (importing || installingRecommended) {
    return;
  }
  importing = true;
  importAbort = new AbortController();
  const { signal } = importAbort;
  setControlsDisabled(true);
  element("import-cancel").hidden = false;
  clearImportResults();
  importedTitles = [];
  renderLanguageMoves();
  setImportEntries(items.map((item, index) => ({
    id: String(index),
    ...describeItem(item),
  })));

  let imported = 0;
  let withNotes = 0;
  let cancelled = 0;
  try {
    for (const [index, item] of items.entries()) {
      // Cancel lets an import that has started finish, then starts no other.
      if (signal.aborted) {
        updateImportResult(index, { text: "Cancelled before import." });
        cancelled += 1;
        continue;
      }
      let outcome;
      try {
        outcome = await importOne(item, index, items.length); // NOSONAR: each import reviews and commits the state left by the previous item
      } catch (error) {
        const failure = dictionaryImportError(error, describeItem(item).name, "preparing the import");
        updateImportResult(index, { text: failure.message, tone: "error" }, failure);
        continue;
      }
      if (outcome === "imported" || outcome === "imported-with-notes") {
        imported += 1;
        if (outcome === "imported-with-notes") withNotes += 1;
        // A later archive in the same batch must decide against the state the
        // previous archive actually committed, not a delayed storage event.
        await reloadDictionaries(); // NOSONAR: the next archive is checked against the state this one committed
      } else if (outcome === "cancelled") cancelled += 1;
    }
    const { text, tone } = batchSummary({ total: items.length, imported, withNotes, cancelled,
      aborted: signal.aborted, singular, plural });
    setImportState(text, tone);
    await reloadDictionaries();
    renderLanguageMoves();
    await refreshStatus();
  } finally {
    importing = false;
    importAbort = null;
    const cancelFocused = document.activeElement === element("import-cancel");
    element("import-cancel").hidden = true;
    syncNavigationStatus("import-state");
    setControlsDisabled(false);
    // Hiding the focused Cancel would drop keyboard focus to the page.
    if (cancelFocused) element("import-file").focus();
  }
}

// An MDX dictionary is one .mdx plus the .mdd resource files named after its
// stem (`Dict.mdd`, `Dict.1.mdd`, ...; case does not matter), which the engine
// discovers as siblings. Every other file imports as a Yomitan ZIP, and a .mdd
// without its .mdx is reported rather than imported on its own.
function isMddResourceOf(mdxName, name) {
  const stem = mdxName.slice(0, -".mdx".length).toLowerCase();
  const lower = name.toLowerCase();
  return lower.startsWith(`${stem}.`) && /^(\d+\.)?mdd$/u.test(lower.slice(stem.length + 1));
}

function groupImportFiles(files) {
  // An upload carries one archive, so a linked browser sends every file as a
  // ZIP and the host explains why it refuses an .mdx or .mdd.
  if (sharingLinkedAddress !== null) return files.map((file) => ({ kind: "zip", file }));
  const items = [];
  const resourceFiles = files.filter((file) => /\.mdd$/iu.test(file.name));
  const claimed = new Set();
  for (const file of files) {
    if (/\.mdd$/iu.test(file.name)) continue;
    if (!/\.mdx$/iu.test(file.name)) {
      items.push({ kind: "zip", file });
      continue;
    }
    const resources = resourceFiles.filter((resource) => !claimed.has(resource) && isMddResourceOf(file.name, resource.name));
    for (const resource of resources) claimed.add(resource);
    items.push({ kind: "mdx", file, resources });
  }
  for (const resource of resourceFiles) {
    if (!claimed.has(resource)) items.push({ kind: "orphan-mdd", file: resource });
  }
  return items;
}

async function importMdx(item, index, total) {
  const { file, resources } = item;
  const target = profileFields();
  const urls = [file, ...resources].map((entry) => URL.createObjectURL(entry));
  try {
    return await importArchive(() => send("hd_import", {
      blobUrl: urls[0],
      fileName: file.name,
      resources: resources.map((resource, position) => ({ fileName: resource.name, blobUrl: urls[position + 1] })),
      ...target,
    }), index, total, file.name);
  } finally {
    for (const url of urls) URL.revokeObjectURL(url);
  }
}

async function importGroupedItem(item, index, total) {
  if (item.kind === "mdx") return importMdx(item, index, total);
  if (item.kind === "orphan-mdd") {
    updateImportResult(index, {
      text: "Not imported: choose this .mdd together with the .mdx it belongs to.",
      tone: "error",
    });
    return "failed";
  }
  return importFile(item.file, index, total);
}

function importItemPurpose(item) {
  if (item.kind === "orphan-mdd") return "MDD resource file";
  if (item.kind !== "mdx") return "Yomitan ZIP file";
  const count = item.resources.length;
  if (count === 0) return "MDX dictionary";
  return `MDX dictionary with ${count} MDD ${count === 1 ? "file" : "files"}`;
}

function describeImportItem(item) {
  return { name: item.file.name, purpose: importItemPurpose(item) };
}

function runImports(files) {
  const items = groupImportFiles(files);
  const onlyArchives = items.every((item) => item.kind === "zip");
  return runImportBatch(items, importGroupedItem, onlyArchives ? "archive" : "file",
    onlyArchives ? "archives" : "files", describeImportItem);
}

function hasDroppedFiles(event) {
  const transfer = event.dataTransfer;
  return (transfer?.files?.length ?? 0) > 0 || Array.from(transfer?.types ?? []).includes("Files");
}

function clearImportDropState() {
  importDragDepth = 0;
  element("import-drop-zone").classList.remove("is-dragging");
}

function bindImportDropZone(file) {
  const zone = element("import-drop-zone");
  zone.setAttribute("aria-disabled", String(file.disabled));
  zone.addEventListener("dragenter", (event) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    if (file.disabled || importing) return;
    importDragDepth += 1;
    zone.classList.add("is-dragging");
  });
  zone.addEventListener("dragover", (event) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    if (file.disabled || importing) return;
    event.dataTransfer.dropEffect = "copy";
    zone.classList.add("is-dragging");
  });
  zone.addEventListener("dragleave", () => {
    if (importDragDepth === 0) return;
    importDragDepth -= 1;
    if (importDragDepth === 0) zone.classList.remove("is-dragging");
  });
  zone.addEventListener("drop", (event) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    const dropped = [...(event.dataTransfer?.files ?? [])];
    clearImportDropState();
    if (!file.disabled && !importing && dropped.length > 0) {
      void runImports(dropped);
    }
  });
}

function installMissingRecommendedDictionaries() {
  const missing = missingRecommendedDictionaries();
  if (missing.length > 0 && !importing && !installingRecommended) {
    installingRecommended = true;
    setControlsDisabled(importing);
    void recommendedInstallation.request(missing.map(entry => entry.sourceId));
  }
}

function attachImportHandlers() {
  const file = element("import-file");
  file.addEventListener("change", () => {
    const picked = [...(file.files ?? [])];
    // Snapshot before clearing so picking the same batch again fires a change event.
    file.value = "";
    if (picked.length > 0) {
      void runImports(picked);
    }
  });
  element("import-cancel").addEventListener("click", () => importAbort?.abort());
  bindImportDropZone(file);
}

function attachRecommendedHandlers() {
  element("install-recommended").addEventListener("click", installMissingRecommendedDictionaries);
  element("empty-install-recommended").addEventListener("click", () => {
    window.location.hash = "add-dictionaries";
    installMissingRecommendedDictionaries();
  });
  element("empty-import-dictionaries").addEventListener("click", () => {
    window.location.hash = "add-dictionaries";
    element("import-file").click();
  });
  element("empty-clear-search").addEventListener("click", () => {
    const search = element("dict-search");
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.focus();
  });
  element("retry-recommended").addEventListener("click", installMissingRecommendedDictionaries);
}

// setControlsDisabled() resets the drag depth through this: an imported
// binding is read-only.
function setImportDragDepth(value) {
  importDragDepth = value;
}

export {
  attachImportHandlers, attachRecommendedHandlers, importing, installingRecommended, renderRecommendedActions,
  renderRecommendedCatalogue, renderRecommendedInstallation, setImportDragDepth, setImportState
};
