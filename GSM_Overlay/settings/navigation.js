// Presentation only: categories and pages never write overlay settings.
(function (global) {
  "use strict";

  const categories = [
    {
      id: "overview",
      label: "Home",
      icon: "home",
      pages: [["start", "Your overlay", "Choose a setup, then adjust your everyday settings in one place."]],
    },
    {
      id: "reading",
      label: "Reading & display",
      icon: "book",
      pages: [
        ["indicators", "Indicators", "Choose which capture and connection indicators appear over your game."],
        ["readings", "Readings", "Show Japanese furigana or Chinese pinyin, and control when readings appear."],
        ["appearance", "Appearance", "Adjust reading colors, outlines, and type to suit your game."],
        ["tokenizer", "Tokenizer", "Choose how Japanese text is split into words and readings."],
        ["jiten", "Jiten", "Connect Jiten Reader and configure vocabulary highlighting."],
      ],
    },
    {
      id: "capture",
      label: "Capture & OCR",
      icon: "scan",
      pages: [
        [
          "source",
          "Capture source",
          "Choose your OCR engine, monitor, and capture areas. These settings follow your GSM profile.",
        ],
        ["scanning", "Scanning", "Control when the overlay scans for new text."],
        ["results", "Results", "Decide how captured text is filtered, combined, and kept up to date."],
        ["alignment", "Alignment", "Calibrate overlay text if it does not line up with your game."],
        ["advanced", "Advanced", "Extra capture options. Keep the defaults unless you need to troubleshoot."],
      ],
    },
    {
      id: "interaction",
      label: "Interaction",
      icon: "cursor",
      pages: [
        ["reveal", "Push to show", "Reveal the overlay by holding a key or toggling it on demand."],
        ["hotkeys", "Hotkeys", "Set keyboard shortcuts for overlay windows and actions."],
        ["behavior", "Startup & behavior", "Choose how the overlay opens, focuses, and responds to inactivity."],
      ],
    },
    {
      id: "gamepad",
      label: "Controller",
      icon: "controller",
      pages: [
        ["setup", "Setup", "Enable controller navigation and choose how to activate it."],
        [
          "bindings",
          "Button bindings",
          "Assign controller buttons and keyboard equivalents to navigation and game actions.",
        ],
        ["navigation", "Navigation", "Tune word selection, visibility, and repeat speed."],
        ["advanced", "Advanced", "Adjust held directions, block movement, and cursor behavior."],
        ["devices", "Devices & testing", "Manage controller listeners, ignore devices, and test incoming input."],
      ],
    },
    {
      id: "tools",
      label: "Widgets & tools",
      icon: "grid",
      pages: [
        ["stats", "Stats & goals", "Keep reading stats and your selected goals visible while you play."],
        ["pomodoro", "Pomodoro", "Set focus and break reminders for your reading sessions."],
        ["textfeed", "TextFeed", "Revisit captured lines in a separate reading window."],
        ["guide", "VN Guide", "Follow a walkthrough one step at a time without exposing future choices."],
        ["custom", "Custom page", "Open a useful website alongside your game."],
        ["translation", "Translation", "Configure translation requests and the translation shortcut."],
      ],
    },
    {
      id: "system",
      label: "System",
      icon: "settings",
      pages: [
        ["dictionary", "Dictionary", "Select and configure the dictionary used for lookups."],
        ["profiles", "Profiles", "Manage how overlay settings follow your GSM profiles."],
        ["developer", "Developer", "Platform overrides for testing and troubleshooting."],
      ],
    },
  ];
  const icons = {
    home: '<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>',
    book: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/>',
    scan: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 9h10M7 13h7M7 17h4"/>',
    cursor: '<path d="m5 3 14 9-7 1-3 7Z"/>',
    controller:
      '<path d="M7 7h10c3 0 5 11 2 11-2 0-3-4-5-4h-4c-2 0-3 4-5 4-3 0-1-11 2-11Z"/><path d="M8 9v4m-2-2h4m6-1h.01m2 2h.01"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    settings: '<path d="m9 3-1 3-3 1-2 4 2 2v4l4 2 3-1 3 1 4-2v-4l2-2-2-4-3-1-1-3Z"/><circle cx="12" cy="11" r="3"/>',
  };
  const pages = categories.flatMap((category) =>
    category.pages.map(([slug, label, description]) => ({
      id: `${category.id}-${slug}`,
      category: category.id,
      categoryLabel: category.label,
      label,
      description,
    })),
  );
  const remembered = new Map();
  const unavailable = new Set();
  let activePage = pages[0];

  function refresh() {
    const searching = document.body.classList.contains("search-active");
    document.querySelectorAll("[data-settings-tab]").forEach((button) => {
      const active = button.dataset.settingsTab === activePage.category;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll("[data-settings-page]").forEach((button) => {
      const page = pages.find((item) => item.id === button.dataset.settingsPage);
      button.hidden = page.category !== activePage.category || unavailable.has(page.id);
      const active = page.id === activePage.id;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    document.getElementById("settingsCategoryTitle").textContent = activePage.categoryLabel;
    document.getElementById("settingsSubtabs").setAttribute("aria-label", `${activePage.categoryLabel} pages`);
    document.getElementById("settingsSubtabs").hidden =
      pages.filter((page) => page.category === activePage.category).length < 2;
    document
      .getElementById("settingsCategoryPanel")
      .setAttribute("aria-labelledby", `settings-category-${activePage.category}`);
    const panel = document.getElementById("settingsPagePanel");
    if (searching) {
      panel.removeAttribute("aria-labelledby");
      panel.setAttribute("aria-label", "Search results");
    } else {
      panel.removeAttribute("aria-label");
      panel.setAttribute("aria-labelledby", `settings-page-${activePage.id}`);
    }
    document.getElementById("settingsPageTitle").textContent = searching ? "Search results" : activePage.label;
    document.getElementById("settingsPageDescription").textContent = searching
      ? "Matching settings from every category. Clear the search or choose a tab to return."
      : activePage.description;
    if (searching) return;
    document.querySelectorAll("[data-page]").forEach((region) => {
      region.hidden = region.dataset.page !== activePage.id;
    });
    document.querySelectorAll(".setting-group[data-tab]").forEach((group) => {
      const region = group.closest("[data-page]");
      group.hidden = region ? region.hidden : !group.querySelector(`[data-page="${activePage.id}"]`);
    });
  }

  function navigate(destination) {
    if (destination === "overview-setups") destination = "overview-start";
    const category = categories.find((item) => item.id === destination);
    const available = pages.filter((page) => !unavailable.has(page.id));
    const next = category
      ? available.find((page) => page.id === remembered.get(category.id)) ||
        available.find((page) => page.category === category.id)
      : available.find((page) => page.id === destination);
    if (!next) return;
    document.dispatchEvent(new Event("gsm-settings-before-navigate"));
    activePage = next;
    remembered.set(next.category, next.id);
    refresh();
    // A category switch should not strand the reader halfway down a new page.
    document.getElementById("settingsPagePanel").scrollTop = 0;
    if (next.category === "gamepad" && typeof global.renderGamepadInputConsole === "function") {
      global.renderGamepadInputConsole();
    }
  }

  function wireTabKeys(list, selector, vertical) {
    list.addEventListener("keydown", (event) => {
      const current = event.target.closest(selector);
      if (!current) return;
      const buttons = Array.from(list.querySelectorAll(selector)).filter((button) => !button.hidden);
      const index = buttons.indexOf(current);
      let next;
      if (event.key === "Home") next = 0;
      else if (event.key === "End") next = buttons.length - 1;
      else if (event.key === (vertical ? "ArrowDown" : "ArrowRight")) next = (index + 1) % buttons.length;
      else if (event.key === (vertical ? "ArrowUp" : "ArrowLeft")) next = (index + buttons.length - 1) % buttons.length;
      else return;
      event.preventDefault();
      buttons[next].click();
      buttons[next].focus();
    });
  }

  function initializeSettingsTabs() {
    const categoryMount = document.getElementById("settingsCategories");
    const pageMount = document.getElementById("settingsSubtabs");
    categoryMount.replaceChildren(
      ...categories.map((category) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "settings-tab-button";
        button.id = `settings-category-${category.id}`;
        button.dataset.settingsTab = category.id;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-controls", "settingsCategoryPanel");
        button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[category.icon]}</svg><span>${category.label}</span>`;
        button.addEventListener("click", () => navigate(category.id));
        return button;
      }),
    );
    pageMount.replaceChildren(
      ...pages.map((page) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "settings-subtab-button";
        button.id = `settings-page-${page.id}`;
        button.dataset.settingsPage = page.id;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-controls", "settingsPagePanel");
        button.textContent = page.label;
        button.addEventListener("click", () => navigate(page.id));
        return button;
      }),
    );
    document.querySelectorAll("[data-open-page]").forEach((button) => {
      button.addEventListener("click", () => navigate(button.dataset.openPage));
    });
    wireTabKeys(categoryMount, "[data-settings-tab]", true);
    wireTabKeys(pageMount, "[data-settings-page]", false);
    document.body.classList.add("tabs-initialized");
    refresh();
  }

  function setPageAvailable(id, available) {
    if (available) unavailable.delete(id);
    else unavailable.add(id);
    if (unavailable.has(activePage.id)) navigate(activePage.category);
    else refresh();
  }

  global.GSMSettingsNavigation = {
    pages,
    navigate,
    refresh,
    setPageAvailable,
    get activePage() {
      return activePage;
    },
    get availablePages() {
      return pages.filter((page) => !unavailable.has(page.id));
    },
  };
  global.updateSettingsTabVisibility = navigate; // Existing shortcuts and System IPC requests.
  global.initializeSettingsTabs = initializeSettingsTabs;
})(window);
