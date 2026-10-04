// Select a bundled renderer before constructing popup content. The renderers
// implement the existing core view contract; only their DOM and CSS differ.
// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  "use strict";
  const RENDER_METHODS = new Set(["renderResults", "renderKanji", "renderNotice", "renderLookupFailure"]);
  const METHODS = [...RENDER_METHODS, "captureTermView", "currentEntryIndex", "focusEntry", "hideImagePreview",
    "scheduleMasonry", "setDefinitionBlurState", "setLookupStats", "setToolbarPosition", "setCustomButtons",
    "setSourceHighlightEnabled", "updateDictionaryPresentation", "flushDictionaryPresentation", "closeNoteForm"];

  function createThemeHost({ getOptions, onReady = () => {}, assetUrl = path => chrome.runtime.getURL(path) }) {
    const cache = new Map();
    const views = new Set();
    const disabled = new Set();
    let current, shadow, sheet, fallbackStyle, pending;
    const selected = () => {
      const name = window.HDReaderOptions.popupRenderer(getOptions().popupTheme);
      return disabled.has(name) ? "default" : name;
    };
    const asset = async path => {
      const response = await fetch(assetUrl(path));
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      return response.text();
    };

    function load(name) {
      if (!cache.has(name)) cache.set(name, (async () => {
        const [css, icons, module] = await Promise.all([
          asset(name === "default" ? "render/reader.css" : `vendor/themes/${name}/theme.css`),
          name === "plain" ? "" : asset("icons.css"),
          name === "default" ? null : import(assetUrl(`vendor/themes/${name}/theme.js`)),
        ]);
        if (module && (module.default?.schema !== 2 || module.default.slug !== name
            || typeof module.default.createView !== "function")) throw new Error("Unsupported renderer contract");
        return { name, css: `${css}\n${icons}`, dictionaryStyles: name === "default" || name === "bee",
          createView: module?.default.createView ?? window.HDPopup.createPopupView };
      })());
      return cache.get(name);
    }

    function applyCss() {
      if (!shadow || !current) return;
      try {
        sheet ??= new shadow.ownerDocument.defaultView.CSSStyleSheet();
        sheet.replaceSync(current.css);
        shadow.adoptedStyleSheets = [sheet, ...shadow.adoptedStyleSheets.filter(value => value !== sheet)];
      } catch {
        // Preserve the existing plain-style path for DOMs without constructed sheets.
        fallbackStyle ??= shadow.ownerDocument.createElement("style");
        fallbackStyle.textContent = current.css;
        shadow.prepend(fallbackStyle);
      }
      shadow.host.dataset.hoshidictsRenderer = current.name;
      let palette = getOptions().popupTheme;
      if (current.name !== "default") palette = current.name;
      else if (disabled.has(palette)) palette = "default";
      else if (palette === "auto") {
        palette = shadow.ownerDocument.defaultView.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      shadow.host.dataset.hoshidictsTheme = palette;
      for (const style of shadow.querySelectorAll("style[data-hoshidicts-dictionary-style]")) style.remove();
    }

    function fail(error) {
      if (selected() === "default") throw error;
      disabled.add(selected());
      console.warn("hachidori: theme renderer failed; using Default for this page", error);
      return sync();
    }

    async function sync() {
      const name = selected();
      if (current?.name === name) return;
      if (pending?.name === name) return pending.promise;
      const promise = load(name).then(next => {
        if (selected() !== name) return;
        current = next;
        applyCss();
        for (const view of views) view.rebuild();
        onReady();
      }).catch(fail).finally(() => { if (pending?.promise === promise) pending = null; });
      pending = { name, promise };
      return promise;
    }

    function createView(options) {
      let view, lastRender;
      let destroyed = false;
      const settings = new Map();
      const components = { createLookupActions: window.HDPopup.createLookupActions,
        createDictionaryTabs: window.HDPopup.createDictionaryTabs,
        glossaryToPlainText: window.HDGlossary.glossaryToPlainText,
        buildPitchAccentMorae: window.HDGlossary.buildPitchAccentMorae, pitchAccentPositions: window.HDGlossary.pitchAccentPositions,
        createAudioControl: window.HDPopup.createAudioControl, deinflectionSteps: window.HDPopup.deinflectionSteps,
        createImagePreview: window.HDPopup.createImagePreview,
        findDifferentDictionary: window.HDPopup.findDifferentDictionary, popupCoordinateScale: window.HDPopup.popupCoordinateScale };
      const record = { rebuild() {
        if (destroyed || !current) return;
        const viewport = view?.captureTermView?.();
        options.onRendererRetired?.();
        view?.destroy();
        view = null;
        options.popup.replaceChildren();
        try {
          view = current.createView({ ...options, components });
          if (lastRender) {
            const [method, args] = lastRender;
            if (method === "renderResults" && viewport) args[2] = { ...args[2], ...viewport };
            if (args[2]?.isCurrentRequest?.() !== false) call(method, args);
          }
          for (const [method, args] of settings) call(method, args);
        } catch (error) { void fail(error); }
      } };
      function call(method, args) {
        if (destroyed) return;
        if (RENDER_METHODS.has(method)) lastRender = [method, args];
        if (["setDefinitionBlurState", "setSourceHighlightEnabled", "setCustomButtons", "setToolbarPosition"].includes(method)) {
          settings.set(method, args);
        }
        if (method === "updateDictionaryPresentation" && ["renderResults", "renderKanji"].includes(lastRender?.[0])) {
          lastRender[1][2] = { ...lastRender[1][2], ...args[0] };
        }
        // Keep the latest model while the newly selected bundle loads. Never
        // construct the old renderer's content for a new selection.
        if (RENDER_METHODS.has(method) && current?.name !== selected()) {
          void sync();
          return;
        }
        try { return view?.[method]?.(...args); }
        catch (error) { void fail(error); }
      }
      views.add(record);
      record.rebuild();
      return {
        ...Object.fromEntries(METHODS.map(method => [method, (...args) => call(method, args)])),
        get scrollElement() { return view?.scrollElement ?? options.popup; },
        clear() { lastRender = null; settings.clear(); view?.clear(); },
        destroy() { destroyed = true; views.delete(record); view?.destroy(); },
      };
    }

    return { sync, createView,
      attach(root) { shadow = root; applyCss(); },
      get dictionaryStyles() { return current?.dictionaryStyles === true; },
    };
  }
  window.HDThemeHost = { createThemeHost };
}());
