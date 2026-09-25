// SPDX-License-Identifier: GPL-3.0-or-later

// Group names and package aliases share an editing baseline, not the latest
// broad dictionary revision: unrelated presentation changes may be merged.
export function renameWithBaseline(items, id, field, baseName, name, validate = () => "") {
  const entry = items.find(item => item.id === id);
  if (!entry) return { error: "This item was removed elsewhere.", retryRequired: true };
  const current = entry[field] ?? "";
  if (current !== baseName && current !== name) {
    return { error: `The name changed elsewhere to “${current}”. Your draft is kept.`, retryRequired: true };
  }
  const error = validate(items, name, id);
  if (error) return { error, retryRequired: false };
  return { items: current === name ? items : items.map(item => item === entry
    ? { ...item, [field]: name || null } : item) };
}

export function createDictionaryNameDrafts({ delayMs, afterSave = () => {} }) {
  const drafts = new Map();
  const pending = draft => draft.dirty || draft.saving || draft.error !== "";

  function paint(draft) {
    const { input } = draft;
    if (input.value !== draft.value) input.value = draft.value;
    if (!draft.error) {
      draft.feedback?.remove();
      draft.feedback = null;
      input.removeAttribute("aria-invalid");
      return;
    }
    input.setAttribute("aria-invalid", "true");
    if (!draft.feedback) {
      const document = input.ownerDocument;
      const feedback = document.createElement("div");
      feedback.className = "name-draft-feedback";
      const output = document.createElement("output");
      output.setAttribute("role", "status");
      const actions = document.createElement("div");
      actions.className = "options-actions";
      for (const [className, label, action] of [
        ["name-draft-retry", "Retry my name", () => {
          const current = draft.readName();
          if (current === undefined) return;
          draft.baseName = current;
          draft.error = "";
          void flush(draft);
        }],
        ["name-draft-discard", "Use saved name", () => {
          clearTimeout(draft.timer);
          draft.timer = null;
          draft.value = draft.baseName = draft.readName() ?? "";
          draft.dirty = false;
          draft.error = "";
          paint(draft);
          afterSave();
        }],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `ghost ${className}`;
        button.textContent = label;
        button.addEventListener("click", action);
        actions.append(button);
      }
      feedback.append(output, actions);
      input.parentElement.after(feedback);
      draft.feedback = feedback;
    }
    draft.feedback.firstElementChild.textContent = draft.error;
  }

  async function flush(draft) {
    clearTimeout(draft.timer);
    draft.timer = null;
    if (draft.saving || draft.error || !draft.dirty) return;
    const name = draft.normalise(draft.value);
    draft.dirty = false;
    if (name === draft.baseName) {
      paint(draft);
      afterSave();
      return;
    }
    draft.saving = true;
    draft.retryRequired = true;
    paint(draft);
    try {
      const reply = await draft.save(draft.baseName, name);
      if (!reply.ok) {
        draft.retryRequired = reply.retryRequired !== false;
        throw new Error(reply.error ?? "The name was not saved. Your draft is kept.");
      }
      // The storage event may already contain a newer external name. Only our
      // own committed value can advance the queued draft's baseline.
      draft.baseName = name;
    } catch (error) {
      if (draft.retryRequired || !draft.dirty) draft.error = error.message;
      draft.dirty = true;
    } finally {
      draft.saving = false;
      paint(draft);
      if (drafts.get(draft.key) === draft && draft.timer === null) void flush(draft);
      afterSave();
    }
  }

  function bind(key, input, options) {
    let draft = drafts.get(key);
    if (!draft || !pending(draft)) {
      draft = { key, value: options.value, baseName: options.value, dirty: false,
        saving: false, timer: null, error: "", feedback: null };
      drafts.set(key, draft);
    }
    draft.feedback?.remove();
    Object.assign(draft, options, { input, value: pending(draft) ? draft.value : options.value, feedback: null });
    paint(draft);
    const edit = immediate => {
      draft.value = input.value;
      draft.dirty = true;
      if (!draft.retryRequired) {
        draft.error = "";
        paint(draft);
      }
      clearTimeout(draft.timer);
      draft.timer = null;
      if (immediate) void flush(draft);
      else if (!draft.error) draft.timer = setTimeout(() => { void flush(draft); }, delayMs);
    };
    input.addEventListener("input", () => edit(false));
    input.addEventListener("change", () => edit(true));
    input.addEventListener("blur", () => { void flush(draft); });
  }

  function retain(keys) {
    for (const [key, draft] of drafts) {
      if (keys.has(key)) continue;
      clearTimeout(draft.timer);
      drafts.delete(key);
    }
  }

  return { bind, retain, hasPendingChanges: () => [...drafts.values()].some(pending),
    hasInFlightSave: () => [...drafts.values()].some(draft => draft.saving),
    dispose: () => retain(new Set()) };
}
