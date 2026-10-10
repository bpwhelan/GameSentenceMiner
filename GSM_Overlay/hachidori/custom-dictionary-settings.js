// SPDX-License-Identifier: GPL-3.0-or-later

// Settings → Dictionaries → Personal dictionary: the source editor, its validation,
// and the revision-checked loads and saves of the source.

import { describeErrorOrJson } from "./error-text.js";
import {
  normaliseCustomDictionaryDocument,
  parseCustomDictionary,
} from "./custom-dictionary.js";
import {
  backingUp, element, send, setSectionStatus, syncNavigationStatus, WORKER_TARGET,
} from "./settings.js";
import {
  adoptDictionaryState, committing, removing, renderChangedDictionaryState, setControlsDisabled, stringValue,
} from "./library-settings.js";
import { importing, installingRecommended } from "./import-settings.js";
import { updating } from "./update-settings.js";

let customDocument = null;
let customBaseDocument = null;
let customBaseEditorText = "";
let customValidationTimer = null;
let customEditorLoaded = false; // NOSONAR: shared with the other Settings modules
let customLoading = false; // NOSONAR: shared with the other Settings modules
let customSaving = false; // NOSONAR: shared with the other Settings modules
let customDraftStale = false;
let customDraftNewline = "\n";

function setCustomDictionaryStatus(message, tone = "", completed = false) {
  setSectionStatus("custom-dictionary-status", message, tone, completed);
}

function renderCustomDictionaryErrors(errors) {
  const list = element("custom-dictionary-errors");
  const messages = (Array.isArray(errors) ? errors : []).map((error) =>
    `Line ${String(error?.lineNumber)}: ${stringValue(error?.reason, "invalid entry")}`);
  if (list.childElementCount === messages.length
      && messages.every((message, index) => list.children[index].textContent === message)) {
    return;
  }
  const items = document.createDocumentFragment();
  for (const message of messages) {
    const item = document.createElement("li");
    item.textContent = message;
    items.appendChild(item);
  }
  list.replaceChildren(items);
  list.hidden = list.childElementCount === 0;
}

function customDictionaryDirty() {
  return customEditorLoaded
    && customBaseDocument !== null
    && element("custom-dictionary-source").value !== customBaseEditorText;
}

function customDictionaryDraftSource() {
  // Textareas expose LF-normalized text; restore the document's newline only on save.
  const source = element("custom-dictionary-source").value;
  return customDraftNewline === "\r\n" ? source.replaceAll("\n", "\r\n") : source;
}

function renderCustomDictionaryControls() {
  const busy = importing || installingRecommended || updating || removing || committing || customLoading || customSaving || backingUp;
  const source = element("custom-dictionary-source");
  source.disabled = busy || !customEditorLoaded;
  element("custom-dictionary-save").disabled = busy
    || !customDictionaryDirty()
    || customDraftStale;
  element("custom-dictionary-reload").disabled = busy;
}

function cancelCustomDictionaryValidation() {
  clearTimeout(customValidationTimer);
  customValidationTimer = null;
}

function renderCustomDictionaryValidation(source = element("custom-dictionary-source").value) {
  cancelCustomDictionaryValidation();
  const parsed = parseCustomDictionary(source);
  renderCustomDictionaryErrors(parsed.errors);
  return parsed;
}

function resetCustomDictionaryDraft(documentValue) {
  customBaseDocument = documentValue;
  customDraftStale = false;
  customDraftNewline = documentValue.text.includes("\r\n") ? "\r\n" : "\n";
  element("custom-dictionary-source").value = documentValue.text;
  customBaseEditorText = element("custom-dictionary-source").value;
  renderCustomDictionaryValidation();
  renderCustomDictionaryControls();
}

function markCustomDictionaryStale() {
  customDraftStale = true;
  setCustomDictionaryStatus(
    "The custom dictionary source changed elsewhere. Reload the saved source before saving.",
    "error",
  );
  renderCustomDictionaryControls();
}

function adoptCustomDictionaryDocument(value) {
  const next = normaliseCustomDictionaryDocument(value);
  if (customDocument !== null && next.revision <= customDocument.revision) {
    return false;
  }
  const preserveDraft = customEditorLoaded
    && (customDictionaryDirty() || customDraftStale || customSaving);
  customDocument = next;
  if (!customEditorLoaded) {
    return true;
  }
  if (preserveDraft) {
    if (customBaseDocument === null || next.revision > customBaseDocument.revision) {
      markCustomDictionaryStale();
    }
  } else {
    resetCustomDictionaryDraft(next);
    setCustomDictionaryStatus("Loaded the newest saved source.", "ready");
  }
  return true;
}

function adoptCustomDictionaryState(value) {
  if (value === null || value === undefined) return;
  if (adoptDictionaryState(value)) {
    renderChangedDictionaryState();
  }
}

async function loadCustomDictionarySource() {
  if (customLoading || customSaving) return;
  cancelCustomDictionaryValidation();
  customLoading = true;
  setCustomDictionaryStatus("Loading the saved custom dictionary source…");
  renderCustomDictionaryControls();
  try {
    const reply = await send("hd_custom_read", {}, WORKER_TARGET);
    if (!reply.ok || reply.document === undefined) {
      throw new Error(reply.error || "the custom dictionary source could not be read");
    }
    adoptCustomDictionaryDocument(reply.document);
    adoptCustomDictionaryState(reply.state);
    if (customDocument === null) {
      throw new Error("the custom dictionary source reply was empty");
    }
    customEditorLoaded = true;
    resetCustomDictionaryDraft(customDocument);
    setCustomDictionaryStatus(`Loaded source revision ${customDocument.revision}.`, "ready", true);
  } catch (error) {
    setCustomDictionaryStatus(`Could not load the custom dictionary source: ${describeErrorOrJson(error)}`, "error");
  } finally {
    customLoading = false;
    syncNavigationStatus("custom-dictionary-status");
    renderCustomDictionaryControls();
  }
}

