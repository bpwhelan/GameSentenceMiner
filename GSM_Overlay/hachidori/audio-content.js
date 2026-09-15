// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  "use strict";

  function current(record) {
    return record.button.isConnected && !record.popup.hidden && record.isCurrent();
  }

  function setBusy(record, busy) {
    record.button.setAttribute("aria-busy", String(busy));
    if (busy) record.button.dataset.state = "loading";
    else if (record.button.dataset.state !== "error") delete record.button.dataset.state;
    record.button.setAttribute("aria-label", `${busy ? "Stop" : "Play"} pronunciation for ${record.term.expression}`);
    record.button.title = `${busy ? "Stop" : "Play"} pronunciation; Shift-click, right-click or press Down for choices`;
  }

  function createAudioController({ window, send, onMenuChange, onSelectionChange = () => {} }) {
    const document = window.document;
    const bound = new WeakMap(), visited = new WeakMap(), feedback = new WeakMap();
    const controls = new Set();
    let selections = new WeakMap();
    let options = window.HDReaderOptions.DEFAULT_OPTIONS;
    let sourceKey = JSON.stringify(options.audioSources);
    let active = null, menu = null;
    let optionsReady = false;
    // One first result per owner may wait for options or until the owner's
    // blurred definitions are revealed; its first-visit key stays unconsumed meanwhile.
    const pendingAutoplay = new Map();

    function audioAvailable() {
      return options.audioSources.some(source => source.enabled
        && (source.type.startsWith("text-to-speech") || source.url.trim()));
    }

    function updateControls() {
      const available = audioAvailable();
      for (const record of controls) {
        if (!record.button.isConnected) { controls.delete(record); continue; }
        record.button.hidden = !available;
        const control = record.button.closest(".gsm-hoshidicts-audio-control");
        if (control) control.hidden = !available;
      }
    }

    function firstVisit(record) {
      if (!record.request) return false;
      let keys = visited.get(record.request);
      if (!keys) { keys = new Set(); visited.set(record.request, keys); }
      if (keys.has(record.autoplayKey)) return false;
      keys.add(record.autoplayKey);
      return true;
    }

    // A retired hold keeps its visit: the same request may bind again and its
    // reveal still settles it, while a request that is gone has no key to
    // spend. A manual play consumes every waiting result.
    function cancelAutoplay(owner, consumeHeld = true) {
      for (const [key, record] of pendingAutoplay) {
        if (owner !== undefined && key !== owner) continue;
        if (consumeHeld || !record.autoplayHeld?.()) firstVisit(record);
        pendingAutoplay.delete(key);
      }
    }

    function autoplay(record) {
      if (!current(record)) return;
      if (!optionsReady || record.autoplayHeld?.()) {
        const previous = pendingAutoplay.get(record.owner);
        if (previous && previous.autoplayKey !== record.autoplayKey) firstVisit(previous);
        pendingAutoplay.set(record.owner, record);
        return;
      }
      if (firstVisit(record) && options.audioAutoplay && audioAvailable()) void play(record);
    }

    function owns(operation) {
      return active === operation && current(operation.record);
    }

    function setStatus(record, text) {
      if (text) record.button.dataset.state = "error";
      let output = feedback.get(record.button) || record.status;
      if (!output && !text) return;
      if (!output) {
        output = document.createElement("output");
        output.className = "gsm-hoshidicts-audio-status";
        output.setAttribute("aria-live", "polite");
        record.button.after(output);
      }
      feedback.set(record.button, output);
      output.textContent = text;
    }

    function stop() {
      if (!active) return;
      const previous = active;
      active = null;
      setBusy(previous.record, false);
      setStatus(previous.record, "");
      void send("hd_audio_stop", { playRequestId: previous.requestId }).catch(() => {});
    }

    function closeMenu(restoreFocus = true) {
      if (!menu) return false;
      const previous = menu;
      menu = null;
      if (active?.type === "hd_audio_candidates" && active.record === previous.record) stop();
      previous.element.remove();
      previous.record.button.setAttribute("aria-expanded", "false");
      if (restoreFocus && current(previous.record)) previous.record.button.focus({ preventScroll: true });
      onMenuChange(previous.record.owner);
      return true;
    }

    function retire(owner) {
      cancelAutoplay(owner, false);
      if (menu && (owner === undefined || menu.record.owner === owner)) closeMenu(false);
      if (active && (owner === undefined || active.record.owner === owner)) stop();
    }

    async function request(record, type, fields, accept) {
      cancelAutoplay();
      firstVisit(record);
      stop();
      if (!current(record) || !audioAvailable()) return;
      const operation = { record, type, requestId: window.crypto.randomUUID() };
      active = operation;
      setBusy(record, true);
      setStatus(record, "");
      try {
        const reply = await send(type, { term: record.term, requestId: operation.requestId, ...fields });
        if (!owns(operation)) return;
        if (!reply.ok) throw new Error(reply.error);
        accept(reply);
      } catch (error) {
        if (owns(operation)) {
          if (type === "hd_audio_play" && selections.get(record.result) === fields.selection) {
            selections.delete(record.result);
            onSelectionChange(record.owner);
          }
          setStatus(record, `Could not play: ${error.message}`);
          if (menu?.record === record) menu.output.textContent = error.message;
        }
      } finally {
        if (active === operation) { active = null; setBusy(record, false); }
      }
    }

    function play(record, selection = selections.get(record.result)) {
      closeMenu();
      return request(record, "hd_audio_play", selection ? { selection } : {}, reply => {
        setStatus(record, reply.status === "no-result" ? "No pronunciation was returned. Check Audio Settings." : "");
      });
    }

    function choices(record) {
      closeMenu(false);
      if (!current(record) || !audioAvailable()) return;
      const element = document.createElement("section");
      element.className = "gsm-hoshidicts-audio-menu gsm-hoshidicts-audio-choices";
      element.setAttribute("role", "dialog");
      element.setAttribute("aria-label", `Pronunciation for ${record.term.expression}`);
      const heading = document.createElement("strong");
      heading.className = "gsm-hoshidicts-audio-menu-heading";
      heading.textContent = `Pronunciation · ${record.term.expression}`;
      const close = document.createElement("button");
      close.type = "button";
      close.className = "gsm-hoshidicts-audio-menu-item gsm-hoshidicts-audio-menu-close";
      close.textContent = "Close";
      close.addEventListener("click", () => closeMenu());
      const output = document.createElement("p");
      output.className = "gsm-hoshidicts-audio-menu-status";
      output.setAttribute("role", "status");
      output.textContent = "Finding choices…";
      element.append(heading, close, output);
      record.popup.append(element);
      menu = { element, output, record };
      record.button.setAttribute("aria-expanded", "true");
      onMenuChange(record.owner);
      close.focus({ preventScroll: true });
      void request(record, "hd_audio_candidates", {}, reply => {
        let count = 0;
        for (const [sourceIndex, group] of reply.groups.entries()) {
          const section = document.createElement("div");
          const title = document.createElement("h4");
          title.className = "gsm-hoshidicts-audio-menu-heading";
          title.textContent = `${sourceIndex + 1}. ${window.HDReaderOptions.AUDIO_SOURCE_LABELS[group.type]}`;
          section.append(title);
          if (group.error) {
            const error = document.createElement("p");
            error.textContent = group.error;
            section.append(error);
          }
          for (const [index, candidate] of (group.candidates || []).entries()) {
            count += 1;
            const button = document.createElement("button");
            button.className = "gsm-hoshidicts-audio-menu-item";
            button.type = "button";
            button.textContent = candidate.name || `Pronunciation ${index + 1}`;
            button.addEventListener("click", () => {
              const selection = { sourceId: group.sourceId, sourceKey: group.sourceKey, ...record.term,
                index, url: candidate.url ?? null, name: candidate.name };
              selections.set(record.result, selection);
              onSelectionChange(record.owner);
              void play(record, selection);
            });
            section.append(button);
          }
          element.append(section);
        }
        setStatus(record, "");
        output.textContent = count ? "Choose a pronunciation to play." : "No pronunciations found. Check Audio Settings.";
        onMenuChange(record.owner);
      });
    }

    function bind(items, context) {
      if (active?.record.owner === context.owner && !current(active.record)) stop();
      if (menu?.record.owner === context.owner && !current(menu.record)) closeMenu(false);
      const first = items[0];
      if (!first) return;
      const autoplayKey = JSON.stringify([context.request?.selectedDictionaryTab, first.result.term.expression, first.result.term.reading]);
      for (const item of items) {
        if (bound.has(item.button)) { bound.get(item.button).autoplayKey = autoplayKey; continue; }
        const record = { ...item, ...context, autoplayKey,
          term: { expression: item.result.term.expression, reading: item.result.term.reading || "" } };
        bound.set(item.button, record);
        controls.add(record);
        item.button.addEventListener("click", event => {
          if (event.shiftKey) choices(record);
          else if (active?.record.button === item.button) stop();
          else void play(record);
        });
        item.button.addEventListener("contextmenu", event => { event.preventDefault(); choices(record); });
        item.button.addEventListener("keydown", event => {
          if (event.key === "ArrowDown") { event.preventDefault(); choices(record); }
        });
      }
      updateControls();
      autoplay(bound.get(first.button));
    }

    // Keybinds play the entry's pronunciation even while it is already playing,
    // which a click would stop. A source ID plays that source's first choice.
    function playButton(button, sourceId = "") {
      const record = bound.get(button);
      if (!record || !current(record) || !audioAvailable()) return false;
      if (!sourceId) {
        void play(record);
        return true;
      }
      void request(record, "hd_audio_candidates", {}, reply => {
        const group = reply.groups.find(item => item.sourceId === sourceId);
        const candidate = group?.candidates?.[0];
        if (!candidate) {
          setStatus(record, "No pronunciation was returned. Check Audio Settings.");
          return;
        }
        void play(record, { sourceId: group.sourceId, sourceKey: group.sourceKey, ...record.term,
          index: 0, url: candidate.url ?? null, name: candidate.name });
      });
      return true;
    }

    const listener = message => {
      if (!active || message?.target !== "hachidori-audio-content" || message.type !== "hd_audio_playing"
          || message.requestId !== active?.requestId || !current(active.record)) return;
      active.record.button.dataset.state = "playing";
    };
    window.chrome.runtime.onMessage.addListener(listener);
    // Chrome 128 can tear down the content owner before content.js receives
    // pagehide. Listen here too so the offscreen player is stopped while this
    // document can still identify its owned request.
    const onPageHide = () => retire();
    window.addEventListener("pagehide", onPageHide);
    return {
      bind, retire, closeMenu, playButton,
      hasMenu: owner => Boolean(menu && (owner === undefined || menu.record.owner === owner)),
      selectionFor: result => selections.get(result) ?? null,
      // Releases the owner's held first result for exactly this request once its
      // definitions are revealed. A stale request's late reveal leaves a newer view alone.
      settleAutoplay(owner, request) {
        const record = pendingAutoplay.get(owner);
        if (!record || record.request !== request) return;
        pendingAutoplay.delete(owner);
        autoplay(record);
      },
      update(next, ready = true) {
        const waiting = !optionsReady && ready ? [...pendingAutoplay] : [];
        for (const [owner] of waiting) pendingAutoplay.delete(owner);
        const nextKey = JSON.stringify(next.audioSources);
        if (nextKey !== sourceKey) { retire(); selections = new WeakMap(); }
        else if (options.audioAutoplay && !next.audioAutoplay) retire();
        sourceKey = nextKey;
        options = next;
        optionsReady = ready;
        updateControls();
        for (const [owner, record] of waiting) {
          pendingAutoplay.set(owner, record);
          // Adopt the complete storage event, including lookup invalidation,
          // before retrying a first result that rendered with unknown options.
          window.queueMicrotask(() => {
            if (pendingAutoplay.get(owner) !== record) return;
            pendingAutoplay.delete(owner);
            autoplay(record);
          });
        }
      },
      dispose() {
        retire();
        controls.clear();
        window.removeEventListener("pagehide", onPageHide);
        window.chrome.runtime.onMessage.removeListener(listener);
      },
    };
  }
  globalThis.HDAudio = { createAudioController };
}());
