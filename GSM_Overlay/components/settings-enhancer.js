// Discoverability layer for the overlay settings window. Runs after the page's
// inline script (so updateSettingsTabVisibility() is already defined and tabs are
// initialized). It does three presentation-only things, driven by settings-metadata.js:
//   1. Injects a one-line description under every setting that lacks one.
//   2. Renders the Overview tab's capability cards (each jumps to a tab).
//   3. Powers the cross-tab search box (filters every setting by name/help/keywords).
// No persistence or overlay behavior is touched.
(function (global) {
  "use strict";

  const descriptions = global.GSM_SETTING_DESCRIPTIONS || {};
  const groupKeywords = global.GSM_GROUP_KEYWORDS || {};
  const capabilityCards = global.GSM_CAPABILITY_CARDS || [];

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

  function currentActiveTab() {
    const active = document.querySelector(".settings-tab-button.active[data-settings-tab]");
    return active ? active.dataset.settingsTab : "overview";
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

  // ----- jump-to-setting (used by capability cards + Overview callouts) ----------
  function jumpToSetting(id, fallbackTab) {
    const control = document.getElementById(id);
    const group = control?.closest(".setting-group[data-tab]");
    const tab = group?.dataset?.tab || fallbackTab;
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

  // ----- Red-boxes FAQ callout: only relevant while indicators are ON -----------
  function refreshRedBoxCallout() {
    const callout = document.getElementById("redBoxesCallout");
    const indicators = document.getElementById("showTextIndicators");
    if (!callout || !indicators) return;
    callout.classList.toggle("red-callout-hidden", !indicators.checked);
  }

  function wireRedBoxCallout() {
    const indicators = document.getElementById("showTextIndicators");
    if (indicators) indicators.addEventListener("change", refreshRedBoxCallout);
    // Settings arrive asynchronously over IPC; re-check after the page applies them.
    if (ipcRenderer) {
      const deferredRefresh = () => setTimeout(refreshRedBoxCallout, 0);
      ipcRenderer.on("preload-settings", deferredRefresh);
      ipcRenderer.on("settings-updated", deferredRefresh);
    }
    refreshRedBoxCallout();
  }

  // ----- 2. Capability cards (Overview tab) -------------------------------------
  function renderCapabilityCards() {
    const mount = document.getElementById("capabilityCards");
    if (!mount) return;
    mount.replaceChildren(...capabilityCards.map((card) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "capability-card";
      el.dataset.tab = card.tab;

      const title = document.createElement("div");
      title.className = "capability-card-title";
      title.textContent = `${card.icon ? card.icon + " " : ""}${card.title}`;

      const blurb = document.createElement("div");
      blurb.className = "capability-card-blurb";
      blurb.textContent = card.blurb;

      const cta = document.createElement("div");
      cta.className = "capability-card-cta";
      cta.textContent = "Open settings →";

      el.append(title, blurb, cta);
      el.addEventListener("click", () => switchToTab(card.tab));
      return el;
    }));
  }

  function wireOverviewCallouts() {
    document.querySelectorAll("[data-jump-setting]").forEach((btn) => {
      btn.addEventListener("click", () => {
        jumpToSetting(btn.dataset.jumpSetting, btn.dataset.jumpTab || undefined);
      });
    });
  }

  // ----- 3. Cross-tab search ----------------------------------------------------
  let searchIndex = [];

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
      group.querySelectorAll("h4, h5, summary, label").forEach((node) => {
        if (node.tagName !== "LABEL") {
          section = node.textContent.toLowerCase();
          return;
        }
        const headingCtx = firstHeading + " " + section;
        searchIndex.push({
          label: node,
          group,
          text: (node.textContent + " " + headingCtx + " " + keywordsFor(headingCtx)).toLowerCase(),
        });
      });
    });
  }

  function clearSearchStyles() {
    searchIndex.forEach((entry) => {
      entry.label.style.display = "";
    });
    document.querySelectorAll(".setting-group[data-tab]").forEach((g) => {
      g.style.display = "";
    });
    document.querySelectorAll(".settings-grid").forEach((grid) => {
      grid.style.display = "";
    });
  }

  function clearSearch() {
    const input = document.getElementById("settingsSearchInput");
    if (input) input.value = "";
    if (!document.body.classList.contains("search-active")) return;
    document.body.classList.remove("search-active");
    clearSearchStyles();
    setSearchStatus(0, 0, false);
    switchToTab(currentActiveTab());
  }

  function setSearchStatus(matches, queryLen, active) {
    const count = document.getElementById("settingsSearchCount");
    const noResults = document.getElementById("settingsSearchNoResults");
    const plural = matches === 1 ? "" : "es";
    if (count) count.textContent = active && queryLen ? `${matches} match${plural}` : "";
    if (noResults) noResults.style.display = active && queryLen && matches === 0 ? "block" : "none";
  }

  function applySearch(rawQuery) {
    const query = rawQuery.trim().toLowerCase();
    if (!query) {
      clearSearch();
      return;
    }
    document.body.classList.add("search-active");

    const matchedGroups = new Set();
    let matchCount = 0;
    searchIndex.forEach((entry) => {
      const isMatch = entry.text.includes(query);
      entry.label.style.display = isMatch ? "" : "none";
      if (isMatch) {
        matchCount += 1;
        matchedGroups.add(entry.group);
      }
    });

    document.querySelectorAll(".setting-group[data-tab]").forEach((group) => {
      const show = matchedGroups.has(group);
      group.style.display = show ? "block" : "none";
      if (show && group.tagName === "DETAILS") group.open = true;
    });

    document.querySelectorAll(".settings-grid").forEach((grid) => {
      const hasMatch = Array.from(matchedGroups).some((g) => grid.contains(g));
      grid.style.display = hasMatch ? "grid" : "none";
    });

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
    if (clearBtn) clearBtn.addEventListener("click", () => clearSearch());
    // Clicking any tab exits search so its inline styles don't fight the tab view.
    document.querySelectorAll(".settings-tab-button[data-settings-tab]").forEach((btn) => {
      btn.addEventListener("click", () => clearSearch());
    });
  }

  function init() {
    injectDescriptions();
    renderCapabilityCards();
    wireOverviewCallouts();
    wireRedBoxCallout();
    buildSearchIndex();
    wireSearch();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(typeof window !== "undefined" ? window : globalThis);
