// Theme switching for the renderer. Themes are daisyUI palettes selected via the
// `data-theme` attribute on <html> (see styles.css). The shared catalogue keeps
// this picker and Hoshidicts aligned.

import {
  DEFAULT_GSM_THEME,
  GSM_THEME_DEFINITIONS,
  GSM_THEME_GROUP_DEFINITIONS,
  isGsmTheme,
  type GsmThemeCategory,
  type GsmThemeId
} from "../../../shared/themes";

export type ThemeCategory = GsmThemeCategory;

export interface ThemeOption {
  id: GsmThemeId;
  category: ThemeCategory;
  labelKey?: string;
  label?: string;
}

export const THEMES: ThemeOption[] = GSM_THEME_DEFINITIONS.map((theme) => ({
  ...theme
}));

export interface ThemeGroup {
  category: ThemeCategory;
  labelKey: string;
  themes: ThemeOption[];
}

// Ordered groups for the theme picker (<optgroup>s).
export const THEME_GROUPS: ThemeGroup[] = GSM_THEME_GROUP_DEFINITIONS.map(
  (group) => ({
    category: group.id,
    labelKey: group.labelKey,
    themes: THEMES.filter((theme) => theme.category === group.id)
  })
);

export const DEFAULT_THEME: GsmThemeId = DEFAULT_GSM_THEME;

export const THEME_CHANGED_EVENT = "gsm-theme-changed";

export function normalizeTheme(theme: string | undefined | null): GsmThemeId {
  return isGsmTheme(theme) ? theme : DEFAULT_THEME;
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
