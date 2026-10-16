// Discoverability layer for the overlay settings window. Runs after bootstrap.
// Adds setting descriptions, precise jump links, and cross-page search using
// settings-metadata.js. Home shortcuts share the original controls' bindings.
// No persistence or overlay behavior is touched.
(function (global) {
  "use strict";

  const descriptions = global.GSM_SETTING_DESCRIPTIONS || {};
  const groupKeywords = global.GSM_GROUP_KEYWORDS || {};

  let ipcRenderer = null;
  try {
    ipcRenderer = require("electron").ipcRenderer;
  } catch {
    /* not in an Electron renderer (e.g. tests) */
  }

  function switchToTab(tab) {
    if (typeof global.updateSettingsTabVisibility === "function") {
      global.updateSettingsTabVisibility(tab);
    }
  }

  // ----- 1. Inline descriptions -------------------------------------------------
  function injectDescriptions() {
    Object.entries(descriptions).forEach(([id, text]) => {
      const control = document.getElementById(id);
      if (!control) return;
      const label = control.closest("label");
      if (!label) return;
      const labelText = label.querySelector(".label-text");
      if (!labelText) return;
      // Don't double up where the markup already explains the setting.
      if (labelText.querySelector(".hotkey-info, .setting-desc")) return;
      const desc = document.createElement("div");
      desc.className = "setting-desc";
      desc.textContent = text;
      labelText.appendChild(desc);
    });
  }

  // ----- Jump to a setting on its full page ------------------------------------
  function jumpToSetting(id, fallbackTab) {
    const control = document.getElementById(id);
    const tab = control?.closest("[data-page]")?.dataset.page || fallbackTab;
    clearSearch();
    if (tab) switchToTab(tab);
    if (!control) return;
    const target = control.closest("label") || control;
    // Open the surrounding collapsible section if the setting lives in one.
    const details = control.closest("details.setting-section");
    if (details) details.open = true;
    requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.remove("setting-flash");
      // reflow so the animation restarts even on repeat clicks
      void target.offsetWidth;
      target.classList.add("setting-flash");
    });
  }
  global.gsmJumpToSetting = jumpToSetting;

  // ----- Cross-tab search -------------------------------------------------------
  let searchIndex = [];
  const openedDetails = new Map();

  function keywordsFor(headingCtx) {
    let keywords = "";
    Object.entries(groupKeywords).forEach(([needle, terms]) => {
      if (headingCtx.includes(needle)) keywords += " " + terms;
    });
    return keywords;
  }

  function buildSearchIndex() {
    const groups = Array.from(document.querySelectorAll(".setting-group[data-tab]"));
    searchIndex = [];
    groups.forEach((group) => {
      const firstHeadingEl = group.querySelector("h4, summary");
      const firstHeading = firstHeadingEl ? firstHeadingEl.textContent.toLowerCase() : "";
      // Walk headings + labels in document order so each label inherits the
      // nearest sub-heading (groups like Live Stats bundle Fields + Pomodoro).
      let section = firstHeading;
      group.querySelectorAll("h4, h5, summary, label, .label-row, .preset-card").forEach((node) => {
        if (node.matches("h4, h5, summary")) {
          section = node.textContent.toLowerCase();
          return;
        }
        // Home edits the same settings. Index the detailed control once so
        // search results and counts do not duplicate its dashboard shortcut.
        if (node.querySelector("[data-setting-alias]")) return;
        const homeTerms = Array.from(node.querySelectorAll("input[id], select[id]"))
          .map((control) => global.GSMSettingsHome?.searchTermsFor(control.id) || "")
          .join(" ");
        const headingCtx = firstHeading + " " + section;
        const region = node.closest("[data-page]");
        const page = global.GSMSettingsNavigation.pages.find((page) => page.id === region?.dataset.page);
        searchIndex.push({
          label: node,
          group,
          region,
          text: (
            node.textContent +
            " " +
            homeTerms +
            " " +
            headingCtx +
            " " +
            keywordsFor(headingCtx) +
            " " +
            (page ? `${page.categoryLabel} ${page.label}` : "")
          ).toLowerCase(),
        });
      });
    });
    document.querySelectorAll("[data-page]").forEach((region) => {
      const page = global.GSMSettingsNavigation.pages.find((page) => page.id === region.dataset.page);
      if (!page) return;
      const location = document.createElement("div");
      location.className = "settings-search-location";
      location.textContent = `${page.categoryLabel} / ${page.label}`;
      region.prepend(location);
    });
  }

  function clearSearchStyles() {
    searchIndex.forEach((entry) => {
      entry.label.classList.remove("search-hidden");
    });
    openedDetails.forEach((open, details) => {
      details.open = open;
    });
    openedDetails.clear();
  }

  function clearSearch(restore = true) {
    const input = document.getElementById("settingsSearchInput");
    if (input) input.value = "";
    if (!document.body.classList.contains("search-active")) return;
    document.body.classList.remove("search-active");
    clearSearchStyles();
    setSearchStatus(0, 0, false);
    if (restore) global.GSMSettingsNavigation.refresh();
  }

  function setSearchStatus(matches, queryLen, active) {
    const count = document.getElementById("settingsSearchCount");
    const noResults = document.getElementById("settingsSearchNoResults");
    const plural = matches === 1 ? "" : "es";
    if (count) count.textContent = active && queryLen ? `${matches} match${plural}` : "";
    if (noResults) noResults.hidden = !(active && queryLen && matches === 0);
  }

  function applySearch(rawQuery) {
    const query = rawQuery.trim().toLowerCase();
    if (!query) {
      clearSearch();
      return;
    }
    document.body.classList.add("search-active");

    const matchedGroups = new Set();
    const matchedRegions = new Set();
    let matchCount = 0;
    searchIndex.forEach((entry) => {
      // Navigation hides whole pages; language/backend/platform rules hide
      // individual controls. Search should preserve those applicability rules.
      let applicable = true;
      for (let node = entry.label; node && node.id !== "settingsContent"; node = node.parentElement) {
        if (node.style.display === "none" || (node.hidden && !node.matches("[data-page], .setting-group"))) {
          applicable = false;
          break;
        }
      }
      const isMatch = applicable && entry.text.includes(query);
      entry.label.classList.toggle("search-hidden", !isMatch);
      if (isMatch) {
        matchCount += 1;
        matchedGroups.add(entry.group);
        if (entry.region) matchedRegions.add(entry.region);
        let details = entry.label.closest("details");
        while (details) {
          if (!openedDetails.has(details)) openedDetails.set(details, details.open);
          details.open = true;
          details = details.parentElement?.closest("details");
        }
      }
    });

    document.querySelectorAll(".setting-group[data-tab]").forEach((group) => {
      const show = matchedGroups.has(group);
      group.hidden = !show;
    });

    document.querySelectorAll("[data-page]").forEach((region) => {
      region.hidden = !matchedRegions.has(region);
    });

    global.GSMSettingsNavigation.refresh();
    setSearchStatus(matchCount, query.length, true);
  }

  function wireSearch() {
    const input = document.getElementById("settingsSearchInput");
    const clearBtn = document.getElementById("settingsSearchClear");
    if (input) {
      input.addEventListener("input", () => applySearch(input.value));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          clearSearch();
          input.blur();
        }
      });
    }
    if (clearBtn)
      clearBtn.addEventListener("click", () => {
        clearSearch();
        input?.focus();
      });
    // Navigation owns all entry points, including cards and external IPC requests.
    document.addEventListener("gsm-settings-before-navigate", () => clearSearch(false));
    const refreshSearch = () => {
      if (document.body.classList.contains("search-active")) applySearch(input.value);
    };
    document.getElementById("settingsContent").addEventListener("change", refreshSearch);
    if (ipcRenderer) {
      ipcRenderer.on("preload-settings", () => setTimeout(refreshSearch, 0));
      ipcRenderer.on("settings-updated", () => setTimeout(refreshSearch, 0));
    }
  }

  function init() {
    injectDescriptions();

    buildSearchIndex();
    wireSearch();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(typeof window !== "undefined" ? window : globalThis);
