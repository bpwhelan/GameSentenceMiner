/*
 * Hoshidicts pronunciation audio for the GSM overlay.
 *
 * Audio source discovery and remote downloads stay behind GSM's local API.
 * Loopback candidates stream directly so local audio does not make an extra
 * buffered round trip through GSM before playback.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(function (root, factory) {
  const constants = (root && root.GSMHoshidictsConstants) ||
    (typeof require === "function" ? require("./constants") : null);
  const api = factory(constants);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.GSMHoshidictsAudio = api;
  }
}(typeof window !== "undefined" ? window : globalThis, function (constants) {
  "use strict";

  if (!constants || !constants.LIMITS) {
    throw new Error("Hoshidicts constants must load before audio support.");
  }

  const AUDIO_AUTOPLAY_DELAY_MS = 0;
  const AUDIO_REQUEST_TIMEOUT_MS = 8 * 1000;
  const AUDIO_FALLBACK_TOTAL_TIMEOUT_MS = 12 * 1000;
  const AUDIO_DISCOVERY_CONCURRENCY = 3;
  const MAX_AUDIO_URL_LENGTH = constants.LIMITS.audioUrlLength;
  const MAX_TEXT_LENGTH = constants.LIMITS.audioTextLength;
  const TTS_SOURCE_TYPES = constants.TTS_AUDIO_SOURCE_TYPES;
  const SOURCE_LABELS = constants.AUDIO_SOURCE_LABELS;
  const DEFAULT_AUDIO_PROFILE = Object.freeze({
    version: 1,
    autoPlay: false,
    sources: Object.freeze([]),
  });

  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function boundedString(value, maxLength = MAX_TEXT_LENGTH) {
    return typeof value === "string" ? value.slice(0, maxLength) : "";
  }

  function canonicalizeAudioTerm(value) {
    const term = isRecord(value) ? value : {};
    return {
      expression: boundedString(term.expression).trim(),
      reading: boundedString(term.reading).trim(),
    };
  }

  function cloneAudioProfile(profile = DEFAULT_AUDIO_PROFILE) {
    return {
      version: profile.version,
      autoPlay: profile.autoPlay,
      sources: profile.sources.map((source) => ({ ...source })),
    };
  }

  /**
   * desktop_bridge.js throws on an invalid audio profile before bootstrap.js
   * forwards it, so this only fills in fields a partial payload omitted.
   */
  function mergeAudioProfile(value) {
    const profile = isRecord(value) ? value : {};
    return {
      version: profile.version === 1 ? 1 : DEFAULT_AUDIO_PROFILE.version,
      autoPlay: typeof profile.autoPlay === "boolean"
        ? profile.autoPlay
        : DEFAULT_AUDIO_PROFILE.autoPlay,
      sources: Array.isArray(profile.sources)
        ? profile.sources.map((source) => ({ ...source }))
        : DEFAULT_AUDIO_PROFILE.sources.map((source) => ({ ...source })),
    };
  }

  function normalizeLocalHttpBaseUrl(value) {
    if (typeof value !== "string" || value.length === 0) {
      return null;
    }
    try {
      const url = new URL(value);
      if (url.protocol === "ws:") {
        url.protocol = "http:";
      } else if (url.protocol === "wss:") {
        url.protocol = "https:";
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        url.username ||
        url.password
      ) {
        return null;
      }
      return url.origin;
    } catch {
      return null;
    }
  }

  function normalizeLoopbackAudioUrl(value) {
    if (typeof value !== "string" || value.length > MAX_AUDIO_URL_LENGTH) {
      return null;
    }
    try {
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        url.username ||
        url.password
      ) {
        return null;
      }
      return url.href;
    } catch {
      return null;
    }
  }

  function normalizeAudioRequest(value, includeCandidateIndex = false) {
    const source = isRecord(value) ? value : {};
    const term = canonicalizeAudioTerm({
      expression: source.term,
      reading: source.reading,
    });
    const request = {
      term: term.expression,
      reading: term.reading,
      sourceId: boundedString(source.sourceId, 128).trim(),
    };
    if (!request.term || !request.sourceId) {
      throw new Error("A term and configured audio source are required.");
    }
    if (includeCandidateIndex) {
      if (!Number.isInteger(source.candidateIndex) || source.candidateIndex < 0) {
        throw new Error("The audio candidate is invalid.");
      }
      const candidateId = boundedString(source.candidateId, 64).trim();
      if (!/^[a-f0-9]{64}$/.test(candidateId)) {
        throw new Error("The audio candidate ID is invalid.");
      }
      request.candidateIndex = source.candidateIndex;
      request.candidateId = candidateId;
    }
    return request;
  }

  function createHoshidictsAudioClient(options = {}) {
    const baseUrl =
      normalizeLocalHttpBaseUrl(options.baseUrl) || "http://127.0.0.1:7275";
    const fetchImpl = typeof options.fetch === "function"
      ? options.fetch
      : typeof fetch === "function"
        ? fetch.bind(globalThis)
        : null;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.trunc(options.timeoutMs)
      : AUDIO_REQUEST_TIMEOUT_MS;

    async function post(path, body, externalSignal) {
      if (!fetchImpl) {
        throw new Error("GSM pronunciation audio is unavailable.");
      }
      const controller = typeof AbortController === "function"
        ? new AbortController()
        : null;
      const abortFromExternal = () => controller && controller.abort();
      if (externalSignal && typeof externalSignal.addEventListener === "function") {
        if (externalSignal.aborted) {
          abortFromExternal();
        } else {
          externalSignal.addEventListener("abort", abortFromExternal, { once: true });
        }
      }
      const timeoutId = controller
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
      try {
        return await fetchImpl(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller ? controller.signal : externalSignal,
        });
      } catch (error) {
        if (error && error.name === "AbortError") {
          throw new Error("Pronunciation audio request timed out or was cancelled.");
        }
        throw error;
      } finally {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        if (externalSignal && typeof externalSignal.removeEventListener === "function") {
          externalSignal.removeEventListener("abort", abortFromExternal);
        }
      }
    }

    async function responseError(response, fallback) {
      try {
        const payload = await response.json();
        if (isRecord(payload) && typeof payload.error === "string") {
          return payload.error;
        }
      } catch {
        // Fall through to the bounded HTTP status message.
      }
      return `${fallback} (HTTP ${response.status}).`;
    }

    return {
      async getCandidates(value, requestOptions = {}) {
        const request = normalizeAudioRequest(value);
        const response = await post(
          "/api/hoshidicts/audio/candidates",
          request,
          requestOptions.signal
        );
        if (!response.ok) {
          throw new Error(await responseError(response, "Audio discovery failed"));
        }
        let payload;
        try {
          payload = await response.json();
        } catch {
          throw new Error("GSM returned an invalid audio candidate response.");
        }
        if (!isRecord(payload) || !Array.isArray(payload.candidates)) {
          throw new Error("GSM returned an invalid audio candidate response.");
        }
        const seen = new Set();
        const candidates = [];
        for (const rawCandidate of payload.candidates) {
          if (!isRecord(rawCandidate) || !Number.isInteger(rawCandidate.index)) {
            continue;
          }
          const index = rawCandidate.index;
          const candidateId = boundedString(rawCandidate.candidateId, 64).trim();
          if (index < 0 || seen.has(index) || !/^[a-f0-9]{64}$/.test(candidateId)) {
            continue;
          }
          seen.add(index);
          const candidate = {
            index,
            name: boundedString(rawCandidate.name, 1024).trim(),
            candidateId,
          };
          const playbackUrl = normalizeLoopbackAudioUrl(
            rawCandidate.playbackUrl
          );
          if (playbackUrl) {
            candidate.playbackUrl = playbackUrl;
          }
          candidates.push(candidate);
        }
        return candidates;
      },

      async getMedia(value, requestOptions = {}) {
        const request = normalizeAudioRequest(value, true);
        const response = await post(
          "/api/hoshidicts/audio/media",
          request,
          requestOptions.signal
        );
        if (!response.ok) {
          throw new Error(await responseError(response, "Audio download failed"));
        }
        return await response.blob();
      },
    };
  }

  function setAudioButtonState(button, state, message = "") {
    if (!button) {
      return;
    }
    button.dataset.state = state;
    button.disabled = state === "loading";
    button.title = message || {
      ready: "Play pronunciation",
      loading: "Loading pronunciation",
      playing: "Playing pronunciation",
      error: "Could not play pronunciation",
      unavailable: "Pronunciation audio is unavailable",
    }[state] || "Play pronunciation";
    button.setAttribute("aria-label", button.title);
    button.textContent = "";
  }

  function sourceLabel(source) {
    return SOURCE_LABELS[source.type] || source.type || "Audio source";
  }

  function createHoshidictsAudioController(options = {}) {
    const windowRef = options.window || window;
    const documentRef = options.document || document;
    const client = options.client || null;
    const logger = options.logger || console;
    const setTimeoutFn = options.setTimeout || windowRef.setTimeout.bind(windowRef);
    const clearTimeoutFn = options.clearTimeout || windowRef.clearTimeout.bind(windowRef);
    const fallbackTimeoutMs = Number.isFinite(options.fallbackTimeoutMs) &&
      options.fallbackTimeoutMs > 0
      ? Math.trunc(options.fallbackTimeoutMs)
      : AUDIO_FALLBACK_TOTAL_TIMEOUT_MS;

    const createAudioElement = typeof options.createAudioElement === "function"
      ? options.createAudioElement
      : () => new windowRef.Audio();
    const createObjectURL = typeof options.createObjectURL === "function"
      ? options.createObjectURL
      : (blob) => windowRef.URL.createObjectURL(blob);
    const revokeObjectURL = typeof options.revokeObjectURL === "function"
      ? options.revokeObjectURL
      : (url) => windowRef.URL.revokeObjectURL(url);
    let preferences = mergeAudioProfile(
      options.audioPreferences || options.audioProfile
    );
    let destroyed = false;
    let operationSequence = 0;
    let currentAbortController = null;
    let currentAudio = null;
    let currentObjectUrl = null;
    let currentUtterance = null;
    let currentButton = null;
    let fallbackDeadlineTimer = null;
    let autoplayTimer = null;
    let autoplayStarted = false;
    let renderedItems = [];
    let activeMenu = null;
    let selections = new WeakMap();
    const buttonListeners = new WeakMap();

    function diagnostic(level, event, error) {
      const sink = typeof logger[level] === "function"
        ? logger[level]
        : typeof logger.log === "function" ? logger.log : null;
      if (!sink) return;
      const suffix = error
        ? ` ${error instanceof Error ? error.message : String(error)}`
        : "";
      sink.call(logger, `[HoshidictsAudio] ${event}${suffix}`);
    }

    function clearAutoplay() {
      if (autoplayTimer !== null) {
        clearTimeoutFn(autoplayTimer);
        autoplayTimer = null;
      }
    }

    function resetAutoplay() {
      clearAutoplay();
      autoplayStarted = false;
    }

    function clearFallbackDeadline(expectedTimer) {
      if (
        arguments.length > 0 &&
        fallbackDeadlineTimer !== expectedTimer
      ) {
        return;
      }
      if (fallbackDeadlineTimer !== null) {
        clearTimeoutFn(fallbackDeadlineTimer);
        fallbackDeadlineTimer = null;
      }
    }

    function resetCurrentButton() {
      if (
        currentButton &&
        currentButton.isConnected &&
        ["loading", "playing"].includes(currentButton.dataset.state)
      ) {
        setAudioButtonState(currentButton, "ready");
      }
      currentButton = null;
    }

    function releaseCurrentMedia() {
      if (currentAudio) {
        try {
          currentAudio.pause();
          if (typeof currentAudio.removeAttribute === "function") {
            currentAudio.removeAttribute("src");
          } else {
            currentAudio.src = "";
          }
          if (typeof currentAudio.load === "function") {
            currentAudio.load();
          }
        } catch {
          // Best-effort cleanup for a browser media element.
        }
        currentAudio = null;
      }
      if (currentObjectUrl) {
        try {
          revokeObjectURL(currentObjectUrl);
        } catch {
          // Best-effort cleanup for browser-generated object URLs.
        }
        currentObjectUrl = null;
      }
    }

    function cancelSpeech() {
      if (!currentUtterance) {
        return;
      }
      try {
        if (windowRef.speechSynthesis) {
          windowRef.speechSynthesis.cancel();
        }
      } catch {
        // Best-effort cleanup for platform speech synthesis.
      }
      currentUtterance = null;
    }

    function stopActive() {
      clearFallbackDeadline();
      operationSequence += 1;
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
      }
      releaseCurrentMedia();
      cancelSpeech();
      resetCurrentButton();
    }

    function removeMenu() {
      const menuSession = activeMenu;
      activeMenu = null;
      if (menuSession) {
        if (menuSession.abortController) {
          menuSession.abortController.abort();
        }
        menuSession.element.remove();
      }
      documentRef.removeEventListener("pointerdown", onDocumentPointerDown, true);
      documentRef.removeEventListener("keydown", onDocumentKeyDown, true);
    }

    function onDocumentPointerDown(event) {
      if (activeMenu && !activeMenu.element.contains(event.target)) {
        removeMenu();
      }
    }

    function onDocumentKeyDown(event) {
      if (event.key === "Escape") {
        removeMenu();
      }
    }

    function updateButtons() {
      renderedItems = renderedItems.filter(({ button }) => button);
      const available = preferences.sources.length > 0;
      for (const { button } of renderedItems) {
        button.hidden = !available;
        if (
          available &&
          button === currentButton &&
          ["loading", "playing"].includes(button.dataset.state)
        ) {
          continue;
        }
        setAudioButtonState(
          button,
          available ? "ready" : "unavailable"
        );
      }
    }

    function termRequest(result, source) {
      const term = isRecord(result) && isRecord(result.term) ? result.term : {};
      const normalizedTerm = canonicalizeAudioTerm(term);
      return {
        term: normalizedTerm.expression,
        reading: normalizedTerm.reading,
        sourceId: source.id,
      };
    }

    function makeAbortController() {
      return typeof windowRef.AbortController === "function"
        ? new windowRef.AbortController()
        : typeof AbortController === "function"
          ? new AbortController()
          : null;
    }

    async function playCandidate(result, source, candidate, button, sequence, signal) {
      const playbackUrl = normalizeLoopbackAudioUrl(candidate.playbackUrl);
      let media = null;
      let objectUrl = null;
      if (!playbackUrl) {
        if (!client || typeof client.getMedia !== "function") {
          throw new Error("GSM pronunciation audio is unavailable.");
        }
        media = await client.getMedia({
          ...termRequest(result, source),
          candidateIndex: candidate.index,
          candidateId: candidate.candidateId,
        }, { signal });
      }
      if (destroyed || sequence !== operationSequence) {
        return false;
      }
      objectUrl = media ? createObjectURL(media) : null;
      const audio = createAudioElement();
      currentObjectUrl = objectUrl;
      currentAudio = audio;
      audio.src = playbackUrl || objectUrl;
      if (typeof audio.addEventListener === "function") {
        audio.addEventListener("ended", () => {
          if (currentAudio !== audio) return;
          releaseCurrentMedia();
          resetCurrentButton();
        }, { once: true });
        audio.addEventListener("error", () => {
          if (currentAudio !== audio) return;
          releaseCurrentMedia();
          const selection = selections.get(result);
          if (
            selection &&
            selection.sourceId === source.id &&
            selection.candidateIndex === candidate.index &&
            selection.candidateId === candidate.candidateId
          ) {
            selections.delete(result);
          }
          if (button && button.isConnected) {
            setAudioButtonState(button, "error", "Could not play pronunciation");
          }
          currentButton = null;
        }, { once: true });
      }
      try {
        await audio.play();
      } catch (error) {
        if (currentAudio === audio) {
          releaseCurrentMedia();
        }
        throw error;
      }
      if (destroyed || sequence !== operationSequence) {
        if (currentAudio === audio) {
          releaseCurrentMedia();
        }
        return false;
      }
      selections.set(result, {
        sourceId: source.id,
        candidateIndex: candidate.index,
        candidateId: candidate.candidateId,
      });
      setAudioButtonState(button, "playing");
      return true;
    }

    async function playTts(result, source, button, sequence) {
      const synthesis = windowRef.speechSynthesis;
      const Utterance = windowRef.SpeechSynthesisUtterance;
      if (!synthesis || typeof synthesis.speak !== "function" || !Utterance) {
        throw new Error("Text-to-speech is unavailable on this system.");
      }
      const request = termRequest(result, source);
      const text = source.type === "text-to-speech-reading"
        ? request.reading || request.term
        : request.term;
      if (!text) {
        throw new Error("This result has no text to pronounce.");
      }
      const utterance = new Utterance(text);
      utterance.lang = "ja-JP";
      if (source.voice && typeof synthesis.getVoices === "function") {
        const voice = synthesis.getVoices().find((candidate) =>
          candidate &&
          (candidate.voiceURI === source.voice || candidate.name === source.voice)
        );
        if (voice) {
          utterance.voice = voice;
        }
      }
      currentUtterance = utterance;
      utterance.onend = () => {
        if (currentUtterance !== utterance) return;
        currentUtterance = null;
        resetCurrentButton();
      };
      utterance.onerror = () => {
        if (currentUtterance !== utterance) return;
        currentUtterance = null;
        setAudioButtonState(button, "error", "Could not play text-to-speech");
        currentButton = null;
      };
      synthesis.speak(utterance);
      if (destroyed || sequence !== operationSequence) {
        synthesis.cancel();
        return false;
      }
      selections.delete(result);
      setAudioButtonState(button, "playing");
      return true;
    }

    async function candidatesFor(result, source, signal) {
      if (TTS_SOURCE_TYPES.has(source.type)) {
        return [{ index: 0, name: sourceLabel(source), tts: true }];
      }
      if (!client || typeof client.getCandidates !== "function") {
        return [];
      }
      return await client.getCandidates(
        termRequest(result, source),
        { signal }
      );
    }

    async function playExact(result, button, source, candidate) {
      if (destroyed || preferences.sources.length === 0) {
        return false;
      }
      clearAutoplay();
      stopActive();
      const sequence = operationSequence;
      currentButton = button;
      setAudioButtonState(button, "loading");
      currentAbortController = makeAbortController();
      try {
        const played = TTS_SOURCE_TYPES.has(source.type)
          ? await playTts(result, source, button, sequence)
          : await playCandidate(
              result,
              source,
              candidate,
              button,
              sequence,
              currentAbortController ? currentAbortController.signal : undefined
            );
        if (sequence === operationSequence) {
          currentAbortController = null;
        }
        return played;
      } catch (error) {
        if (sequence === operationSequence) {
          currentAbortController = null;
          releaseCurrentMedia();
          setAudioButtonState(
            button,
            "error",
            error instanceof Error ? error.message : String(error)
          );
          currentButton = null;
          diagnostic("warn", "playback.failed", error);
        }
        return false;
      }
    }

    async function playOrdered(result, button) {
      if (destroyed || preferences.sources.length === 0) {
        return false;
      }
      clearAutoplay();
      stopActive();
      const sequence = operationSequence;
      currentButton = button;
      setAudioButtonState(button, "loading");
      currentAbortController = makeAbortController();
      const operationAbortController = currentAbortController;
      const signal = currentAbortController
        ? currentAbortController.signal
        : undefined;
      const deadlineError = new Error("Pronunciation audio fallback timed out.");
      let rejectDeadline;
      const deadline = new Promise((_resolve, reject) => {
        rejectDeadline = reject;
      });
      const deadlineTimer = setTimeoutFn(() => {
        if (fallbackDeadlineTimer === deadlineTimer) {
          fallbackDeadlineTimer = null;
        }
        if (
          destroyed ||
          sequence !== operationSequence ||
          currentAbortController !== operationAbortController
        ) {
          return;
        }
        operationSequence += 1;
        if (operationAbortController) {
          operationAbortController.abort();
        }
        currentAbortController = null;
        releaseCurrentMedia();
        cancelSpeech();
        setAudioButtonState(button, "error", deadlineError.message);
        currentButton = null;
        diagnostic("warn", "playback.timed-out", deadlineError);
        rejectDeadline(deadlineError);
      }, fallbackTimeoutMs);
      fallbackDeadlineTimer = deadlineTimer;
      const withinDeadline = async (operation) => await Promise.race([
        operation,
        deadline,
      ]);
      let fallbackSteps = 0;
      const checkpointDeadline = () => {
        fallbackSteps += 1;
        if (fallbackSteps % 32 === 0) {
          return withinDeadline(new Promise((resolve) => setTimeoutFn(resolve, 0)));
        }
        return null;
      };
      let lastError = null;
      try {
        for (const source of preferences.sources) {
          if (destroyed || sequence !== operationSequence) {
            return false;
          }
          try {
            const sourceCheckpoint = checkpointDeadline();
            if (sourceCheckpoint) {
              await sourceCheckpoint;
              if (destroyed || sequence !== operationSequence) {
                return false;
              }
            }
            if (TTS_SOURCE_TYPES.has(source.type)) {
              const played = await withinDeadline(
                playTts(result, source, button, sequence)
              );
              if (played) {
                currentAbortController = null;
                return true;
              }
              continue;
            }
            const candidates = await withinDeadline(
              candidatesFor(result, source, signal)
            );
            for (const candidate of candidates) {
              try {
                const candidateCheckpoint = checkpointDeadline();
                if (candidateCheckpoint) {
                  await candidateCheckpoint;
                  if (destroyed || sequence !== operationSequence) {
                    return false;
                  }
                }
                if (await withinDeadline(playCandidate(
                  result,
                  source,
                  candidate,
                  button,
                  sequence,
                  signal
                ))) {
                  currentAbortController = null;
                  return true;
                }
              } catch (error) {
                lastError = error;
                releaseCurrentMedia();
                if (sequence !== operationSequence) {
                  return false;
                }
              }
            }
          } catch (error) {
            lastError = error;
            if (sequence !== operationSequence) {
              return false;
            }
          }
        }
        if (sequence === operationSequence) {
          currentAbortController = null;
          const message = lastError
            ? lastError instanceof Error ? lastError.message : String(lastError)
            : "No pronunciation recording was found.";
          setAudioButtonState(button, "error", message);
          currentButton = null;
          diagnostic("warn", "playback.unavailable", lastError);
        }
        return false;
      } finally {
        clearFallbackDeadline(deadlineTimer);
      }
    }

    function appendMenuItem(container, result, button, source, candidate, label) {
      const item = documentRef.createElement("button");
      item.type = "button";
      item.className = "gsm-hoshidicts-audio-menu-item";
      item.setAttribute("role", "menuitem");
      item.textContent = label;
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeMenu();
        void playExact(result, button, source, candidate);
      });
      container.appendChild(item);
    }

    async function mapWithConcurrency(items, concurrency, mapper) {
      const output = new Array(items.length);
      let nextIndex = 0;
      async function worker() {
        while (nextIndex < items.length) {
          const index = nextIndex;
          nextIndex += 1;
          output[index] = await mapper(items[index], index);
        }
      }
      const workerCount = Math.min(concurrency, items.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      return output;
    }

    async function showMenu(result, button) {
      if (destroyed || preferences.sources.length === 0) {
        return;
      }
      clearAutoplay();
      removeMenu();
      const abortController = makeAbortController();
      const nextMenu = documentRef.createElement("div");
      const menuSession = { element: nextMenu, abortController };
      nextMenu.className = "gsm-hoshidicts-audio-menu interactive";
      nextMenu.setAttribute("role", "menu");
      nextMenu.setAttribute("aria-label", "Pronunciation sources");
      nextMenu.addEventListener("pointerdown", (event) => event.stopPropagation());
      nextMenu.addEventListener("click", (event) => event.stopPropagation());
      const loading = documentRef.createElement("div");
      loading.className = "gsm-hoshidicts-audio-menu-status";
      loading.setAttribute("role", "status");
      loading.textContent = "Loading pronunciation sources…";
      nextMenu.appendChild(loading);
      documentRef.body.appendChild(nextMenu);
      activeMenu = menuSession;

      const rect = button.getBoundingClientRect();
      const viewportWidth = Math.max(1, windowRef.innerWidth || 1);
      const viewportHeight = Math.max(1, windowRef.innerHeight || 1);
      const left = Math.max(6, Math.min(rect.left, viewportWidth - 266));
      const top = Math.max(6, Math.min(rect.bottom + 4, viewportHeight - 326));
      nextMenu.style.left = `${Math.round(left)}px`;
      nextMenu.style.top = `${Math.round(top)}px`;
      documentRef.addEventListener("pointerdown", onDocumentPointerDown, true);
      documentRef.addEventListener("keydown", onDocumentKeyDown, true);

      const groups = await mapWithConcurrency(
        preferences.sources,
        AUDIO_DISCOVERY_CONCURRENCY,
        async (source) => {
          try {
            return {
              source,
              candidates: await candidatesFor(
                result,
                source,
                abortController ? abortController.signal : undefined
              ),
            };
          } catch (error) {
            diagnostic("debug", `menu.source-unavailable.${source.id}`, error);
            return { source, candidates: [] };
          }
        }
      );
      if (destroyed || activeMenu !== menuSession) {
        return;
      }
      nextMenu.replaceChildren();
      let optionCount = 0;
      for (const { source, candidates } of groups) {
        if (candidates.length === 0) {
          continue;
        }
        const heading = documentRef.createElement("div");
        heading.className = "gsm-hoshidicts-audio-menu-heading";
        heading.textContent = sourceLabel(source);
        nextMenu.appendChild(heading);
        candidates.forEach((candidate, candidateIndex) => {
          const name = boundedString(candidate.name, 1024).trim();
          appendMenuItem(
            nextMenu,
            result,
            button,
            source,
            candidate,
            name || `Recording ${candidateIndex + 1}`
          );
          optionCount += 1;
        });
      }
      if (optionCount === 0) {
        const empty = documentRef.createElement("div");
        empty.className = "gsm-hoshidicts-audio-menu-status";
        empty.setAttribute("role", "status");
        empty.textContent = "No pronunciation recordings were found.";
        nextMenu.appendChild(empty);
      } else {
        const firstItem = nextMenu.querySelector(".gsm-hoshidicts-audio-menu-item");
        if (firstItem && typeof firstItem.focus === "function") {
          firstItem.focus();
        }
      }
    }

    function attachButton(button, result) {
      const oldListeners = buttonListeners.get(button);
      if (oldListeners) {
        button.removeEventListener("click", oldListeners.click);
        button.removeEventListener("contextmenu", oldListeners.contextmenu);
      }
      const click = (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) {
          void showMenu(result, button);
        } else {
          void playOrdered(result, button);
        }
      };
      const contextmenu = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void showMenu(result, button);
      };
      button.addEventListener("click", click);
      button.addEventListener("contextmenu", contextmenu);
      buttonListeners.set(button, { click, contextmenu });
    }

    function setRenderedResults(items, options = {}) {
      removeMenu();
      renderedItems = Array.isArray(items)
        ? items.filter((item) =>
            isRecord(item) && item.button && isRecord(item.result)
          )
        : [];
      for (const { button, result } of renderedItems) {
        attachButton(button, result);
      }
      updateButtons();
      if (renderedItems.length === 0) {
        resetAutoplay();
        return;
      }
      if (
        options.autoPlay !== false &&
        preferences.autoPlay &&
        preferences.sources.length > 0 &&
        !autoplayStarted
      ) {
        autoplayStarted = true;
        autoplayTimer = setTimeoutFn(() => {
          autoplayTimer = null;
          const first = renderedItems[0];
          if (
            !destroyed &&
            preferences.autoPlay &&
            first
          ) {
            void playOrdered(first.result, first.button);
          }
        }, AUDIO_AUTOPLAY_DELAY_MS);
      }
    }

    function beginLookup() {
      resetAutoplay();
      removeMenu();
      stopActive();
      renderedItems = [];
    }

    function dismissPopup() {
      resetAutoplay();
      removeMenu();
    }

    function updatePreferences(nextPreferences = {}) {
      const previousSourceSignature = JSON.stringify(preferences.sources);
      const nextProfile = mergeAudioProfile({
        ...preferences,
        ...(isRecord(nextPreferences) ? nextPreferences : {}),
        sources: isRecord(nextPreferences) && Array.isArray(nextPreferences.sources)
          ? nextPreferences.sources
          : preferences.sources,
      });
      const sourcesChanged =
        previousSourceSignature !== JSON.stringify(nextProfile.sources);
      preferences = nextProfile;
      if (sourcesChanged) {
        resetAutoplay();
        removeMenu();
        stopActive();
        selections = new WeakMap();
      }
      updateButtons();
      return cloneAudioProfile(preferences);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      resetAutoplay();
      removeMenu();
      stopActive();
      renderedItems = [];
    }

    return {
      beginLookup,
      destroy,
      dismissPopup,
      getPreferences: () => cloneAudioProfile(preferences),
      getSelection(result) {
        const selection = isRecord(result) ? selections.get(result) : null;
        return selection ? { ...selection } : null;
      },
      play: playOrdered,
      setRenderedResults,
      showMenu,
      stop: stopActive,
      updatePreferences,
    };
  }

  return {
    AUDIO_AUTOPLAY_DELAY_MS,
    AUDIO_FALLBACK_TOTAL_TIMEOUT_MS,
    AUDIO_REQUEST_TIMEOUT_MS,
    DEFAULT_AUDIO_PROFILE,
    canonicalizeAudioTerm,
    createHoshidictsAudioClient,
    createHoshidictsAudioController,
    normalizeLocalHttpBaseUrl,
    setAudioButtonState,
  };
}));
