(function () {
  "use strict";

  const PREVIEW_CHANNEL = "gsm.hoshidicts.preview.v1";
  const SERVER_URL = "ws://127.0.0.1:7276";
  const LOOKUP_COUNT = 12;
  const SEEN_COUNT = 42;
  const MAX_CUSTOM_POPUP_CSS_LENGTH = 32 * 1024;

  let reader = null;
  let currentPreferences = null;

  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function isReaderPreferences(value) {
    return (
      isRecord(value) &&
      Number.isInteger(value.popupWidthPx) &&
      Number.isInteger(value.popupHeightPx) &&
      Number.isInteger(value.popupColumns) &&
      typeof value.theme === "string" &&
      (value.popupToolbarPosition === "top" ||
        value.popupToolbarPosition === "bottom") &&
      typeof value.showLookupCounts === "boolean" &&
      typeof value.sourceHighlightEnabled === "boolean" &&
      typeof value.customPopupCss === "string" &&
      value.customPopupCss.length <= MAX_CUSTOM_POPUP_CSS_LENGTH &&
      isRecord(value.definitionBlur) &&
      typeof value.definitionBlur.enabled === "boolean" &&
      isRecord(value.popupButtons)
    );
  }

  function parentOrigin() {
    if (!document.referrer) return "*";
    try {
      const origin = new URL(document.referrer).origin;
      return origin === "null" ? "*" : origin;
    } catch {
      return "*";
    }
  }

  function isParentOrigin(origin) {
    const expectedOrigin = parentOrigin();
    return expectedOrigin === "*" || origin === expectedOrigin;
  }

  function post(message) {
    window.parent.postMessage(
      { channel: PREVIEW_CHANNEL, ...message },
      parentOrigin()
    );
  }

  function setStatus(status) {
    if (
      status !== "loading" &&
      status !== "connecting" &&
      status !== "ready" &&
      status !== "error"
    ) {
      return;
    }
    post({ type: "status", status });
  }

  function cloneAudioPreferences(preferences) {
    return {
      ...preferences,
      autoPlay: false,
      sources: preferences.sources.map((source) => ({ ...source }))
    };
  }

  function createPreviewAudioController() {
    let preferences = {
      version: 1,
      enabled: true,
      autoPlay: false,
      volume: 100,
      sources: []
    };
    return {
      beginLookup() {},
      destroy() {},
      dismissPopup() {},
      getPreferences() {
        return cloneAudioPreferences(preferences);
      },
      getSelection() {
        return null;
      },
      async play() {
        return false;
      },
      setRenderedResults(items) {
        for (const item of Array.isArray(items) ? items : []) {
          if (item && item.button) {
            item.button.hidden = false;
          }
        }
      },
      showMenu() {},
      stop() {},
      updatePreferences(nextPreferences) {
        if (isRecord(nextPreferences)) {
          preferences = {
            ...preferences,
            ...nextPreferences,
            autoPlay: false,
            sources: Array.isArray(nextPreferences.sources)
              ? nextPreferences.sources.map((source) => ({ ...source }))
              : preferences.sources
          };
        }
        return cloneAudioPreferences(preferences);
      }
    };
  }

  function definitionBlurEqual(left, right) {
    return (
      isRecord(left) &&
      isRecord(right) &&
      left.enabled === right.enabled &&
      left.lookupThreshold === right.lookupThreshold &&
      left.revealMode === right.revealMode &&
      left.revealDelayMs === right.revealDelayMs
    );
  }

  function needsFreshLookup(previous, next) {
    return Boolean(
      previous &&
        (previous.showLookupCounts !== next.showLookupCounts ||
          !definitionBlurEqual(previous.definitionBlur, next.definitionBlur))
    );
  }

  function selectPreviewWord() {
    const word = document.getElementById("preview-word");
    const textNode = word && word.firstChild;
    const selection = window.getSelection();
    if (!word || !textNode || !selection) {
      setStatus("error");
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(word);
    selection.removeAllRanges();
    selection.addRange(range);
    const rect = word.getBoundingClientRect();
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    word.dispatchEvent(new MouseEvent("mousedown", eventOptions));
    word.dispatchEvent(new MouseEvent("mouseup", eventOptions));
  }

  function requestLookup() {
    if (!reader) return;
    setStatus("connecting");
    reader.hide("preview-refresh");
    window.requestAnimationFrame(selectPreviewWord);
  }

  function previewLogger(level, message) {
    if (level !== "warn" && level !== "error") return;
    const text = String(message || "");
    if (text.includes("socket.closed")) {
      setStatus("connecting");
      return;
    }
    if (
      text.includes("socket.error") ||
      text.includes("socket.connect-failed") ||
      text.includes("lookup.timed-out") ||
      text.includes("lookup.failed")
    ) {
      setStatus("error");
    }
  }

  function createReader(preferences) {
    const api = window.GSMHoshidictsReader;
    if (!api || typeof api.createHoshidictsReader !== "function") {
      setStatus("error");
      return null;
    }
    return api.createHoshidictsReader({
      ...preferences,
      serverUrl: SERVER_URL,
      activationKeyPressed: true,
      audioController: createPreviewAudioController(),
      logger: {
        debug() {},
        info(message) {
          previewLogger("info", message);
        },
        warn(message) {
          previewLogger("warn", message);
        },
        error(message) {
          previewLogger("error", message);
        },
        log() {}
      },
      onPopupStateChange(visible) {
        if (visible) setStatus("ready");
      },
      async getMiningStatus() {
        return { available: true };
      },
      async onMine() {
        return { success: false, error: "preview-only" };
      },
      async onBrowse() {},
      async onOpenExternalLink() {},
      async onAddCustomEntry() {
        return { success: true };
      },
      async onLookup() {
        return {
          success: true,
          lookupCount: LOOKUP_COUNT,
          seenCount: SEEN_COUNT
        };
      }
    });
  }

  function applyPreferences(preferences) {
    const refresh = needsFreshLookup(currentPreferences, preferences);
    currentPreferences = preferences;
    if (!reader) {
      reader = createReader(preferences);
      if (reader) requestLookup();
      return;
    }
    reader.updatePreferences(preferences);
    if (refresh) requestLookup();
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window.parent ||
      !isParentOrigin(event.origin) ||
      !isRecord(event.data)
    ) {
      return;
    }
    const message = event.data;
    if (message.channel !== PREVIEW_CHANNEL) return;
    if (message.type === "refresh") {
      requestLookup();
      return;
    }
    if (
      message.type === "preferences" &&
      isReaderPreferences(message.preferences)
    ) {
      applyPreferences(message.preferences);
    }
  });

  window.addEventListener("beforeunload", () => {
    if (reader) reader.destroy();
    reader = null;
  });

  setStatus("loading");
  post({ type: "frame-ready" });
})();