function customDictionarySavedMessage(reply, validCount, errorCount) {
  let message;
  if (reply.removed === true) {
    message = "Saved the source and removed the custom dictionary because it has no valid entries.";
  } else if (reply.rebuilt === false) {
    message = `Saved ${validCount} valid ${validCount === 1 ? "entry" : "entries"} without rebuilding.`;
  } else {
    message = `Saved ${validCount} valid ${validCount === 1 ? "entry" : "entries"} and rebuilt the custom dictionary.`;
  }
  if (errorCount > 0) {
    message += ` Skipped ${errorCount} malformed ${errorCount === 1 ? "line" : "lines"}.`;
  }
  return message;
}

async function saveCustomDictionarySource(event) {
  event.preventDefault();
  if (!customEditorLoaded || customLoading || customSaving || !customDictionaryDirty()) {
    return;
  }
  if (customDraftStale) {
    markCustomDictionaryStale();
    return;
  }

  const source = customDictionaryDraftSource();
  const parsed = renderCustomDictionaryValidation(source);
  const pending = {
    baseRevision: customBaseDocument.revision,
    source,
    parsed,
    editorText: element("custom-dictionary-source").value,
  };
  customSaving = true;
  setCustomDictionaryStatus("Saving and compiling the custom dictionary…");
  setControlsDisabled(importing);
  try {
    const reply = await send("hd_custom_save", {
      baseDocumentRevision: pending.baseRevision,
      text: pending.source,
    });
    if (reply.document !== undefined) {
      adoptCustomDictionaryDocument(reply.document);
    }
    adoptCustomDictionaryState(reply.state);
    renderCustomDictionaryErrors(reply.errors ?? pending.parsed.errors);
    if (!reply.ok) {
      if (reply.stale === true
          || (customDocument !== null && customDocument.revision > pending.baseRevision)) {
        markCustomDictionaryStale();
      }
      setCustomDictionaryStatus(
        `Could not save the custom dictionary: ${reply.error || "the source changed elsewhere"}`,
        "error",
      );
      return;
    }

    const saved = normaliseCustomDictionaryDocument(reply.document);
    if (saved.text !== pending.source) {
      throw new Error("the saved custom dictionary source did not match the submitted draft");
    }
    customBaseDocument = saved;
    customBaseEditorText = pending.editorText;
    const newerDocumentExists = customDocument !== null
      && (customDocument.revision > saved.revision
        || customDocument.text !== saved.text
        || customDocument.semanticRevision !== saved.semanticRevision);
    customDraftStale = newerDocumentExists;
    if (newerDocumentExists) {
      setCustomDictionaryStatus(
        "Saved this draft, but the source changed again elsewhere. Reload before saving.",
        "error",
      );
    } else {
      setCustomDictionaryStatus(
        customDictionarySavedMessage(reply, pending.parsed.entries.length, pending.parsed.errors.length),
        "ready",
        true,
      );
    }
  } catch (error) {
    setCustomDictionaryStatus(`Could not save the custom dictionary: ${describeErrorOrJson(error)}`, "error");
  } finally {
    customSaving = false;
    syncNavigationStatus("custom-dictionary-status");
    setControlsDisabled(importing);
  }
}

function attachCustomDictionaryHandlers() {
  element("custom-dictionary-form").addEventListener("submit", (event) => {
    void saveCustomDictionarySource(event);
  });
  element("custom-dictionary-reload").addEventListener("click", () => {
    void loadCustomDictionarySource();
  });
  element("custom-dictionary-source").addEventListener("input", () => {
    cancelCustomDictionaryValidation();
    if (customDraftStale) {
      markCustomDictionaryStale();
    } else {
      setCustomDictionaryStatus(customDictionaryDirty() ? "Unsaved changes." : "No unsaved changes.");
    }
    renderCustomDictionaryControls();
    // Keep full-document parsing and diagnostics off the typing path. Saving
    // cancels this preview and validates the exact submitted source immediately.
    customValidationTimer = setTimeout(() => {
      const parsed = renderCustomDictionaryValidation();
      if (customDraftStale || !customDictionaryDirty()) return;
      setCustomDictionaryStatus(
        `${parsed.entries.length} valid ${parsed.entries.length === 1 ? "entry" : "entries"} ready to save.`,
      );
    }, 150);
  });
}

function handleCustomDictionarySourceChange(change) {
  try {
    adoptCustomDictionaryDocument(change.newValue);
  } catch (error) {
    setCustomDictionaryStatus(`Could not read the changed custom dictionary source: ${describeErrorOrJson(error)}`, "error");
  }
}

export {
  adoptCustomDictionaryDocument, adoptCustomDictionaryState, attachCustomDictionaryHandlers,
  customDictionaryDirty, customEditorLoaded, customLoading, customSaving, handleCustomDictionarySourceChange,
  loadCustomDictionarySource, renderCustomDictionaryControls
};
