import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import en from "./en.json";
import uk from "./uk.json";

type TranslationMap = typeof en;

const locales: Record<string, TranslationMap> = { en, uk };

export const SUPPORTED_LOCALES: Array<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "uk", label: "Українська" },
];

/**
 * Resolve a dot-separated key like "home.status.gsm" from a locale map.
 */
function resolve(locale: string, key: string): string {
  const parts = key.split(".");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = locales[locale] ?? locales.en;
  for (const part of parts) {
    if (node == null || typeof node !== "object") return key;
    node = node[part];
  }
  if (typeof node === "string") return node;
  // Fallback to English if the key is missing in the current locale
  if (locale !== "en") return resolve("en", key);
  return key;
}

/**
 * Interpolate `{name}` placeholders in a translated string.
 */
function interpolate(
  template: string,
  vars?: Record<string, string | number>
): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    vars[k] != null ? String(vars[k]) : `{${k}}`
  );
}

type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

interface I18nContextValue {
  locale: string;
  setLocale: (locale: string) => void;
  t: TranslateFn;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  initialLocale = "en",
  children,
}: {
  initialLocale?: string;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState(
    locales[initialLocale] ? initialLocale : "en"
  );

  const setLocale = useCallback((next: string) => {
    if (locales[next]) {
      setLocaleState(next);
    }
  }, []);

  const tFn: TranslateFn = useCallback(
    (key, vars) => interpolate(resolve(locale, key), vars),
    [locale]
  );

  const value = useMemo(
    () => ({ locale, setLocale, t: tFn }),
    [locale, setLocale, tFn]
  );

  return createElement(I18nContext, { value }, children);
}

/**
 * Translate a key, optionally interpolating variables.
 *
 * ```tsx
 * const t = useTranslation();
 * t("home.status.connected")           // "Connected"
 * t("home.status.processing", { words: "食べる" })  // "Processing: 食べる"
 * ```
 */
export function useTranslation(): TranslateFn {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Fallback for usage outside provider (e.g. tests without provider)
    return (key, vars) => interpolate(resolve("en", key), vars);
  }
  return ctx.t;
}

export function useLocale(): [string, (locale: string) => void] {
  const ctx = useContext(I18nContext);
  if (!ctx) return ["en", () => {}];
  return [ctx.locale, ctx.setLocale];
}

/**
 * Standalone translate (outside React tree). Always uses English.
 */
export function t(
  key: string,
  vars?: Record<string, string | number>
): string {
  return interpolate(resolve("en", key), vars);
}
