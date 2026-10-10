// SPDX-License-Identifier: GPL-3.0-or-later

// Settings → Reading → lookup counts: Reset lookup counts, and the definition
// blur rules that read the counts, Anki maturity and frequency.

import { describeErrorOrJson } from "./error-text.js";
import {
  clampOption, definitionBlurFrequencyDictionary, element, options, send, setSectionStatus,
  sharingLinkedAddress, WORKER_TARGET,
} from "./settings.js";
import { dictionaries, dictionaryLabel } from "./library-settings.js";
import {
  isAvailableFrequencyDictionary, selectedFrequencyDictionary, setOptionsStatus, writeOptions,
} from "./option-settings.js";

let resettingLookupCounts = false;

// The dictionary the blur threshold reads: its own choice, or "Same as sorting".
function selectedDefinitionBlurFrequencyDictionary(title = definitionBlurFrequencyDictionary(options)) {
  return dictionaries.find((dictionary) => dictionary.title === title
    && isAvailableFrequencyDictionary(dictionary));
}

function renderLookupCountsReset() {
  element("lookup-counts-reset").disabled = resettingLookupCounts || sharingLinkedAddress !== null;
}

function renderDefinitionBlurFrequencyChoices() {
  const select = element("opt-blur-frequency-dictionary");
  if (select === document.activeElement) return;
  const previous = options.definitionBlurFrequencyDictionary;
  select.disabled = !options.definitionBlurFrequencyEnabled;
  const sorting = selectedFrequencyDictionary();
  select.replaceChildren(new Option(sorting ? `Same as sorting (${dictionaryLabel(sorting)})` : "Same as sorting", ""));
  const available = dictionaries.filter(isAvailableFrequencyDictionary);
  for (const dictionary of available) select.add(new Option(dictionaryLabel(dictionary), dictionary.title));
  if (previous !== "" && !available.some(dictionary => dictionary.title === previous)) {
    const known = dictionaries.find(dictionary => dictionary.title === previous);
    const status = known?.enabled === false ? "disabled" : "unavailable";
    const stale = new Option(`${known ? dictionaryLabel(known) : previous} (${status})`, previous);
    stale.disabled = true;
    select.add(stale);
  }
  select.value = previous;
}

// All blur rules use the shared reveal controls. The delay field shows
// seconds, fractions allowed, for the stored milliseconds.
function renderDefinitionBlurControls() { // NOSONAR: existing complexity, kept as it was by the #533 split
  const countEnabled = options.definitionBlurCountEnabled;
  const ankiEnabled = options.definitionBlurAnkiMature;
  const frequencyEnabled = options.definitionBlurFrequencyEnabled;
  const enabled = countEnabled || ankiEnabled || frequencyEnabled;
  for (const [id, checked] of [["opt-blur-count", countEnabled], ["opt-blur-anki", ankiEnabled],
    ["opt-blur-frequency", frequencyEnabled]]) element(id).checked = checked;
  // Hiding a focused native control can emit blur before its pending change.
  // Defer hiding until focusout so the change keeps its captured revision.
  for (const [id, hidden] of [["definition-blur-count-controls", !countEnabled],
    ["definition-blur-frequency-controls", !frequencyEnabled], ["definition-blur-reveal-controls", !enabled],
    ["definition-blur-delay-control", options.definitionBlurReveal !== "timed"]]) {
    const group = element(id);
    if (!hidden || !group.contains(document.activeElement)) group.hidden = hidden;
  }
  element("definition-blur-count-paused").hidden = !countEnabled || options.showLookupCounts;
  element("definition-blur-anki-help").hidden = !ankiEnabled;
  element("definition-blur-any-help").hidden = [countEnabled, ankiEnabled, frequencyEnabled].filter(Boolean).length < 2;
  element("definition-blur-help").hidden = !enabled;
  renderDefinitionBlurFrequencyChoices();
  for (const [id, key, controlEnabled] of [["opt-blur-direction", "definitionBlurDirection", countEnabled],
    ["opt-blur-frequency-order", "definitionBlurFrequencyOrder", frequencyEnabled],
    ["opt-blur-frequency-threshold", "definitionBlurFrequencyThreshold", frequencyEnabled],
    ["opt-blur-reveal", "definitionBlurReveal", enabled], ["opt-blur-threshold", "definitionBlurThreshold", countEnabled]]) {
    const control = element(id);
    if (control === document.activeElement) continue;
    control.value = String(options[key]);
    control.disabled = !controlEnabled;
  }
  const delay = element("opt-blur-delay");
  if (delay !== document.activeElement) {
    delay.value = String(options.definitionBlurDelayMs / 1000);
    delay.disabled = !enabled || options.definitionBlurReveal !== "timed";
  }
  const frequencyHelp = element("definition-blur-frequency-help");
  frequencyHelp.hidden = !frequencyEnabled;
  if (frequencyEnabled) {
    const selected = selectedDefinitionBlurFrequencyDictionary();
    if (!definitionBlurFrequencyDictionary(options)) {
      frequencyHelp.textContent = "Sorting compares every frequency dictionary, so choose one here. Missing frequency data leaves this condition unqualified.";
    } else if (!selected) {
      frequencyHelp.textContent = "The saved frequency dictionary is unavailable. This condition fails open until it is enabled or reinstalled.";
    } else {
      const automatic = options.definitionBlurFrequencyOrder === "auto";
      const order = automatic && selected.frequencyMode === "rank-based"
        ? "ascending" : automatic ? "descending" : options.definitionBlurFrequencyOrder; // NOSONAR: existing nested ternary, kept by the #533 split
      const mode = automatic
        ? selected.frequencyMode === "rank-based" ? "rank-based metadata" // NOSONAR: existing nested ternary, kept by the #533 split
          : selected.frequencyMode === "occurrence-based" ? "occurrence-based metadata" : "undeclared metadata" // NOSONAR: existing nested ternary, kept by the #533 split
        : "your manual order";
      frequencyHelp.textContent = order === "ascending"
        ? `Using ${mode}: values at or below the threshold qualify.`
        : `Using ${mode}: values at or above the threshold qualify.`;
    }
  }
}

