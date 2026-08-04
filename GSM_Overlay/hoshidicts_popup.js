"use strict";

const {
  renderGlossaryContent,
  sanitizeDictionaryCss,
} = require("./hoshidicts_glossary_renderer.js");

const POPUP_MARGIN = 8;
const POPUP_GAP = 8;
const DEFAULT_POPUP_WIDTH = 460;
const DEFAULT_POPUP_HEIGHT = 620;
const MAX_RECURSIVE_TEXT = 256;

const STATE_MESSAGES = Object.freeze({
  loading: "Looking up dictionary results...",
  empty: "No dictionary result",
  "host-unavailable": "HoshiDicts is unavailable",
  "no-dictionaries": "No term dictionaries are enabled",
  "catalog-rebuilding": "Dictionary catalog is rebuilding",
  error: "Dictionary lookup failed",
});

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeWorkArea(workArea) {
  const width = Math.max(1, finiteNumber(workArea?.width, 1));
  const height = Math.max(1, finiteNumber(workArea?.height, 1));
  return {
    x: finiteNumber(workArea?.x, 0),
    y: finiteNumber(workArea?.y, 0),
    width,
    height,
  };
}

function computePopupPlacement(anchor, popupSize, workArea, options = {}) {
  const area = normalizeWorkArea(workArea);
  const margin = Math.max(0, finiteNumber(options.margin, POPUP_MARGIN));
  const gap = Math.max(0, finiteNumber(options.gap, POPUP_GAP));
  const width = Math.max(1, Math.min(
    finiteNumber(popupSize?.width, DEFAULT_POPUP_WIDTH),
    Math.max(1, area.width - margin * 2),
  ));
  const height = Math.max(1, Math.min(
    finiteNumber(popupSize?.height, DEFAULT_POPUP_HEIGHT),
    Math.max(1, area.height - margin * 2),
  ));
  const anchorX = finiteNumber(anchor?.x, area.x + margin);
  const anchorY = finiteNumber(anchor?.y, area.y + margin);
  const anchorHeight = Math.max(0, finiteNumber(anchor?.height, 0));
  const minimumLeft = area.x + margin;
  const maximumLeft = area.x + area.width - margin - width;
  const minimumTop = area.y + margin;
  const maximumTop = area.y + area.height - margin - height;

  const left = Math.min(Math.max(anchorX, minimumLeft), maximumLeft);
  const below = anchorY + anchorHeight + gap;
  const above = anchorY - gap - height;
  const top =
    below <= maximumTop
      ? below
      : above >= minimumTop
        ? above
        : Math.min(Math.max(below, minimumTop), maximumTop);
  return {
    left: Math.round(left),
    top: Math.round(top),
  };
}

