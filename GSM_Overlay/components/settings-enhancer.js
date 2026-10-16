// Discoverability layer for the overlay settings window. Runs after bootstrap.
// Adds contextual help, precise jump links, and cross-page search using
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

  // ----- Contextual help -------------------------------------------------------
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

  let helpId = 0;
  let activeHelp = null;

  function positionHelp() {
    const { trigger, tooltip } = activeHelp;
    const rect = trigger.getBoundingClientRect();
    const tip = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - tip.width - 12))}px`;
    tooltip.style.top = `${Math.max(12, rect.bottom + tip.height + 8 < innerHeight ? rect.bottom + 8 : rect.top - tip.height - 8)}px`;
  }

  function hideHelp() {
    if (!activeHelp) return;
    activeHelp.tooltip.hidePopover();
    activeHelp.trigger.setAttribute("aria-expanded", "false");
    activeHelp = null;
  }

  function addHelp(copy, notes, control) {
    let trigger = copy.querySelector(".setting-help");
    if (trigger) {
      trigger.querySelector(".setting-tooltip").append(...notes);
      return;
    }
    const title = Array.from(copy.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent.trim())
      .join(" ")
      .trim();
    trigger = document.createElement("span");
    trigger.className = "setting-help";
    trigger.textContent = "?";
    trigger.tabIndex = 0;
    trigger.setAttribute("role", "button");
    trigger.setAttribute("aria-label", `Help for ${title}`);
    trigger.setAttribute("aria-expanded", "false");
    const tooltip = document.createElement("span");
    tooltip.id = `setting-help-${++helpId}`;
    tooltip.className = "setting-tooltip";
    tooltip.setAttribute("popover", "manual");
    tooltip.setAttribute("role", "tooltip");
    tooltip.append(...notes);
    trigger.setAttribute("aria-describedby", tooltip.id);
    if (control) {
      const ids = new Set(
        (control.getAttribute("aria-describedby") || "")
          .split(/\s+/)
          .filter((id) => id && !tooltip.contains(document.getElementById(id))),
      );
      ids.add(tooltip.id);
      control.setAttribute("aria-describedby", [...ids].join(" "));
    }
    trigger.append(tooltip);
    // Keep the help next to the title, ahead of any live warnings below it.
    const warning = Array.from(copy.children).find((node) => node.matches(".ctrl-warning, .status-note, [data-help-inline]"));
    copy.insertBefore(trigger, warning || null);

    const show = () => {
      if (activeHelp?.trigger === trigger) return;
      hideHelp();
      tooltip.showPopover();
      trigger.setAttribute("aria-expanded", "true");
      activeHelp = { trigger, tooltip };
      positionHelp();
    };
    trigger.addEventListener("pointerenter", show);
    trigger.addEventListener("pointerleave", () => {
      if (activeHelp?.trigger === trigger && document.activeElement !== trigger) hideHelp();
    });
    trigger.addEventListener("focus", show);
    trigger.addEventListener("blur", () => {
      if (activeHelp?.trigger === trigger) hideHelp();
    });
    trigger.addEventListener("click", (event) => {
      event.preventDefault(); // Help inside a label must not toggle its setting.
      event.stopPropagation();
      show();
    });
    trigger.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      show();
    });
  }

  function compactHelp() {
    document.querySelectorAll(".label-text").forEach((copy) => {
      const notes = Array.from(copy.children).filter(
        (node) =>
          node.matches(".hotkey-info, .setting-desc, .home-field-help") &&
          !node.matches(".ctrl-warning, .status-note, [role='status'], [aria-live], [data-help-inline]"),
      );
      if (notes.length) addHelp(copy, notes, copy.closest("label, .label-row")?.querySelector("input, select"));
    });
    // Long section introductions and advanced instructions belong to the
    // relevant heading or setting; live status and warnings remain inline.
    const sectionNotes = document.querySelectorAll(
      ".setting-group > .hotkey-info, .settings-page > .hotkey-info, .setting-group > .shared-setting-note",
    );
    sectionNotes.forEach((note) => {
      if (note.matches("[id], [role], [aria-live], .ctrl-warning, .status-note, [data-help-inline]") || note.querySelector("[id]")) return;
      let previous = note.previousElementSibling;
      while (previous && !previous.matches("h4, h5, label, .label-row, .settings-section-banner")) {
        previous = previous.previousElementSibling;
      }
      let copy = previous?.matches("label, .label-row") ? previous.querySelector(".label-text") : previous;
      if (copy?.matches(".settings-section-banner")) copy = copy.querySelector(".settings-section-banner-title");
      if (!copy || copy.matches(".sr-only")) copy = note.closest(".settings-page")?.querySelector(".settings-section-banner-title");
      if (copy) addHelp(copy, [note]);
    });
    document.addEventListener(
      "scroll",
      () => {
        if (!activeHelp) return;
        // Tabbing to help can scroll the focused title into view. Reposition it
        // after that scroll instead of immediately dismissing keyboard help.
        const rect = activeHelp.trigger.getBoundingClientRect();
        const panel = document.getElementById("settingsPagePanel").getBoundingClientRect();
        if (document.activeElement === activeHelp.trigger && rect.top >= panel.top && rect.bottom <= panel.bottom) {
          positionHelp();
        } else hideHelp();
      },
      { capture: true, passive: true },
    );
    document.addEventListener("gsm-settings-before-navigate", hideHelp);
    window.addEventListener("resize", hideHelp);
    document.getElementById("settingsSearchInput").addEventListener("input", hideHelp);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && activeHelp) {
        event.preventDefault();
        hideHelp();
      }
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

  function syncQuickFilterChips(activeQuery = "") {
    const normalized = activeQuery.trim().toLowerCase();
    document.querySelectorAll("[data-quick-filter]").forEach((chip) => {
      const active = Boolean(normalized) && chip.dataset.quickFilter.toLowerCase() === normalized;
      chip.classList.toggle("active", active);
      chip.setAttribute("aria-pressed", String(active));
    });
  }

  function clearSearch(restore = true) {
    const input = document.getElementById("settingsSearchInput");
    if (input) input.value = "";
    syncQuickFilterChips("");
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
    syncQuickFilterChips(query);
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
    document.querySelectorAll("[data-quick-filter]").forEach((chip) => {
      chip.addEventListener("click", () => {
        if (!input) return;
        const term = chip.dataset.quickFilter || "";
        if (input.value.trim().toLowerCase() === term.toLowerCase()) {
          clearSearch();
        } else {
          input.value = term;
          applySearch(term);
        }
      });
    });
    document.addEventListener("keydown", (e) => {
      if (!input) return;
      const isCmdOrCtrlF = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f";
      const activeEl = document.activeElement;
      const inEditable =
        activeEl &&
        (activeEl.matches("input, select, textarea, [contenteditable='true']") ||
          activeEl.classList.contains("capturing-hotkey") ||
          activeEl.classList.contains("capturing-binding"));
      if (isCmdOrCtrlF || (e.key === "/" && !inEditable && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault();
        input.focus();
        input.select();
      }
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
    compactHelp();

    buildSearchIndex();
    wireSearch();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(typeof window !== "undefined" ? window : globalThis);
