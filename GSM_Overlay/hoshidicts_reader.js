/*
 * Hoshidicts reader for the GSM overlay.
 *
 * Popup structure and furigana segmentation are adapted from Hoshi Reader:
 * https://github.com/Manhhao/Hoshi-Reader/tree/c31c9d0ce376ff83bf6a91d908bf9f8e0fb4947b/Features/Popup
 *
 * Copyright (C) 2026 Manhhao
 * Copyright (C) 2023-2026 Yomitan Authors
 * Copyright (C) 2021-2022 Yomichan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.GSMHoshidictsReader = api;
  }
}(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const LOOKUP_DEBOUNCE_MS = 20;
  const LOOKUP_SCAN_LENGTH = 10;
  const LOOKUP_MAX_RESULTS = 16;
  const MAX_RESPONSE_BYTES = 256 * 1024;
  const MAX_GLOSSARIES = 64;
  const MAX_TRACE_STEPS = 32;
  const MAX_TEXT_LENGTH = 128 * 1024;
  const MAX_STRUCTURED_DEPTH = 24;
  const MAX_STRUCTURED_NODES = 4096;
  const RECONNECT_DELAY_MS = 750;
  const JAPANESE_TEXT_PATTERN =
    /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
  const KANJI_SEGMENT_PATTERN =
    /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005]+|[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005]+/gu;
  const KANA_PATTERN = /[\u3040-\u30ff\uff66-\uff9f]/u;
  const ALLOWED_STRUCTURED_TAGS = new Set([
    "br",
    "code",
    "div",
    "em",
    "li",
    "ol",
    "p",
    "rp",
    "rt",
    "ruby",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
  ]);
  const IGNORED_STRUCTURED_TAGS = new Set([
    "a",
    "audio",
    "button",
    "canvas",
    "iframe",
    "img",
    "input",
    "script",
    "source",
    "style",
    "svg",
    "video",
  ]);

  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function boundedString(value, maxLength = MAX_TEXT_LENGTH) {
    return typeof value === "string" ? value.slice(0, maxLength) : "";
  }

  function normalizeLookupResults(payload) {
    if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.results)) {
      return [];
    }

    let glossaryCount = 0;
    return payload.results.slice(0, LOOKUP_MAX_RESULTS).map((rawResult) => {
      const result = isRecord(rawResult) ? rawResult : {};
      const rawTerm = isRecord(result.term) ? result.term : {};
      const trace = Array.isArray(result.trace)
        ? result.trace.slice(0, MAX_TRACE_STEPS).map((rawStep) => {
            const step = isRecord(rawStep) ? rawStep : {};
            return {
              name: boundedString(step.name, 1024),
              description: boundedString(step.description, 4096),
            };
          }).filter((step) => step.name.length > 0)
        : [];
      const remainingGlossaries = Math.max(0, MAX_GLOSSARIES - glossaryCount);
      const glossaries = Array.isArray(rawTerm.glossaries)
        ? rawTerm.glossaries.slice(0, remainingGlossaries).map((rawGlossary) => {
            const glossary = isRecord(rawGlossary) ? rawGlossary : {};
            return {
              dictionary: boundedString(glossary.dictionary, 4096) || "Dictionary",
              glossary: boundedString(glossary.glossary),
              definitionTags: boundedString(glossary.definitionTags, 4096),
              termTags: boundedString(glossary.termTags, 4096),
            };
          })
        : [];
      glossaryCount += glossaries.length;

      return {
        matched: boundedString(result.matched, 4096),
        deinflected: boundedString(result.deinflected, 4096),
        trace,
        preprocessorSteps: Number.isFinite(result.preprocessorSteps)
          ? Math.trunc(result.preprocessorSteps)
          : 0,
        term: {
          expression: boundedString(rawTerm.expression, 4096),
          reading: boundedString(rawTerm.reading, 4096),
          rules: boundedString(rawTerm.rules, 4096),
          score: Number.isFinite(rawTerm.score) ? Math.trunc(rawTerm.score) : 0,
          glossaries,
        },
      };
    }).filter((result) => result.term.expression.length > 0);
  }

  function toHiragana(text) {
    return String(text || "").replace(
      /[\u30a1-\u30f6]/gu,
      (character) => String.fromCharCode(character.charCodeAt(0) - 0x60)
    );
  }

  function createFuriganaSegment(text, reading) {
    return { text, reading };
  }

  function getFuriganaKanaSegments(text, reading) {
    const newSegments = [];
    let start = 0;
    let state = reading[0] === text[0];
    for (let index = 1; index < text.length; index += 1) {
      const nextState = reading[index] === text[index];
      if (state === nextState) {
        continue;
      }
      newSegments.push(
        createFuriganaSegment(
          text.substring(start, index),
          state ? "" : reading.substring(start, index)
        )
      );
      state = nextState;
      start = index;
    }
    newSegments.push(
      createFuriganaSegment(
        text.substring(start),
        state ? "" : reading.substring(start)
      )
    );
    return newSegments;
  }

  function segmentizeFurigana(reading, normalizedReading, groups, groupStart) {
    const groupCount = groups.length - groupStart;
    if (groupCount <= 0) {
      return reading.length === 0 ? [] : null;
    }

    const group = groups[groupStart];
    if (group.isKana) {
      if (
        group.normalizedText !== null &&
        normalizedReading.startsWith(group.normalizedText)
      ) {
        const segments = segmentizeFurigana(
          reading.substring(group.text.length),
          normalizedReading.substring(group.text.length),
          groups,
          groupStart + 1
        );
        if (segments !== null) {
          if (reading.startsWith(group.text)) {
            segments.unshift(createFuriganaSegment(group.text, ""));
          } else {
            segments.unshift(...getFuriganaKanaSegments(group.text, reading));
          }
          return segments;
        }
      }
      return null;
    }

    let result = null;
    for (let index = reading.length; index >= group.text.length; index -= 1) {
      const segments = segmentizeFurigana(
        reading.substring(index),
        normalizedReading.substring(index),
        groups,
        groupStart + 1
      );
      if (segments !== null) {
        if (result !== null) {
          return null;
        }
        segments.unshift(
          createFuriganaSegment(group.text, reading.substring(0, index))
        );
        result = segments;
      }
      if (groupCount === 1) {
        break;
      }
    }
    return result;
  }

  function segmentFurigana(expression, reading) {
    if (!reading || reading === expression) {
      return [{ text: expression, reading: "" }];
    }

    const groups = [];
    const matches = String(expression).match(KANJI_SEGMENT_PATTERN) || [];
    for (const text of matches) {
      const isKana = KANA_PATTERN.test(text[0]);
      groups.push({
        isKana,
        text,
        normalizedText: isKana ? toHiragana(text) : null,
      });
    }

    const segments = segmentizeFurigana(
      reading,
      toHiragana(reading),
      groups,
      0
    );
    return segments === null
      ? [{ text: expression, reading }]
      : segments;
  }

  function appendExpressionRuby(documentRef, parent, expression, reading) {
    for (const segment of segmentFurigana(expression, reading)) {
      if (!segment.reading) {
        parent.appendChild(documentRef.createTextNode(segment.text));
        continue;
      }
      const ruby = documentRef.createElement("ruby");
      ruby.appendChild(documentRef.createTextNode(segment.text));
      const rt = documentRef.createElement("rt");
      rt.textContent = segment.reading;
      ruby.appendChild(rt);
      parent.appendChild(ruby);
    }
  }

  function parseTagList(value) {
    return String(value || "").split(/\s+/u).filter(Boolean);
  }

  function appendStructuredValue(documentRef, parent, value, state, depth) {
    if (state.nodes >= MAX_STRUCTURED_NODES || depth > MAX_STRUCTURED_DEPTH) {
      return;
    }
    if (typeof value === "string") {
      state.nodes += 1;
      parent.appendChild(documentRef.createTextNode(value.slice(0, MAX_TEXT_LENGTH)));
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      state.nodes += 1;
      parent.appendChild(documentRef.createTextNode(String(value)));
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        appendStructuredValue(documentRef, parent, child, state, depth + 1);
        if (state.nodes >= MAX_STRUCTURED_NODES) {
          break;
        }
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }

    const tag = typeof value.tag === "string" ? value.tag.toLowerCase() : "";
    if (IGNORED_STRUCTURED_TAGS.has(tag)) {
      return;
    }
    if (!ALLOWED_STRUCTURED_TAGS.has(tag)) {
      if (Object.prototype.hasOwnProperty.call(value, "content")) {
        appendStructuredValue(documentRef, parent, value.content, state, depth + 1);
      }
      return;
    }

    const element = documentRef.createElement(tag);
    state.nodes += 1;
    if (
      typeof value.lang === "string" &&
      /^[A-Za-z0-9-]{1,35}$/u.test(value.lang)
    ) {
      element.setAttribute("lang", value.lang);
    }
    if (tag === "td" || tag === "th") {
      for (const [property, attribute] of [
        ["colSpan", "colspan"],
        ["rowSpan", "rowspan"],
      ]) {
        const span = Number(value[property]);
        if (Number.isInteger(span) && span >= 1 && span <= 32) {
          element.setAttribute(attribute, String(span));
        }
      }
    }
    if (tag !== "br" && Object.prototype.hasOwnProperty.call(value, "content")) {
      appendStructuredValue(documentRef, element, value.content, state, depth + 1);
    }
    parent.appendChild(element);
  }

  function appendTextOnlyGlossary(documentRef, parent, rawGlossary) {
    const value = boundedString(rawGlossary);
    if (!value) {
      return;
    }
    let parsed = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      // Plain glossary strings are rendered literally, including any HTML-like text.
    }
    appendStructuredValue(
      documentRef,
      parent,
      parsed,
      { nodes: 0 },
      0
    );
  }

  function calculatePopupPosition(anchorRect, popupSize, viewport, options = {}) {
    const gap = Number.isFinite(options.gap) ? options.gap : 4;
    const padding = Number.isFinite(options.padding) ? options.padding : 6;
    const width = Math.min(
      Math.max(1, popupSize.width),
      Math.max(1, viewport.width - padding * 2)
    );
    const height = Math.min(
      Math.max(1, popupSize.height),
      Math.max(1, viewport.height - padding * 2)
    );
    const clamp = (value, minimum, maximum) =>
      Math.max(minimum, Math.min(value, maximum));

    let left;
    let top;
    if (options.vertical) {
      const spaceRight = viewport.width - anchorRect.right - gap;
      const spaceLeft = anchorRect.left - gap;
      left = spaceRight >= width || spaceRight >= spaceLeft
        ? anchorRect.right + gap
        : anchorRect.left - gap - width;
      top = anchorRect.top;
    } else {
      const spaceBelow = viewport.height - anchorRect.bottom - gap;
      const spaceAbove = anchorRect.top - gap;
      top = spaceBelow >= height || spaceBelow >= spaceAbove
        ? anchorRect.bottom + gap
        : anchorRect.top - gap - height;
      left = anchorRect.left;
    }

    return {
      left: Math.round(clamp(left, padding, viewport.width - width - padding)),
      top: Math.round(clamp(top, padding, viewport.height - height - padding)),
      width,
      height,
    };
  }

  function getUtf16OffsetForPoint(windowRef, element, clientX, clientY) {
    const text = element.textContent || "";
    const characters = Array.from(text);
    if (characters.length <= 1) {
      return 0;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return 0;
    }
    const vertical = windowRef.getComputedStyle(element).writingMode.startsWith("vertical");
    const ratio = vertical
      ? (clientY - rect.top) / rect.height
      : (clientX - rect.left) / rect.width;
    const characterIndex = Math.max(
      0,
      Math.min(characters.length - 1, Math.floor(ratio * characters.length))
    );
    return characters.slice(0, characterIndex).join("").length;
  }

  function sliceCodePoints(text, utf16Offset, count) {
    return Array.from(text.slice(utf16Offset)).slice(0, count).join("");
  }

  function resolveLookupCandidate(windowRef, documentRef, eventTarget, clientX, clientY) {
    if (!(eventTarget instanceof windowRef.Element)) {
      return null;
    }
    const textBox = eventTarget.closest('.text-box[data-selectable="true"]');
    if (textBox) {
      const block = textBox.closest(".text-block-container");
      const boxes = block
        ? Array.from(block.querySelectorAll('.text-box[data-selectable="true"]'))
        : [textBox];
      let sentence = "";
      let matchOffset = 0;
      for (const box of boxes) {
        const boxText = box.textContent || "";
        if (box === textBox) {
          matchOffset = sentence.length +
            getUtf16OffsetForPoint(windowRef, box, clientX, clientY);
        }
        sentence += boxText;
      }
      const query = sliceCodePoints(sentence, matchOffset, LOOKUP_SCAN_LENGTH);
      if (!query || !JAPANESE_TEXT_PATTERN.test(query)) {
        return null;
      }
      return {
        anchor: textBox,
        sentence,
        matchOffset,
        query,
        vertical: windowRef.getComputedStyle(textBox).writingMode.startsWith("vertical"),
      };
    }

    const mainText = eventTarget.closest("#text");
    if (!mainText) {
      return null;
    }
    const sentence = mainText.textContent || "";
    let matchOffset = 0;
    const caretRange = typeof documentRef.caretRangeFromPoint === "function"
      ? documentRef.caretRangeFromPoint(clientX, clientY)
      : null;
    if (caretRange && mainText.contains(caretRange.startContainer)) {
      const prefixRange = documentRef.createRange();
      prefixRange.selectNodeContents(mainText);
      prefixRange.setEnd(caretRange.startContainer, caretRange.startOffset);
      matchOffset = prefixRange.toString().length;
    }
    const query = sliceCodePoints(sentence, matchOffset, LOOKUP_SCAN_LENGTH);
    if (!query || !JAPANESE_TEXT_PATTERN.test(query)) {
      return null;
    }
    return {
      anchor: mainText,
      sentence,
      matchOffset,
      query,
      vertical: false,
    };
  }

  function createTag(documentRef, text, description, kind) {
    const tag = documentRef.createElement("span");
    tag.className = `gsm-hoshidicts-tag gsm-hoshidicts-tag-${kind}`;
    tag.textContent = text;
    if (description) {
      tag.title = description;
    }
    return tag;
  }

  function setMiningButtonState(button, state, message = "") {
    button.dataset.state = state;
    button.disabled = state !== "ready";
    button.title = message || {
      checking: "Checking Anki availability",
      ready: "Mine to Anki",
      mining: "Adding note",
      success: "Note added",
      error: "Could not add note",
      unavailable: "Anki mining is unavailable",
    }[state] || "Mine to Anki";
    button.setAttribute("aria-label", button.title);
    button.textContent = {
      checking: "...",
      ready: "+",
      mining: "...",
      success: "OK",
      error: "!",
      unavailable: "-",
    }[state] || "-";
  }

  function createHoshidictsReader(options = {}) {
    const windowRef = options.window || window;
    const documentRef = options.document || document;
    const WebSocketImpl = options.WebSocket || windowRef.WebSocket;
    const setTimeoutFn = options.setTimeout || windowRef.setTimeout.bind(windowRef);
    const clearTimeoutFn = options.clearTimeout || windowRef.clearTimeout.bind(windowRef);
    const onPopupStateChange =
      typeof options.onPopupStateChange === "function"
        ? options.onPopupStateChange
        : () => {};
    const getMiningStatus =
      typeof options.getMiningStatus === "function"
        ? options.getMiningStatus
        : async () => ({ available: false });
    const onMine =
      typeof options.onMine === "function"
        ? options.onMine
        : null;
    const logger = options.logger || console;
    const serverUrl = String(options.serverUrl || "ws://127.0.0.1:7276");

    let socket = null;
    let reconnectTimer = null;
    let debounceTimer = null;
    let destroyed = false;
    let shiftPressed = false;
    let requestSequence = 0;
    let latestRequestId = null;
    let latestCandidate = null;
    let latestGeneration = 0;
    let lastCandidateSignature = "";
    let popupVisible = false;
    let popupAnchor = null;
    let popupVertical = false;
    let miningInFlight = false;
    let miningStatusGeneration = 0;

    const popup = documentRef.createElement("section");
    popup.id = "gsm-hoshidicts-popup";
    popup.className = "gsm-hoshidicts-popup interactive";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", "Hoshidicts lookup");
    popup.hidden = true;
    popup.addEventListener("pointerdown", (event) => event.stopPropagation());
    popup.addEventListener("click", (event) => event.stopPropagation());
    documentRef.body.appendChild(popup);
    documentRef.documentElement.classList.add("gsm-hoshidicts-enabled");
    documentRef.documentElement.dataset.gsmHoshidictsEnabled = "true";

    function publishPopupState(visible) {
      if (popupVisible === visible) {
        return;
      }
      popupVisible = visible;
      onPopupStateChange(visible);
    }

    function cancelPendingLookup() {
      latestGeneration += 1;
      latestRequestId = null;
      latestCandidate = null;
      lastCandidateSignature = "";
      if (debounceTimer !== null) {
        clearTimeoutFn(debounceTimer);
        debounceTimer = null;
      }
    }

    function hide(reason = "hide") {
      cancelPendingLookup();
      popupAnchor = null;
      popup.hidden = true;
      publishPopupState(false);
      logger.debug?.(`[HoshidictsReader] Popup hidden (${reason})`);
      return true;
    }

    function positionPopup() {
      if (!popupVisible || !popupAnchor || !popupAnchor.isConnected) {
        if (popupVisible) {
          hide("anchor-removed");
        }
        return;
      }
      const anchorRect = popupAnchor.getBoundingClientRect();
      const measuredRect = popup.getBoundingClientRect();
      const popupSize = {
        width: measuredRect.width || Math.min(420, windowRef.innerWidth - 12),
        height: measuredRect.height || Math.min(420, windowRef.innerHeight * 0.6),
      };
      const position = calculatePopupPosition(
        anchorRect,
        popupSize,
        { width: windowRef.innerWidth, height: windowRef.innerHeight },
        { vertical: popupVertical }
      );
      popup.style.left = `${position.left}px`;
      popup.style.top = `${position.top}px`;
      popup.style.maxWidth = `${position.width}px`;
      popup.style.maxHeight = `${position.height}px`;
    }

    async function refreshMiningButtons(buttons) {
      const generation = ++miningStatusGeneration;
      let status;
      try {
        status = await getMiningStatus();
      } catch (error) {
        status = {
          available: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (destroyed || generation !== miningStatusGeneration) {
        return;
      }
      for (const button of buttons) {
        if (status && status.available === true && onMine) {
          setMiningButtonState(button, "ready");
        } else {
          setMiningButtonState(
            button,
            "unavailable",
            status && typeof status.error === "string"
              ? status.error
              : "Anki mining is unavailable"
          );
        }
      }
    }

    async function mineResult(button, result, candidate) {
      if (!onMine || miningInFlight || button.dataset.state !== "ready") {
        return;
      }
      miningInFlight = true;
      const buttons = Array.from(
        popup.querySelectorAll(".gsm-hoshidicts-mine-button")
      );
      for (const current of buttons) {
        setMiningButtonState(
          current,
          current === button ? "mining" : "checking"
        );
      }
      try {
        const response = await onMine({
          result,
          sentence: candidate.sentence,
          matchOffset: candidate.matchOffset,
        });
        if (!response || response.success !== true) {
          throw new Error(
            response && typeof response.error === "string"
              ? response.error
              : "Could not add the note."
          );
        }
        setMiningButtonState(button, "success");
      } catch (error) {
        setMiningButtonState(
          button,
          "error",
          error instanceof Error ? error.message : String(error)
        );
      } finally {
        miningInFlight = false;
        for (const current of buttons) {
          if (current !== button) {
            setMiningButtonState(current, "ready");
          }
        }
      }
    }

    function renderResults(results, candidate) {
      popup.replaceChildren();
      const miningButtons = [];

      results.forEach((result, resultIndex) => {
        const entry = documentRef.createElement("article");
        entry.className = "gsm-hoshidicts-entry";
        entry.dataset.expression = result.term.expression;

        const header = documentRef.createElement("header");
        header.className = "gsm-hoshidicts-entry-header";
        const expression = documentRef.createElement("span");
        expression.className = "gsm-hoshidicts-expression";
        appendExpressionRuby(
          documentRef,
          expression,
          result.term.expression,
          result.term.reading
        );
        header.appendChild(expression);

        const mineButton = documentRef.createElement("button");
        mineButton.type = "button";
        mineButton.className = "gsm-hoshidicts-mine-button";
        setMiningButtonState(mineButton, "checking");
        mineButton.addEventListener("click", () => {
          void mineResult(mineButton, result, candidate);
        });
        header.appendChild(mineButton);
        miningButtons.push(mineButton);
        entry.appendChild(header);

        const tagRow = documentRef.createElement("div");
        tagRow.className = "gsm-hoshidicts-tags";
        const seenTags = new Set();
        for (const step of result.trace) {
          if (!seenTags.has(`trace:${step.name}`)) {
            seenTags.add(`trace:${step.name}`);
            tagRow.appendChild(
              createTag(documentRef, step.name, step.description, "deinflection")
            );
          }
        }
        for (const tag of [
          ...parseTagList(result.term.rules),
          ...result.term.glossaries.flatMap((glossary) =>
            parseTagList(glossary.termTags)
          ),
        ]) {
          if (!seenTags.has(`term:${tag}`)) {
            seenTags.add(`term:${tag}`);
            tagRow.appendChild(createTag(documentRef, tag, "", "term"));
          }
        }
        if (tagRow.childNodes.length > 0) {
          entry.appendChild(tagRow);
        }

        const groupedGlossaries = new Map();
        for (const glossary of result.term.glossaries) {
          if (!groupedGlossaries.has(glossary.dictionary)) {
            groupedGlossaries.set(glossary.dictionary, []);
          }
          groupedGlossaries.get(glossary.dictionary).push(glossary);
        }
        let dictionaryIndex = 0;
        for (const [dictionary, glossaries] of groupedGlossaries) {
          const details = documentRef.createElement("details");
          details.className = "gsm-hoshidicts-glossary-card";
          details.open = resultIndex === 0 && dictionaryIndex === 0;
          const summary = documentRef.createElement("summary");
          summary.textContent = dictionary;
          details.appendChild(summary);
          const definitions = documentRef.createElement("ol");
          definitions.className = "gsm-hoshidicts-definitions";
          for (const glossary of glossaries) {
            const definition = documentRef.createElement("li");
            const definitionTags = parseTagList(glossary.definitionTags);
            if (definitionTags.length > 0) {
              const definitionTagRow = documentRef.createElement("div");
              definitionTagRow.className = "gsm-hoshidicts-definition-tags";
              for (const tag of definitionTags) {
                definitionTagRow.appendChild(
                  createTag(documentRef, tag, "", "definition")
                );
              }
              definition.appendChild(definitionTagRow);
            }
            const content = documentRef.createElement("div");
            content.className = "gsm-hoshidicts-glossary-content";
            appendTextOnlyGlossary(
              documentRef,
              content,
              glossary.glossary
            );
            definition.appendChild(content);
            definitions.appendChild(definition);
          }
          details.appendChild(definitions);
          entry.appendChild(details);
          dictionaryIndex += 1;
        }

        popup.appendChild(entry);
      });

      popupAnchor = candidate.anchor;
      popupVertical = candidate.vertical;
      popup.hidden = false;
      publishPopupState(true);
      positionPopup();
      void refreshMiningButtons(miningButtons);
    }

    function handleLookupResponse(rawData) {
      const serialized = typeof rawData === "string"
        ? rawData
        : rawData instanceof windowRef.ArrayBuffer
          ? new windowRef.TextDecoder().decode(rawData)
          : String(rawData);
      if (serialized.length > MAX_RESPONSE_BYTES) {
        return;
      }
      let payload;
      try {
        payload = JSON.parse(serialized);
      } catch {
        return;
      }
      if (
        !isRecord(payload) ||
        payload.type !== "hoshidicts_lookup_result" ||
        payload.requestId !== latestRequestId
      ) {
        return;
      }
      const candidate = latestCandidate;
      latestRequestId = null;
      if (!candidate || payload.success !== true) {
        hide("lookup-error");
        return;
      }
      const results = normalizeLookupResults(payload);
      if (results.length === 0) {
        hide("no-results");
        return;
      }
      renderResults(results, candidate);
    }

    function scheduleReconnect() {
      if (destroyed || reconnectTimer !== null) {
        return;
      }
      reconnectTimer = setTimeoutFn(() => {
        reconnectTimer = null;
        connect();
      }, RECONNECT_DELAY_MS);
    }

    function connect() {
      if (
        destroyed ||
        !WebSocketImpl ||
        (socket && (
          socket.readyState === WebSocketImpl.OPEN ||
          socket.readyState === WebSocketImpl.CONNECTING
        ))
      ) {
        return;
      }
      try {
        const nextSocket = new WebSocketImpl(serverUrl);
        socket = nextSocket;
        nextSocket.addEventListener("open", () => {
          if (socket !== nextSocket) {
            return;
          }
          nextSocket.send(JSON.stringify({
            type: "configure_features",
            features: ["hoshidicts"],
          }));
          if (latestCandidate && latestRequestId === null) {
            sendLookup(latestCandidate, latestGeneration);
          }
        });
        nextSocket.addEventListener("message", (event) => {
          if (socket === nextSocket) {
            handleLookupResponse(event.data);
          }
        });
        nextSocket.addEventListener("close", () => {
          if (socket === nextSocket) {
            socket = null;
            latestRequestId = null;
            scheduleReconnect();
          }
        });
        nextSocket.addEventListener("error", () => {
          if (socket === nextSocket) {
            logger.warn?.("[HoshidictsReader] Input service connection failed.");
          }
        });
      } catch (error) {
        logger.warn?.("[HoshidictsReader] Could not connect to input service.", error);
        scheduleReconnect();
      }
    }

    function sendLookup(candidate, generation) {
      if (destroyed || generation !== latestGeneration) {
        return;
      }
      latestCandidate = candidate;
      if (!socket || socket.readyState !== WebSocketImpl.OPEN) {
        connect();
        return;
      }
      const requestId = `overlay-lookup-${++requestSequence}`;
      latestRequestId = requestId;
      socket.send(JSON.stringify({
        type: "hoshidicts_lookup",
        requestId,
        text: candidate.query,
      }));
    }

    function queueLookup(candidate) {
      const signature = [
        candidate.sentence,
        candidate.matchOffset,
        candidate.query,
      ].join("\u0000");
      if (signature === lastCandidateSignature) {
        return;
      }
      lastCandidateSignature = signature;
      latestCandidate = candidate;
      latestRequestId = null;
      const generation = ++latestGeneration;
      if (debounceTimer !== null) {
        clearTimeoutFn(debounceTimer);
      }
      debounceTimer = setTimeoutFn(() => {
        debounceTimer = null;
        sendLookup(candidate, generation);
      }, LOOKUP_DEBOUNCE_MS);
    }

    function onMouseMove(event) {
      if (!(shiftPressed || event.shiftKey) || popup.contains(event.target)) {
        return;
      }
      const candidate = resolveLookupCandidate(
        windowRef,
        documentRef,
        event.target,
        event.clientX,
        event.clientY
      );
      if (candidate) {
        queueLookup(candidate);
      } else {
        cancelPendingLookup();
      }
    }

    function onKeyDown(event) {
      if (event.key === "Shift") {
        shiftPressed = true;
      } else if (event.key === "Escape" && popupVisible) {
        hide("escape");
      }
    }

    function onKeyUp(event) {
      if (event.key === "Shift") {
        shiftPressed = false;
      }
    }

    function onDocumentPointerDown(event) {
      if (popupVisible && !popup.contains(event.target)) {
        hide("outside-click");
      }
    }

    function destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      hide("destroy");
      if (reconnectTimer !== null) {
        clearTimeoutFn(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        socket.close();
        socket = null;
      }
      documentRef.removeEventListener("mousemove", onMouseMove, true);
      documentRef.removeEventListener("keydown", onKeyDown, true);
      documentRef.removeEventListener("keyup", onKeyUp, true);
      documentRef.removeEventListener("pointerdown", onDocumentPointerDown, true);
      windowRef.removeEventListener("resize", positionPopup);
      windowRef.removeEventListener("scroll", positionPopup, true);
      windowRef.removeEventListener("blur", onWindowBlur);
      popup.remove();
      documentRef.documentElement.classList.remove("gsm-hoshidicts-enabled");
      delete documentRef.documentElement.dataset.gsmHoshidictsEnabled;
    }

    function onWindowBlur() {
      shiftPressed = false;
    }

    documentRef.addEventListener("mousemove", onMouseMove, true);
    documentRef.addEventListener("keydown", onKeyDown, true);
    documentRef.addEventListener("keyup", onKeyUp, true);
    documentRef.addEventListener("pointerdown", onDocumentPointerDown, true);
    windowRef.addEventListener("resize", positionPopup);
    windowRef.addEventListener("scroll", positionPopup, true);
    windowRef.addEventListener("blur", onWindowBlur);
    connect();

    return {
      destroy,
      hide,
      isVisible: () => popupVisible,
      getPopupElement: () => popup,
      positionPopup,
    };
  }

  return {
    LOOKUP_DEBOUNCE_MS,
    LOOKUP_MAX_RESULTS,
    LOOKUP_SCAN_LENGTH,
    appendExpressionRuby,
    appendTextOnlyGlossary,
    calculatePopupPosition,
    createHoshidictsReader,
    normalizeLookupResults,
    resolveLookupCandidate,
    segmentFurigana,
    setMiningButtonState,
  };
}));
