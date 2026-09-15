// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  "use strict";

  const CAPTURE_TARGET = "hachidori-capture";
  const CONTENT_TARGET = "hachidori-capture-content";
  const MAX_TEXT_LENGTH = 4096;
  const MAX_LINES = 1000;
  const TYPEWRITER_GAP_MS = 750;
  const TYPEWRITER_GROWTH_LIMIT = 12;
  const INLINE_DISPLAY_PATTERN = /^(?:inline|ruby|contents)/u;
  const OMIT_TEXT_SELECTOR = [
    "button", "input", "select", "textarea", "[contenteditable]",
    "rt", "rp", "script", "style", "noscript", "hachidori-host",
  ].join(",");
  const videoIds = new WeakMap();
  const trackIds = new WeakMap();
  const cueIds = new WeakMap();
  let nextVideoId = 0;
  let nextTrackId = 0;
  let nextCueId = 0;
  let nextRequestId = 0;
  let nextLineId = 0;
  let linked = false;
  let linkedDocumentId = null;
  let options = null;
  let documentEpoch = crypto.randomUUID();
  let selectedVideoCleanup = null;
  let trackedElement = null;
  let trackedEpoch = "";
  let trackedLines = [];
  let trackedObserver = null;
  let trackedVisibilityObserver = null;
  let trackedMountObserver = null;
  let trackedQueued = false;
  let pickerCleanup = null;
  let rootPin = null;
  let rootPinTail = Promise.resolve();

  const now = () => performance.timeOrigin + performance.now();
  const normalize = value => typeof value === "string"
    ? value.normalize("NFC").replace(/\s+/gu, " ").trim() : "";

  async function send(type, fields = {}) {
    const reply = await chrome.runtime.sendMessage({
      target: CAPTURE_TARGET,
      type,
      requestId: `capture-content-${++nextRequestId}`,
      ...fields,
    });
    if (!reply?.ok) throw new Error(reply?.error || "The capture service did not reply.");
    return reply;
  }

  async function identify(captureSessionId) {
    return send("hd_capture_content_identify", { captureSessionId });
  }

  function report(message, fields = {}) {
    void send("hd_capture_page_status", { message, ...fields }).catch(() => {});
  }

  function videoId(video) {
    let id = videoIds.get(video);
    if (!id) {
      id = `video-${++nextVideoId}`;
      videoIds.set(video, id);
    }
    return id;
  }

  function videoTracks(video) {
    const tracks = [];
    try {
      for (const track of video.textTracks ?? []) {
        if (track.mode !== "disabled") tracks.push(track);
      }
    } catch {
      return [];
    }
    return tracks;
  }

  function activeTrackCues(track) {
    try {
      return [...(track.activeCues ?? [])];
    } catch {
      return [];
    }
  }

  function trackId(track) {
    let id = trackIds.get(track);
    if (!id) {
      id = `track-${++nextTrackId}`;
      trackIds.set(track, id);
    }
    return id;
  }

  function videos() {
    return [...document.querySelectorAll("video")].map((video, index) => ({
      id: videoId(video),
      label: String(video.getAttribute("aria-label") || video.title
        || `Video ${index + 1} (${video.videoWidth || "?"}×${video.videoHeight || "?"})`).slice(0, 200),
      trackCount: videoTracks(video).length,
    }));
  }

  function cueId(cue) {
    if (cue.id) return String(cue.id).slice(0, 160);
    let id = cueIds.get(cue);
    if (!id) {
      id = `cue-${++nextCueId}`;
      cueIds.set(cue, id);
    }
    return id;
  }

  function emitBegin(record) {
    void send("hd_capture_text_begin", { record }).catch(() => {});
  }

  function emitClose(identity, endMs = now()) {
    void send("hd_capture_text_close", { identity, endMs }).catch(() => {});
  }

  function attachVideo(video) {
    selectedVideoCleanup?.();
    selectedVideoCleanup = null;
    if (!video) return;
    const attachmentEpoch = crypto.randomUUID();
    let epochCounter = 0;
    let sourceEpoch = "";
    let interrupted = true;
    const active = new Map();
    const cleanups = [];
    const trackCleanups = new Map();

    function identity(id) {
      return { sourceKind: "cue", sourceEpoch, occurrenceId: id };
    }

    function closeAll(at = now()) {
      for (const id of active.keys()) emitClose(identity(id), at);
      active.clear();
    }

    function resetEpoch(at = now()) {
      closeAll(at);
      sourceEpoch = `video:${videoId(video)}:${attachmentEpoch}:${++epochCounter}`;
    }

    function sync(onsetKnown) {
      const at = now();
      if (video.paused || video.seeking || video.ended || !video.isConnected) {
        closeAll(at);
        return;
      }
      const next = new Map();
      for (const track of videoTracks(video)) {
        for (const cue of activeTrackCues(track)) {
          const text = String(cue.text ?? "");
          if (!normalize(text) || text.length > MAX_TEXT_LENGTH) continue;
          const id = `${trackId(track)}:${cueId(cue)}`;
          next.set(id, text);
          if (active.get(id) !== text) {
            emitBegin({
              sourceKind: "cue",
              sourceEpoch,
              occurrenceId: id,
              text,
              startMs: at,
              onsetKnown,
            });
          }
        }
      }
      for (const id of active.keys()) if (!next.has(id)) emitClose(identity(id), at);
      active.clear();
      for (const entry of next) active.set(...entry);
    }

    function listen(target, type, listener) {
      target.addEventListener(type, listener);
      cleanups.push(() => target.removeEventListener(type, listener));
    }

    function bindTracks() {
      const available = new Set(videoTracks(video));
      for (const [track, cleanup] of trackCleanups) {
        if (available.has(track)) continue;
        cleanup();
        trackCleanups.delete(track);
      }
      for (const track of available) {
        if (trackCleanups.has(track)) continue;
        const listener = () => sync(true);
        track.addEventListener("cuechange", listener);
        trackCleanups.set(track, () => track.removeEventListener("cuechange", listener));
      }
    }

    function interrupt() {
      closeAll(now());
      interrupted = true;
    }

    function resume() {
      if (video.paused || video.seeking || video.ended || !video.isConnected) return;
      if (interrupted) resetEpoch();
      interrupted = false;
      sync(false);
    }

    function resetAndSync() {
      resetEpoch();
      bindTracks();
      interrupted = video.paused || video.seeking || video.ended;
      if (!interrupted) sync(false);
    }

    resetEpoch();
    bindTracks();
    listen(video, "play", resume);
    listen(video, "pause", interrupt);
    listen(video, "seeking", interrupt);
    listen(video, "seeked", resetAndSync);
    listen(video, "ended", interrupt);
    listen(video, "emptied", () => { resetEpoch(); interrupted = true; });
    listen(video, "loadedmetadata", resetAndSync);
    if (video.textTracks?.addEventListener) {
      listen(video.textTracks, "addtrack", resetAndSync);
      listen(video.textTracks, "removetrack", resetAndSync);
      listen(video.textTracks, "change", resetAndSync);
    }
    resume();
    selectedVideoCleanup = () => {
      closeAll();
      for (const cleanup of trackCleanups.values()) cleanup();
      trackCleanups.clear();
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    };
  }

  function renderedElement(element, requireLayout = false, style = null) {
    if (!element?.isConnected || element.hidden || element.getAttribute("aria-hidden") === "true"
        || element.closest("hachidori-host")) return false;
    style ??= getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"
      && Number(style.opacity) !== 0 && (!requireLayout || element.getClientRects().length > 0);
  }

  function visible(element) {
    if (!renderedElement(element, true)) return false;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (!renderedElement(ancestor)) return false;
    }
    return true;
  }

  function validTrackedElement(element) {
    return element instanceof Element && !["HTML", "BODY"].includes(element.tagName)
      && !element.closest("input, textarea, select, button, [contenteditable], hachidori-host");
  }

  function domRangeFor(boundaries, previous) {
    if (previous?.startContainer === boundaries.startContainer && previous.startOffset === boundaries.startOffset
        && previous.endContainer === boundaries.endContainer && previous.endOffset === boundaries.endOffset) {
      return previous;
    }
    const range = document.createRange();
    range.setStart(boundaries.startContainer, boundaries.startOffset);
    range.setEnd(boundaries.endContainer, boundaries.endOffset);
    return range;
  }

  function extractLines(element) {
    if (!visible(element)) return [];
    const lines = [];
    let text = "";
    let range = null;
    const lineBreak = () => {
      const normalized = normalize(text);
      if (normalized && lines.length < MAX_LINES) {
        lines.push({ text: normalized.slice(0, MAX_TEXT_LENGTH),
          range: domRangeFor(range, trackedLines[lines.length]?.range) });
      }
      text = "";
      range = null;
    };
    function appendPart(node, value, offset) {
      range ??= { startContainer: node, startOffset: offset };
      range.endContainer = node;
      range.endOffset = offset + value.length;
      text += value;
    }
    function appendText(node) {
      const value = node.nodeValue || "";
      if (!/[\r\n]/u.test(value)) {
        appendPart(node, value, 0);
        return;
      }
      for (const part of value.matchAll(/[^\r\n]+|[\r\n]+/gu)) {
        if (/^[\r\n]/u.test(part[0])) {
          lineBreak();
          continue;
        }
        appendPart(node, part[0], part.index);
      }
    }
    function visit(node, root = false) {
      if (node.nodeType === Node.TEXT_NODE) {
        appendText(node);
        return;
      }
      if (!(node instanceof Element) || (!root && node.matches(OMIT_TEXT_SELECTOR))) return;
      const style = getComputedStyle(node);
      if (!renderedElement(node, false, style)) return;
      if (node.tagName === "BR") {
        lineBreak();
        return;
      }
      const block = !root && !INLINE_DISPLAY_PATTERN.test(style.display);
      if (block) lineBreak();
      for (const child of node.childNodes) visit(child);
      if (block) lineBreak();
    }
    visit(element, true);
    lineBreak();
    return lines;
  }

  function domIdentity(line) {
    return { sourceKind: "dom", sourceEpoch: trackedEpoch, occurrenceId: line.id };
  }

  function closeTrackedLines(at = now()) {
    for (const line of trackedLines) emitClose(domIdentity(line), at);
    trackedLines = [];
  }

  function isTypewriterContinuation(previous, text, at) {
    if (!previous || !text || text === previous.text || !text.startsWith(previous.text)) return false;
    return Array.from(text.slice(previous.text.length)).length <= TYPEWRITER_GROWTH_LIMIT
      && at - previous.updatedMs <= TYPEWRITER_GAP_MS;
  }

  function lineIndexes(values) {
    const indexesByText = new Map();
    for (const [index, text] of values.entries()) {
      const indexes = indexesByText.get(text) ?? [];
      indexes.push(index);
      indexesByText.set(text, indexes);
    }
    return indexesByText;
  }

  function retainedLinesFor(values) {
    const previousByText = lineIndexes(trackedLines.map(line => line.text));
    const nextByText = lineIndexes(values);
    const retained = new Map();
    const usedPrevious = new Set();
    for (const [text, previousIndexes] of previousByText) {
      const nextIndexes = nextByText.get(text);
      if (previousIndexes.length !== 1 || nextIndexes?.length !== 1) continue;
      retained.set(nextIndexes[0], trackedLines[previousIndexes[0]]);
      usedPrevious.add(previousIndexes[0]);
    }
    return { previousByText, nextByText, retained, usedPrevious };
  }

  function refreshUnchangedLineRanges(extracted) {
    if (extracted.length !== trackedLines.length
        || !extracted.every((line, index) => line.text === trackedLines[index].text)) return false;
    for (const [index, line] of trackedLines.entries()) line.range = extracted[index].range;
    return true;
  }

  function reconcileTracked(initial = false) {
    trackedQueued = false;
    if (!trackedElement) return;
    if (!trackedElement.isConnected) {
      clearTrackedArea(false);
      report("The tracked text area was replaced. Select it again or use the next lookup to relearn it.",
        { tracked: false });
      return;
    }
    const at = now();
    const extracted = extractLines(trackedElement);
    if (refreshUnchangedLineRanges(extracted)) return;
    const values = extracted.map(line => line.text);
    const { previousByText, nextByText, retained, usedPrevious } = retainedLinesFor(values);
    const previousLastIndex = trackedLines.length - 1;
    const nextLastIndex = values.length - 1;
    const previousLast = trackedLines[previousLastIndex];
    const nextLast = values[nextLastIndex];
    let typewriter = null;
    if (isTypewriterContinuation(previousLast, nextLast, at)
        && previousByText.get(previousLast.text)?.length === 1
        && nextByText.get(nextLast)?.length === 1
        && !usedPrevious.has(previousLastIndex) && !retained.has(nextLastIndex)) {
      typewriter = { index: nextLastIndex, line: previousLast };
      usedPrevious.add(previousLastIndex);
    }
    for (let index = 0; index < trackedLines.length; index += 1) {
      if (!usedPrevious.has(index)) emitClose(domIdentity(trackedLines[index]), at);
    }
    const next = [];
    for (let index = 0; index < values.length; index += 1) {
      const text = values[index];
      const range = extracted[index].range;
      const previous = retained.get(index);
      if (previous) {
        next.push({ ...previous, range });
        continue;
      }
      if (typewriter?.index === index) {
        emitBegin({ sourceKind: "dom", sourceEpoch: trackedEpoch, occurrenceId: typewriter.line.id,
          text, startMs: at, onsetKnown: !initial });
        next.push({ ...typewriter.line, text, range, updatedMs: at });
        continue;
      }
      const line = { id: `line-${++nextLineId}`, text, range, updatedMs: at };
      emitBegin({ sourceKind: "dom", sourceEpoch: trackedEpoch, occurrenceId: line.id,
        text, startMs: at, onsetKnown: !initial && !previousByText.has(text) });
      next.push(line);
    }
    trackedLines = next;
  }

  function queueTrackedReconcile() {
    if (trackedQueued) return;
    trackedQueued = true;
    queueMicrotask(() => reconcileTracked(false));
  }

  function clearTrackedArea(reportChange = true) {
    trackedObserver?.disconnect();
    trackedObserver = null;
    trackedVisibilityObserver?.disconnect();
    trackedVisibilityObserver = null;
    trackedMountObserver?.disconnect();
    trackedMountObserver = null;
    closeTrackedLines();
    trackedElement = null;
    trackedEpoch = "";
    if (reportChange) report("Tracked text area cleared.", { tracked: false });
  }

  function trackArea(element, manual = false) {
    if (!validTrackedElement(element)) throw new Error("Choose a bounded, non-editable text area.");
    clearTrackedArea(false);
    trackedElement = element;
    trackedEpoch = `dom:${documentEpoch}:${crypto.randomUUID()}`;
    reconcileTracked(true);
    trackedObserver = new MutationObserver(queueTrackedReconcile);
    trackedObserver.observe(element, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden"],
    });
    trackedVisibilityObserver = new MutationObserver(queueTrackedReconcile);
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      trackedVisibilityObserver.observe(ancestor, {
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "aria-hidden"],
      });
    }
    trackedMountObserver = new MutationObserver(queueTrackedReconcile);
    for (let node = element; node.parentElement; node = node.parentElement) {
      trackedMountObserver.observe(node.parentElement, { childList: true });
    }
    report(manual ? "Text area selected." : "Text area learned from the first lookup.", { tracked: true });
  }

  function learnArea(candidate) {
    if (trackedElement || !linked || !options?.mediaCapture.page.domText
        || !options.mediaCapture.page.autoLearnArea) return;
    let element = candidate?.anchor instanceof Element ? candidate.anchor : candidate?.anchor?.parentElement;
    if (!validTrackedElement(element)) return;
    let selected = element;
    for (let depth = 0; depth < 3; depth += 1) {
      const parent = selected.parentElement;
      if (!validTrackedElement(parent)) break;
      const textLength = (parent.textContent || "").length;
      if (textLength > MAX_TEXT_LENGTH || parent.querySelectorAll("*").length > 100) break;
      selected = parent;
    }
    try { trackArea(selected, false); } catch { /* Conservative auto-learning may decline the page. */ }
  }

  function occurrenceFor(candidate) {
    if (!trackedElement || !candidate?.anchor || !trackedElement.contains(candidate.anchor)) return null;
    // Keep the reader's DOM evidence local: a sentence or selection may occupy
    // only part of a timed paragraph, and identical lines need their own identity.
    const range = candidate.anchorRange ?? document.createRange();
    if (!candidate.anchorRange) range.selectNodeContents(candidate.anchor);
    const matches = trackedLines.filter(line => line.range?.comparePoint(range.startContainer, range.startOffset) === 0
      && line.range.comparePoint(range.endContainer, range.endOffset) === 0);
    return matches.length === 1 ? { occurrenceId: matches[0].id, occurrenceSourceKind: "dom" } : null;
  }

  function blockPickerInput(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function picker() {
    pickerCleanup?.();
    let candidate = null;
    const outline = document.createElement("div");
    outline.setAttribute("aria-hidden", "true");
    outline.style.cssText = [
      "all: initial !important", "position: fixed !important", "pointer-events: none !important",
      "z-index: 2147483647 !important", "border: 3px solid #36d399 !important",
      "background: rgba(54,211,153,.12) !important", "box-sizing: border-box !important",
    ].join(";");
    document.documentElement.append(outline);

    function paint(element) {
      candidate = validTrackedElement(element) ? element : null;
      if (!candidate) {
        outline.style.display = "none";
        return;
      }
      const rect = candidate.getBoundingClientRect();
      outline.style.display = "block";
      outline.style.left = `${rect.left}px`;
      outline.style.top = `${rect.top}px`;
      outline.style.width = `${rect.width}px`;
      outline.style.height = `${rect.height}px`;
    }

    function finish(element = null) {
      pickerCleanup?.();
      if (element) {
        try { trackArea(element, true); }
        catch (error) { report(error.message, { tracked: false }); }
      } else {
        report("Text area selection cancelled.", { tracked: Boolean(trackedElement) });
      }
    }

    const listeners = [
      ["pointermove", event => {
        blockPickerInput(event);
        paint(document.elementFromPoint(event.clientX, event.clientY));
      }, true],
      ["pointerdown", blockPickerInput, true],
      ["pointerup", blockPickerInput, true],
      ["mousedown", blockPickerInput, true],
      ["mouseup", blockPickerInput, true],
      ["auxclick", blockPickerInput, true],
      ["dblclick", blockPickerInput, true],
      ["contextmenu", blockPickerInput, true],
      ["click", event => { blockPickerInput(event); finish(candidate); }, true],
      ["keydown", event => {
        blockPickerInput(event);
        if (event.key === "Escape") finish();
        else if (event.key === "ArrowUp" && candidate?.parentElement) {
          paint(candidate.parentElement);
        }
      }, true],
      ["keypress", blockPickerInput, true],
      ["keyup", blockPickerInput, true],
    ];
    for (const [type, listener, capture] of listeners) window.addEventListener(type, listener, capture);
    pickerCleanup = () => {
      for (const [type, listener, capture] of listeners) window.removeEventListener(type, listener, capture);
      outline.remove();
      pickerCleanup = null;
    };
    report("Choose a bounded text area. Arrow Up selects its parent; Escape cancels.", { picking: true });
  }

  async function link(mediaCapture, captureSessionId) {
    const epoch = crypto.randomUUID();
    documentEpoch = epoch;
    linked = false;
    const identity = await identify(captureSessionId);
    if (documentEpoch !== epoch) throw new Error("The reading page link changed before its identity arrived.");
    if (!mediaCapture || typeof mediaCapture !== "object") {
      throw new Error("The capture service did not provide page timing settings.");
    }
    options = {
      mediaCapture: {
        ...mediaCapture,
        texthooker: { ...mediaCapture.texthooker },
        page: { ...mediaCapture.page },
      },
    };
    linked = true;
    linkedDocumentId = identity.documentId;
    const available = videos();
    if (options.mediaCapture.timingMode !== "recent"
        && available.length === 1 && available[0].trackCount > 0
        && options.mediaCapture.page.nativeCues) {
      attachVideo([...document.querySelectorAll("video")][0]);
    } else {
      attachVideo(null);
    }
    let message = "Reading page linked.";
    if (available.length > 1) message = "Choose which video supplies native subtitle cues.";
    else if (available.length === 0) message = "No native video cues found; page text and recent timing remain available.";
    return { videos: available, message };
  }

  function lookupSnapshot(candidate, lookupTimeMs = now()) {
    if (!linked || !options?.mediaCapture.enabled) return null;
    const pageTiming = options.mediaCapture.timingMode !== "recent";
    if (pageTiming) learnArea(candidate);
    const occurrence = pageTiming
      ? occurrenceFor(candidate) ?? { occurrenceId: "", occurrenceSourceKind: "" }
      : { occurrenceId: "", occurrenceSourceKind: "" };
    return {
      documentEpoch,
      lookup: {
        lookupText: String(candidate.sentence || candidate.query || "").slice(0, MAX_TEXT_LENGTH),
        lookupTimeMs,
        ...occurrence,
      },
    };
  }

  async function pinLookup(snapshot) {
    if (!snapshot || !linked || snapshot.documentEpoch !== documentEpoch) return null;
    try {
      return await send("hd_capture_pin", { lookup: snapshot.lookup });
    } catch {
      return null;
    }
  }

  async function releaseToken(pin) {
    if (pin?.token) {
      try { await send("hd_capture_release", { token: pin.token }); } catch { /* Expired pins need no cleanup. */ }
    }
  }

  function rootLookup(candidate) {
    const snapshot = lookupSnapshot(candidate);
    const operation = rootPinTail.then(async () => {
      const previous = rootPin;
      rootPin = null;
      await releaseToken(previous);
      const pin = await pinLookup(snapshot);
      rootPin = pin;
      return pin;
    });
    rootPinTail = operation.catch(() => {});
    return operation;
  }

  function release(pin) {
    const operation = rootPinTail.then(async () => {
      const owned = pin === undefined ? rootPin : pin;
      if (!owned?.token || rootPin?.token !== owned.token) return;
      rootPin = null;
      await releaseToken(owned);
    });
    rootPinTail = operation.catch(() => {});
    return operation;
  }

  async function unlink() {
    const epoch = crypto.randomUUID();
    documentEpoch = epoch;
    linked = false;
    await release();
    if (documentEpoch !== epoch) return { linked };
    pickerCleanup?.();
    selectedVideoCleanup?.();
    clearTrackedArea(false);
    linked = false;
    linkedDocumentId = null;
    options = null;
    return { linked: false };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== CONTENT_TARGET) return false;
    Promise.resolve().then(async () => {
      switch (message.type) {
        case "hd_capture_document": return { present: true };
        case "hd_capture_link": return link(message.mediaCapture, message.captureSessionId);
        case "hd_capture_recover": return { linked, documentId: linkedDocumentId };
        case "hd_capture_video_select": {
          if (options?.mediaCapture.timingMode === "recent"
              || !options?.mediaCapture.page.nativeCues) {
            throw new Error("Native cue timing is disabled for this capture session.");
          }
          const video = [...document.querySelectorAll("video")].find(item => videoId(item) === message.videoId);
          if (!video) throw new Error("That video is no longer available.");
          attachVideo(video);
          return { selected: message.videoId };
        }
        case "hd_capture_track_area":
          if (options?.mediaCapture.timingMode === "recent"
              || !options?.mediaCapture.page.domText) {
            throw new Error("Enable webpage timing and watched page text in Media capture settings first.");
          }
          picker();
          return { picking: true };
        case "hd_capture_clear_area":
          clearTrackedArea();
          return { tracked: false };
        case "hd_capture_unlink": return unlink();
        default: throw new Error("Unknown capture command.");
      }
    }).then(result => sendResponse(result), error => sendResponse({ error: error.message || String(error) }));
    return true;
  });

  window.addEventListener("pagehide", () => {
    void unlink();
  });

  globalThis.HDCapture = { rootLookup, release };
}());