function createTextElement(document, tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

class HoshiDictsPopup {
  constructor(options = {}) {
    this.document = options.document || globalThis.document;
    this.window = options.window || globalThis.window;
    if (!this.document || typeof this.document.createElement !== "function") {
      throw new TypeError("HoshiDictsPopup requires a DOM document");
    }
    this.resolveMedia =
      typeof options.resolveMedia === "function" ? options.resolveMedia : null;
    this.requestLookup =
      typeof options.requestLookup === "function" ? options.requestLookup : null;
    this.getWorkArea =
      typeof options.getWorkArea === "function"
        ? options.getWorkArea
        : () => ({
            x: 0,
            y: 0,
            width: this.window?.innerWidth || 1280,
            height: this.window?.innerHeight || 720,
          });
    this.maxHistory = Math.max(
      1,
      Math.min(32, Number(options.maxHistory) || 16),
    );
    this.recursiveLookupEnabled =
      options.recursiveLookupEnabled !== false;
    this.root = options.root || null;
    this.content = null;
    this.dictionaryStyleElement = null;
    this.state = "idle";
    this.generation = -1;
    this.model = null;
    this.entryIndex = 0;
    this.anchor = null;
    this.sourceSentence = "";
    this.selectedActionId = null;
    this.history = [];
    this.dictionaryStyles = [];
    this.boundReposition = () => this.reposition();
    this.window?.addEventListener?.("resize", this.boundReposition);
  }

  setLookupDispatcher(dispatcher) {
    this.requestLookup =
      typeof dispatcher === "function" ? dispatcher : null;
  }

  setRecursiveLookupEnabled(enabled) {
    this.recursiveLookupEnabled = enabled !== false;
    if (!this.recursiveLookupEnabled) {
      this.history = [];
    }
  }

  setMediaResolver(resolver) {
    this.resolveMedia =
      typeof resolver === "function" ? resolver : null;
  }

  mount() {
    if (this.root?.isConnected) {
      return this.root;
    }
    if (!this.root) {
      this.root = this.document.createElement("section");
      this.root.id = "hoshidicts-popup-root";
      this.root.className = "hoshidicts-popup interactive";
      this.root.setAttribute("role", "dialog");
      this.root.setAttribute("aria-label", "Dictionary results");
      this.root.setAttribute("aria-modal", "false");
      this.root.tabIndex = -1;
    }
    this.root.style.position = "fixed";
    this.root.style.display = "none";
    this.root.style.boxSizing = "border-box";
    this.root.addEventListener("dblclick", (event) => {
      if (!this.recursiveLookupEnabled) {
        return;
      }
      const target = event.target;
      if (!target?.closest?.(".hoshidicts-glossary-content")) {
        return;
      }
      const selected = this.window?.getSelection?.()?.toString()?.trim();
      if (selected) {
        void this.requestRecursiveLookup(selected);
      }
    });
    this.document.body.appendChild(this.root);
    return this.root;
  }

  #acceptGeneration(generation) {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      return false;
    }
    if (generation < this.generation) {
      return false;
    }
    this.generation = generation;
    return true;
  }

  #prepare(options = {}) {
    if (!this.#acceptGeneration(options.generation)) {
      return false;
    }
    this.mount();
    if (options.anchor) {
      this.anchor = {
        x: finiteNumber(options.anchor.x),
        y: finiteNumber(options.anchor.y),
        width: Math.max(0, finiteNumber(options.anchor.width)),
        height: Math.max(0, finiteNumber(options.anchor.height)),
      };
    }
    if (typeof options.sourceSentence === "string") {
      this.sourceSentence = options.sourceSentence;
    }
    this.root.style.display = "block";
    this.reposition();
    return true;
  }

  showLoading(options = {}) {
    if (!this.#prepare(options)) {
      return false;
    }
    this.state = "loading";
    this.#renderState("loading", options);
    return true;
  }

  showState(state, options = {}) {
    if (!Object.prototype.hasOwnProperty.call(STATE_MESSAGES, state)) {
      throw new TypeError(`Unknown HoshiDicts popup state: ${String(state)}`);
    }
    if (!this.#prepare(options)) {
      return false;
    }
    this.state = state;
    if (state !== "loading") {
      this.model = null;
      this.entryIndex = 0;
    }
    this.#renderState(state, options);
    return true;
  }

  #renderState(state, options) {
    this.root.replaceChildren();
    const container = createTextElement(
      this.document,
      "div",
      `hoshidicts-popup-state hoshidicts-popup-state-${state}`,
      STATE_MESSAGES[state],
    );
    container.setAttribute("role", "status");
    container.setAttribute("aria-live", state === "loading" ? "polite" : "assertive");
    if (options.errorCode) {
      container.dataset.errorCode = String(options.errorCode).slice(0, 128);
    }
    this.root.appendChild(container);
    this.reposition();
  }

  showResults(model, options = {}) {
    if (
      !model ||
      !Array.isArray(model.entries) ||
      model.entries.length === 0 ||
      !this.#prepare(options)
    ) {
      return false;
    }
    this.state = "results";
    this.model = model;
    const requestedEntryId =
      typeof options.entryId === "string" ? options.entryId : null;
    if (requestedEntryId) {
      const matchingIndex = model.entries.findIndex(
        (entry) => entry.id === requestedEntryId,
      );
      this.entryIndex = matchingIndex >= 0 ? matchingIndex : 0;
    } else {
      this.entryIndex = Math.min(
        Math.max(0, this.entryIndex),
        model.entries.length - 1,
      );
    }
    this.#renderResults();
    return true;
  }

  #availableActions() {
    if (!this.model?.entries?.length) {
      return [];
    }
    const actions = [
      {
        id: "hoshi-action:previous-entry",
        command: "previous-entry",
        label: "Previous entry",
      },
      {
        id: "hoshi-action:next-entry",
        command: "next-entry",
        label: "Next entry",
      },
    ];
    if (this.history.length > 0) {
      actions.push({
        id: "hoshi-action:recursive-back",
        command: "recursive-back",
        label: "Back",
      });
    }
    return actions;
  }

  #renderResults() {
    const entry = this.model.entries[this.entryIndex];
    this.root.replaceChildren();

    const toolbar = this.document.createElement("nav");
    toolbar.className = "hoshidicts-popup-actions";
    toolbar.setAttribute("aria-label", "Dictionary result actions");
    const actions = this.#availableActions();
    if (!actions.some((action) => action.id === this.selectedActionId)) {
      this.selectedActionId = actions[0]?.id || null;
    }
    for (const action of actions) {
      const button = this.document.createElement("button");
      button.type = "button";
      button.className = "hoshidicts-popup-action";
      button.dataset.actionId = action.id;
      button.setAttribute("aria-label", action.label);
      button.title = action.label;
      button.textContent =
        action.command === "previous-entry"
          ? "\u2039"
          : action.command === "next-entry"
            ? "\u203a"
            : "\u2190";
      button.addEventListener("click", () => {
        void this.command(action.command);
      });
      toolbar.appendChild(button);
    }
    const counter = createTextElement(
      this.document,
      "span",
      "hoshidicts-entry-counter",
      `${this.entryIndex + 1} / ${this.model.entries.length}`,
    );
    counter.setAttribute("aria-live", "polite");
    toolbar.appendChild(counter);
    this.root.appendChild(toolbar);

    const content = this.document.createElement("div");
    content.className = "hoshidicts-popup-scroll";
    content.tabIndex = 0;
    this.content = content;

    const heading = this.document.createElement("header");
    heading.className = "hoshidicts-entry-heading";
    heading.appendChild(
      createTextElement(
        this.document,
        "strong",
        "hoshidicts-expression",
        entry.expression,
      ),
    );
    if (entry.reading && entry.reading !== entry.expression) {
      heading.appendChild(
        createTextElement(
          this.document,
          "span",
          "hoshidicts-reading",
          entry.reading,
        ),
      );
    }
    content.appendChild(heading);

    if (entry.deinflectionReason) {
      content.appendChild(
        createTextElement(
          this.document,
          "div",
          "hoshidicts-deinflection",
          entry.deinflectionReason,
        ),
      );
    }
    if (entry.partOfSpeech?.length) {
      const tags = this.document.createElement("div");
      tags.className = "hoshidicts-term-tags";
      for (const tag of entry.partOfSpeech) {
        tags.appendChild(
          createTextElement(this.document, "span", "hoshidicts-tag", tag),
        );
      }
      content.appendChild(tags);
    }

    for (const dictionary of entry.dictionaries) {
      const section = this.document.createElement("section");
      section.className = "hoshidicts-dictionary";
      section.dataset.hoshiDictionaryId = dictionary.dictionaryId;
      section.setAttribute("aria-label", dictionary.displayTitle);
      section.appendChild(
        createTextElement(
          this.document,
          "h3",
          "hoshidicts-dictionary-title",
          dictionary.displayTitle,
        ),
      );
      if (dictionary.frequencies?.length) {
        section.appendChild(
          createTextElement(
            this.document,
            "div",
            "hoshidicts-frequency",
            `Frequency: ${dictionary.frequencies
              .map((frequency) => frequency.displayValue)
              .join(", ")}`,
          ),
        );
      }
      if (dictionary.pitches?.length) {
        section.appendChild(
          createTextElement(
            this.document,
            "div",
            "hoshidicts-pitch",
            `Pitch: ${dictionary.pitches.join(", ")}`,
          ),
        );
      }
      const list = this.document.createElement("ol");
      list.className = "hoshidicts-glossaries";
      for (const glossary of dictionary.glossaries || []) {
        const item = this.document.createElement("li");
        item.className = "hoshidicts-glossary";
        item.dataset.glossaryId = glossary.id;
        const rendered = renderGlossaryContent({
          document: this.document,
          content: glossary.content,
          dictionaryId: dictionary.dictionaryId,
          resolveMedia: this.resolveMedia,
        });
        item.appendChild(rendered.element);
        const allTags = [
          ...(glossary.definitionTags || []),
          ...(glossary.termTags || []),
        ];
        if (allTags.length) {
          const tags = this.document.createElement("div");
          tags.className = "hoshidicts-glossary-tags";
          for (const tag of allTags) {
            tags.appendChild(
              createTextElement(this.document, "span", "hoshidicts-tag", tag),
            );
          }
          item.appendChild(tags);
        }
        list.appendChild(item);
      }
      section.appendChild(list);
      content.appendChild(section);
    }
    this.root.appendChild(content);
    this.#appendDictionaryStyles();
    this.#syncActionSelection();
    this.reposition();
  }

  setDictionaryStyles(styles = []) {
    this.dictionaryStyles = Array.isArray(styles) ? styles.slice(0, 64) : [];
    if (this.state === "results") {
      this.#appendDictionaryStyles();
    }
  }

  #appendDictionaryStyles() {
    this.dictionaryStyleElement?.remove();
    const rules = [];
    for (const style of this.dictionaryStyles) {
      if (!style || typeof style !== "object") {
        continue;
      }
      const sanitized = sanitizeDictionaryCss(style.css, style.dictionary);
      if (sanitized.css) {
        rules.push(sanitized.css);
      }
    }
    if (!rules.length) {
      this.dictionaryStyleElement = null;
      return;
    }
    const element = this.document.createElement("style");
    element.className = "hoshidicts-dictionary-styles";
    element.textContent = rules.join("\n");
    this.root.prepend(element);
    this.dictionaryStyleElement = element;
  }

  #syncActionSelection() {
    for (const button of this.root.querySelectorAll("[data-action-id]")) {
      const selected = button.dataset.actionId === this.selectedActionId;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-current", selected ? "true" : "false");
    }
  }

  #moveEntry(delta) {
    if (!this.model?.entries?.length) {
      return { status: "ignored" };
    }
    const count = this.model.entries.length;
    this.entryIndex = (this.entryIndex + delta + count) % count;
    this.#renderResults();
    return {
      status: "handled",
      entryId: this.model.entries[this.entryIndex].id,
    };
  }

  #selectAction(direction) {
    const actions = this.#availableActions();
    if (!actions.length) {
      this.selectedActionId = null;
      return { status: "ignored" };
    }
    const current = actions.findIndex(
      (action) => action.id === this.selectedActionId,
    );
    const delta = direction === "previous" || direction === "up" ? -1 : 1;
    const index =
      current < 0 ? 0 : (current + delta + actions.length) % actions.length;
    this.selectedActionId = actions[index].id;
    this.#syncActionSelection();
    return { status: "handled", actionId: this.selectedActionId };
  }

  async #confirmAction() {
    const action = this.#availableActions().find(
      (candidate) => candidate.id === this.selectedActionId,
    );
    if (!action) {
      return { status: "ignored" };
    }
    return await this.command(action.command);
  }

  async requestRecursiveLookup(text) {
    if (
      !this.recursiveLookupEnabled ||
      !this.model ||
      typeof this.requestLookup !== "function"
    ) {
      return { status: "unsupported" };
    }
    const normalized = String(text || "").trim().slice(0, MAX_RECURSIVE_TEXT);
    if (!normalized) {
      return { status: "ignored" };
    }
    this.history.push({
      model: this.model,
      entryIndex: this.entryIndex,
      selectedActionId: this.selectedActionId,
      anchor: this.anchor,
      sourceSentence: this.sourceSentence,
      generation: this.generation,
    });
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
    try {
      return await this.requestLookup({
        text: normalized,
        anchor: this.anchor,
        recursive: true,
        preservePopup: true,
        sourceSentence: this.sourceSentence,
      });
    } catch (error) {
      const previous = this.history.pop();
      if (previous) {
        this.#restoreHistory(previous);
      }
      throw error;
    }
  }

  #restoreHistory(previous) {
    this.model = previous.model;
    this.entryIndex = previous.entryIndex;
    this.selectedActionId = previous.selectedActionId;
    this.anchor = previous.anchor;
    this.sourceSentence = previous.sourceSentence;
    this.state = "results";
    this.#renderResults();
  }

  async command(command, params = {}) {
    switch (command) {
      case "dismiss":
        this.dismiss(params.reason || "dismissed");
        return { status: "handled" };
      case "scroll": {
        const amount = finiteNumber(params.amount ?? params.delta, 160);
        this.content?.scrollBy?.({
          top: params.direction === "up" ? -Math.abs(amount) : Math.abs(amount),
          behavior: "auto",
        });
        return { status: "handled" };
      }
      case "select-action":
        return this.#selectAction(params.direction);
      case "reset-action-selection":
        this.selectedActionId = this.#availableActions()[0]?.id || null;
        this.#syncActionSelection();
        return { status: "handled", actionId: this.selectedActionId };
      case "clear-action-selection":
        this.selectedActionId = null;
        this.#syncActionSelection();
        return { status: "handled" };
      case "confirm-action":
        return await this.#confirmAction();
      case "next-entry":
        return this.#moveEntry(1);
      case "previous-entry":
        return this.#moveEntry(-1);
      case "recursive-back": {
        const previous = this.history.pop();
        if (!previous) {
          return { status: "ignored" };
        }
        this.#restoreHistory(previous);
        return { status: "handled", entryId: this.model.entries[this.entryIndex].id };
      }
      default:
        return { status: "unsupported" };
    }
  }

  reposition(workArea = this.getWorkArea()) {
    if (!this.root || !this.anchor || this.root.style.display === "none") {
      return null;
    }
    const area = normalizeWorkArea(workArea);
    const width = Math.min(
      DEFAULT_POPUP_WIDTH,
      Math.max(1, area.width - POPUP_MARGIN * 2),
    );
    const height = Math.min(
      DEFAULT_POPUP_HEIGHT,
      Math.max(1, area.height - POPUP_MARGIN * 2),
    );
    this.root.style.width = `${width}px`;
    this.root.style.maxWidth = `${area.width - POPUP_MARGIN * 2}px`;
    this.root.style.maxHeight = `${area.height - POPUP_MARGIN * 2}px`;
    const placement = computePopupPlacement(
      this.anchor,
      { width, height },
      area,
    );
    this.root.style.left = `${placement.left}px`;
    this.root.style.top = `${placement.top}px`;
    return placement;
  }

  dismiss(_reason = "dismissed") {
    if (!this.root) {
      return false;
    }
    this.root.style.display = "none";
    this.root.replaceChildren();
    this.state = "idle";
    this.model = null;
    this.content = null;
    this.entryIndex = 0;
    this.selectedActionId = null;
    this.history = [];
    return true;
  }

  destroy() {
    this.window?.removeEventListener?.("resize", this.boundReposition);
    this.root?.remove();
    this.root = null;
  }

  getSnapshot() {
    const entry = this.model?.entries?.[this.entryIndex] || null;
    return {
      state: this.state,
      generation: this.generation,
      visible: this.root?.style.display !== "none",
      entryIndex: this.entryIndex,
      entryId: entry?.id || null,
      selectedActionId: this.selectedActionId,
      historyDepth: this.history.length,
      recursiveLookupEnabled: this.recursiveLookupEnabled,
      sourceSentence: this.sourceSentence,
      anchor: this.anchor ? { ...this.anchor } : null,
    };
  }
}

module.exports = {
  HoshiDictsPopup,
  STATE_MESSAGES,
  computePopupPlacement,
};
