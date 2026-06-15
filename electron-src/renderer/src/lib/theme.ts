// Theme switching for the renderer. Themes are daisyUI palettes selected via the
// `data-theme` attribute on <html> (see styles.css). Keep ids in sync with the
// @plugin "daisyui/theme" / built-in theme names declared in styles.css.

export type ThemeCategory = "dark" | "light" | "highContrast";

export interface ThemeOption {
  id: string;
  category: ThemeCategory;
  /** i18n key for curated themes; falls back to `label` (proper-noun names). */
  labelKey?: string;
  label?: string;
}

// Curated themes: GSM default + our custom daisyUI/theme palettes, localized.
const CURATED_THEMES: ThemeOption[] = [
  { id: "gsm-dark", category: "dark", labelKey: "settings.desktop.themeGsmDark" },
  { id: "catppuccin-mocha", category: "dark", labelKey: "settings.desktop.themeCatppuccin" },
  { id: "solarized-dark", category: "dark", labelKey: "settings.desktop.themeSolarizedDark" },
  { id: "solarized-light", category: "light", labelKey: "settings.desktop.themeSolarizedLight" },
  { id: "high-contrast", category: "highContrast", labelKey: "settings.desktop.themeHighContrast" }
];

// All daisyUI 5 built-in themes (enabled via `themes: all` in styles.css),
// split by their color-scheme. Names are proper nouns, shown title-cased.
const DAISYUI_DARK_THEMES = [
  "dark", "synthwave", "halloween", "forest", "aqua", "black", "luxury",
  "dracula", "business", "night", "coffee", "dim", "sunset", "abyss"
];
const DAISYUI_LIGHT_THEMES = [
  "light", "cupcake", "bumblebee", "emerald", "corporate", "retro", "cyberpunk",
  "valentine", "garden", "lofi", "pastel", "fantasy", "wireframe", "cmyk",
  "autumn", "acid", "lemonade", "winter", "nord", "caramellatte", "silk"
];

function titleCase(id: string): string {
  return id.replace(/(^|-)([a-z])/g, (_, sep, ch) => (sep ? " " : "") + ch.toUpperCase());
}

export const THEMES: ThemeOption[] = [
  ...CURATED_THEMES,
  ...DAISYUI_DARK_THEMES.map((id): ThemeOption => ({ id, category: "dark", label: titleCase(id) })),
  ...DAISYUI_LIGHT_THEMES.map((id): ThemeOption => ({ id, category: "light", label: titleCase(id) }))
];

export interface ThemeGroup {
  category: ThemeCategory;
  labelKey: string;
  themes: ThemeOption[];
}

// Ordered groups for the theme picker (<optgroup>s).
export const THEME_GROUPS: ThemeGroup[] = [
  { category: "dark", labelKey: "settings.desktop.themeGroupDark" },
  { category: "light", labelKey: "settings.desktop.themeGroupLight" },
  { category: "highContrast", labelKey: "settings.desktop.themeGroupHighContrast" }
].map((group) => ({
  ...group,
  themes: THEMES.filter((theme) => theme.category === group.category)
}));

export const DEFAULT_THEME = "gsm-dark";

export const THEME_CHANGED_EVENT = "gsm-theme-changed";

const THEME_IDS = new Set(THEMES.map((theme) => theme.id));

export function normalizeTheme(theme: string | undefined | null): string {
  return theme && THEME_IDS.has(theme) ? theme : DEFAULT_THEME;
}

/** Apply a theme to <html> and notify listeners (e.g. xterm terminals). */
export function applyTheme(theme: string | undefined | null): void {
  const id = normalizeTheme(theme);
  document.documentElement.dataset.theme = id;
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: id }));
}

/** Read the active theme's base colors for xterm.js terminals. */
export function getTerminalColors(): { background: string; foreground: string } {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--color-base-100").trim() || "#1a1a1a",
    foreground: styles.getPropertyValue("--color-base-content").trim() || "#eeeeee"
  };
}
