// SPDX-License-Identifier: GPL-3.0-or-later

// Shows the Design controls a theme declares. Untagged controls are core and
// always show; "all", a missing entry or a missing declaration shows them all.
// A control the edited profile's language lacks (data-requirement-unmet, set
// by Settings from data-requires) stays hidden whatever the theme declares.
// Colours lists a theme's colour variants after Automatic and shows only for a
// theme whose entry has some.
// With the edited profile's language (docs/languages.md 11.4, 11.5): outside
// Japanese a theme without a language declaration hides the clicked-character
// dictionary.
export function applyDesignSettings(section, theme, { language = null } = {}) {
  const declared = Array.isArray(theme?.designSettings) ? theme.designSettings : null;
  // A language code, or a language object (11.1).
  const code = typeof language === "string" ? language : language?.code ?? null;
  const undeclaredOutsideJapanese = code !== null && code !== "ja" && !theme?.language;
  for (const control of section.querySelectorAll("[data-design-setting]")) {
    const key = control.dataset.designSetting;
    control.hidden = (declared !== null && !declared.includes(key))
      || "requirementUnmet" in control.dataset
      || (undeclaredOutsideJapanese && key === "kanjiClickDictionary");
  }
  for (const group of section.querySelectorAll("[data-design-group]")) {
    group.hidden = [...group.querySelectorAll("[data-design-setting]")].every(control => control.hidden);
  }
  const hint = section.querySelector("#popup-theme-hint");
  hint.hidden = declared === null;
  hint.textContent = declared === null ? ""
    : `${theme.name} uses only the settings shown here. Your other Design settings are kept for Default.`;
  const variants = Array.isArray(theme?.variants) ? theme.variants : [];
  const colours = section.querySelector("[data-theme-variants]");
  const select = colours.querySelector("select");
  select.replaceChildren(select.querySelector('option[value="auto"]'), ...variants.map(variant => {
    const option = section.ownerDocument.createElement("option");
    option.value = variant.id;
    option.textContent = variant.name;
    return option;
  }));
  colours.hidden = variants.length === 0;
}

// `onDesign(theme)` follows each catalogue entry the Design controls are
// filtered by (undefined when the catalogue cannot be read). `getLanguage()`
// gives the edited profile's language (a code or a language object) once the
// records have profiles.
export function createThemeStore({ root, design, onSelect, onDesign = null, getLanguage = () => null }) {
  const document = root.ownerDocument;
  const cards = new Map();
  let options;
  let loading;
  let catalogue;
  let designTheme;

  // The Store cards and the Design declarations share one catalogue read.
  function loadCatalogue() {
    catalogue ??= (async () => {
      const response = await fetch(new URL("vendor/themes/index.json", document.baseURI));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()).themes;
    })();
    return catalogue;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  // Colours shows the saved variant, or Automatic when this theme has no such variant.
  function renderVariant() {
    const select = design.querySelector("#opt-popup-theme-variant");
    if (select === document.activeElement) return;
    select.value = options.popupThemeVariant;
    if (select.selectedIndex < 0) select.value = "auto";
  }

  function updateSelection() {
    for (const [slug, button] of cards) {
      const selected = slug === globalThis.HDReaderOptions.popupRenderer(options.popupTheme);
      button.textContent = selected ? "Current theme" : "Use";
      button.setAttribute("aria-pressed", String(selected));
    }
  }

  async function load() {
    try {
      const themes = await loadCatalogue();
      const grid = root.querySelector(".theme-store-grid");
      for (const theme of themes) {
        const card = element("article", "theme-store-card");
        const image = element("img", "theme-store-preview");
        image.src = new URL(`vendor/themes/${theme.slug}/screenshot.png`, document.baseURI).href;
        image.alt = `${theme.name} dictionary popup preview`;
        const heading = element("h3", "", theme.name);
        const description = element("p", "hint", theme.description);
        const benchmark = element("a", "theme-store-benchmark", theme.benchmark);
        benchmark.href = theme.benchmarkUrl;
        benchmark.target = "_blank";
        benchmark.rel = "noopener noreferrer";
        const button = element("button", "ghost");
        button.type = "button";
        button.addEventListener("click", () => onSelect(theme.slug));
        card.append(image, heading, description, benchmark, button);
        cards.set(theme.slug, button);
        grid.append(card);
      }
      updateSelection();
      // The row only shows two or three cards, so Previous and Next themes
      // page it. Each disables (which hides it) at its end, the last pixel
      // counting as the end for fractional widths, and hands keyboard focus
      // to the other rather than dropping it.
      const previousButton = root.querySelector("#theme-store-previous");
      const nextButton = root.querySelector("#theme-store-next");
      const updateScrollButtons = () => {
        const focused = document.activeElement;
        previousButton.disabled = grid.scrollLeft <= 0;
        nextButton.disabled = grid.scrollLeft >= grid.scrollWidth - grid.clientWidth - 1;
        if (focused === nextButton && nextButton.disabled) previousButton.focus();
        else if (focused === previousButton && previousButton.disabled) nextButton.focus();
      };
      previousButton.addEventListener("click", () => grid.scrollBy({ left: -grid.clientWidth }));
      nextButton.addEventListener("click", () => grid.scrollBy({ left: grid.clientWidth }));
      grid.addEventListener("scroll", updateScrollButtons, { passive: true });
      // Also runs once the row first has a size (the store can load while
      // Design is hidden) and whenever it resizes.
      new ResizeObserver(updateScrollButtons).observe(grid);
    } catch (error) {
      root.querySelector(".theme-store-status").textContent = `Could not load bundled themes: ${error.message}`;
    }
  }

  // Every selection waits for the same catalogue read, so selections apply in
  // order and the latest wins.
  function updateDesign() {
    const slug = globalThis.HDReaderOptions.popupRenderer(options.popupTheme);
    if (slug === designTheme) return;
    designTheme = slug;
    void loadCatalogue().then(themes => themes.find(theme => theme.slug === slug)).catch(() => undefined)
      .then(theme => { applyDesignSettings(design, theme, { language: getLanguage() }); renderVariant(); onDesign?.(theme); });
  }

  return { render(next) {
    options = next;
    root.hidden = false;
    loading ??= load();
    updateSelection();
    updateDesign();
    renderVariant();
  },
  // Applies the theme's declarations again, as when the edited profile's
  // language changes what Design can show.
  invalidateDesign() {
    designTheme = undefined;
    if (options) updateDesign();
  } };
}
