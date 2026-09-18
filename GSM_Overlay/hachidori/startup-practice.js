/* SPDX-License-Identifier: GPL-3.0-or-later */
import { createLocalFileAccessController } from "./local-file-access.js";

// One readiness decision supplies the page heading, probe precondition and
// practice recovery. A library with disabled terms needs enabling, not a reimport.
export function practiceReadiness(options, dictionaries, outcome = null, readerFailed = false) {
  const available = dictionaries.some(entry => entry.enabled !== false && entry.termCount > 0);
  if (!available) {
    const installed = dictionaries.some(entry => entry.termCount > 0);
    return {
      canProbe: false,
      heading: installed ? "Enable a dictionary to try Hachidori" : "Add a dictionary to try Hachidori",
      message: installed ? "Your term dictionaries are turned off. Enable one to look up Japanese words." : "Add a term dictionary to look up Japanese words. The recommended dictionaries are a good place to start.",
      href: installed ? "settings.html#dictionaries" : "settings.html#add-dictionaries",
      action: installed ? "Open Library" : "Add dictionaries",
    };
  }
  if (!options.hoverEnabled) {
    return { canProbe: false, heading: "Turn on lookups to try Hachidori",
      message: "Lookups are turned off. Enable them in Reading to try the sample.",
      href: "settings.html#lookup", action: "Open Reading" };
  }
  if (readerFailed || outcome === "unavailable") {
    return { canProbe: true, heading: "The lookup exercise is unavailable",
      message: readerFailed ? "The reader could not load. Reload this page, or review your reading settings." : "The dictionary engine could not answer. Reload this page, or review your reading settings.",
      href: "settings.html#lookup", action: "Open Reading" };
  }
  if (outcome === "missing") {
    return { canProbe: true, heading: "Add a dictionary for this sample",
      message: "The installed dictionaries do not have the words in this sample yet. Add another term dictionary to try it.",
      href: "settings.html#add-dictionaries", action: "Add dictionaries" };
  }
  return { canProbe: true, heading: outcome === "ready" || outcome === "passage" ? "You’re ready." : "Preparing your first lookup…" };
}

function practiceInstruction(options, enabled, probing, unavailable, shortcut) {
  if (enabled) {
    const ending = shortcut ? ", or use the lookup button." : ".";
    return options.lookupMode !== "hover"
      ? `Try looking up a word below. Hold ${options.activationKey} and hover over a word${ending}`
      : `Try looking up a word below. Hover over Japanese text${ending}`;
  }
  if (probing) return "Checking what the installed dictionaries can answer…";
  if (unavailable) {
    return options.lookupMode !== "hover"
      ? `Hold ${options.activationKey} and hover over Japanese text on any webpage to look it up.`
      : "Hover over Japanese text on any webpage to look it up.";
  }
  return "You can finish setup now and try a lookup later.";
}

// Keep the exercise's text nodes alive while options/inventory updates arrive:
// the ordinary reader anchors its selection, popup and Note draft to them.
export function createPracticeView({ document, onDismiss, loadReader, onReaderSettled = () => {} }) {
  const node = document.createElement("div");
  node.className = "setup-practice";
  node.innerHTML = `
    <p class="hint" id="setup-practice-instruction"></p>
    <section class="setup-practice-scene vn-scene" id="setup-practice-scene" aria-label="Visual novel practice scene">
      <div class="setup-practice-dialogue vn-dialogue" lang="ja">
        <p class="vn-speaker">ひなた</p>
        <p class="setup-practice-text vn-line" id="setup-practice-text" lang="ja" tabindex="-1">踏切の向こうから蝉の声が響く。喧騒を離れて路地に佇むと、古びた<span id="setup-practice-word">辞書</span>で見つけた言葉が、目の前の景色と少しずつ結びついていく。</p>
      </div>
    </section>
    <div class="setup-practice-tools" id="setup-practice-tools">
      <button type="button" class="ghost" id="setup-practice-lookup">Look up <span lang="ja">辞書</span></button>
      <span class="hint">You can also select text to look it up.</span>
    </div>
    <div class="setup-practice-recovery" id="setup-practice-recovery" hidden></div>
    <div id="setup-file-access"></div>`;
  const find = id => node.querySelector(`#${id}`);
  const instruction = find("setup-practice-instruction");
  const recovery = find("setup-practice-recovery");
  const lookup = find("setup-practice-lookup");
  const text = find("setup-practice-text");
  const recoveryMessage = document.createElement("p");
  recoveryMessage.className = "hint";
  const recoveryLink = document.createElement("a");
  recoveryLink.className = "primary-button";
  recovery.append(recoveryMessage, recoveryLink);
  let readerStarted = false;
  let readerFailed = false;
  let readerReady = false;
  let reader = null;
  let currentOptions;
  let currentDictionaries;
  let currentOutcome;

  function selectLookupWord() {
    // Selection is the reader's existing keyboard/precise-lookup route. No
    // synthetic lookup result or separate renderer is involved.
    text.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(find("setup-practice-word"));
    const selection = document.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    reader.scanSelectedText();
  }

  lookup.addEventListener("click", selectLookupWord);
  createLocalFileAccessController({ document, container: find("setup-file-access"), onDismiss });

  function startReader() {
    if (readerStarted) return;
    readerStarted = true;
    void loadReader().then((loadedReader) => {
      reader = loadedReader;
      readerReady = true;
      update(currentOptions, currentDictionaries, currentOutcome);
      onReaderSettled();
    }, () => {
      readerFailed = true;
      update(currentOptions, currentDictionaries, currentOutcome);
      onReaderSettled();
    });
  }

  function update(options, dictionaries, outcome = null) {
    currentOptions = options;
    currentDictionaries = dictionaries;
    currentOutcome = outcome;
    const available = dictionaries.some(entry => entry.enabled !== false && entry.termCount > 0);
    const readiness = practiceReadiness(options, dictionaries, outcome, readerFailed);
    const probing = readiness.canProbe && outcome === null;
    const answerable = outcome === "ready" || outcome === "passage";
    const enabled = available && options.hoverEnabled && answerable && !readerFailed;
    const lookupFocused = document.activeElement === lookup;
    const practiceFocused = lookupFocused || document.activeElement === text;
    const recoveryFocused = document.activeElement === recoveryLink;
    find("setup-practice-scene").hidden = !available || (options.hoverEnabled && !answerable);
    find("setup-practice-tools").hidden = !enabled;
    lookup.hidden = outcome !== "ready";
    lookup.disabled = !readerReady || lookup.hidden;
    recovery.hidden = enabled || probing;
    instruction.textContent = practiceInstruction(options, enabled, probing,
      available && options.hoverEnabled && outcome === "unavailable", !lookup.hidden);
    if (enabled) {
      startReader();
      if (recoveryFocused || (lookupFocused && lookup.hidden)) text.focus({ preventScroll: true });
    } else {
      recoveryLink.href = readiness.href ?? "settings.html#lookup";
      recoveryLink.textContent = readiness.action ?? "Open Reading";
      recoveryMessage.textContent = readiness.message ?? "";
      if (practiceFocused && !probing) recoveryLink.focus();
    }
    return readiness;
  }
  return {
    node,
    update,
    lookup() {
      if (lookup.disabled || lookup.hidden || !node.isConnected) return false;
      selectLookupWord();
      return true;
    },
  };
}