// Settings → Reading → Reset lookup counts: a new, empty history generation.
async function resetLookupCounts() {
  if (!window.confirm("Reset lookup counts for every word? Each word starts again from zero, and its next lookup "
    + "counts as 1. Dictionaries, settings and Anki notes are not changed, and existing backups keep the earlier counts.")) {
    return;
  }
  resettingLookupCounts = true;
  renderLookupCountsReset();
  setSectionStatus("lookup-counts-reset-status", "Resetting lookup counts…", "working");
  try {
    const reply = await send("hd_lookup_stats_reset", {}, WORKER_TARGET);
    if (!reply.ok) throw new Error(reply.error || "the lookup counts could not be reset");
    setSectionStatus("lookup-counts-reset-status", "Lookup counts reset.", "ready", true);
  } catch (error) {
    setSectionStatus("lookup-counts-reset-status", `Could not reset lookup counts: ${describeErrorOrJson(error)}`, "error");
  } finally {
    resettingLookupCounts = false;
    renderLookupCountsReset();
  }
}

function attachDefinitionBlurHandlers() {
  for (const [id, key] of [["opt-blur-count", "definitionBlurCountEnabled"],
    ["opt-blur-anki", "definitionBlurAnkiMature"],
    ["opt-blur-frequency", "definitionBlurFrequencyEnabled"]]) {
    element(id).addEventListener("change", (event) => {
      options[key] = event.target.checked;
      renderDefinitionBlurControls();
      writeOptions();
    });
  }
  element("opt-blur-frequency-dictionary").addEventListener("change", (event) => {
    if (event.target.value && !selectedDefinitionBlurFrequencyDictionary(event.target.value)) {
      event.target.value = options.definitionBlurFrequencyDictionary;
      setOptionsStatus("That frequency dictionary is no longer available.");
      return;
    }
    options.definitionBlurFrequencyDictionary = event.target.value;
    renderDefinitionBlurControls();
    writeOptions();
  });
  element("opt-blur-delay").addEventListener("change", (event) => {
    options.definitionBlurDelayMs = clampOption("definitionBlurDelayMs", Math.round(Number(event.target.value) * 1000));
    event.target.value = String(options.definitionBlurDelayMs / 1000);
    writeOptions();
  });
}

export {
  attachDefinitionBlurHandlers, renderDefinitionBlurControls, renderDefinitionBlurFrequencyChoices,
  renderLookupCountsReset, resetLookupCounts
};
