import React from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "./i18n";
import { TooltipLayer } from "./components/Tooltip";
import { installDevPreviewBridge } from "./lib/devPreview";
import { applyTheme } from "./lib/theme";
import { startSeasonalEffects } from "./lib/seasonal";
import "./styles.css";
import "./seasonal.css";
import "@xterm/xterm/css/xterm.css";

const devToolsBanner = "Download the React DevTools for a better development experience";

const originalConsoleInfo = console.info.bind(console);
const originalConsoleLog = console.log.bind(console);

const suppressReactDevtoolsBanner = (original: (...args: unknown[]) => void) => {
  return (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && first.includes(devToolsBanner)) {
      return;
    }
    original(...args);
  };
};

console.info = suppressReactDevtoolsBanner(originalConsoleInfo);
console.log = suppressReactDevtoolsBanner(originalConsoleLog);

const desktopReady = Promise.resolve().then(() => installDevPreviewBridge());

async function getInitialSettings(): Promise<{ locale: string; theme?: string; seasonalEffectsDisabled?: boolean }> {
  try {
    const settings = await window.ipcRenderer.invoke<{
      locale?: string;
      theme?: string;
      seasonalEffectsDisabled?: boolean;
    }>("settings.getSettings");
    return { locale: settings?.locale || "en", theme: settings?.theme, seasonalEffectsDisabled: settings?.seasonalEffectsDisabled };
  } catch (error) {
    console.error("Failed to load initial settings:", error);
    return { locale: "en" };
  }
}

const root = createRoot(document.getElementById("root")!);
const windowKind = new URLSearchParams(window.location.search).get("window");
function loadWindow() {
  switch (windowKind) {
    case "anki-confirmation":
    case "session-review":
      return import("./components/CardReviewWindow").then(module => module.CardReviewWindow);
    case "anki-grouping":
      return import("./components/AnkiGroupingDialog").then(module => module.AnkiGroupingDialog);
    case "screenshot-selector":
      return import("./components/ScreenshotSelector").then(module => module.ScreenshotSelector);
    case "furigana-preview":
      return import("./components/FuriganaPreview").then(module => module.FuriganaPreview);
    case "recommended-anki":
      return import("./components/RecommendedAnkiSetup").then(module => module.RecommendedAnkiSetup);
    case "ocr-area-selector":
      return import("./components/OcrAreaSelector").then(module => module.OcrAreaSelector);
    case "scene-switcher-picker":
      return import("./components/SceneSwitchConflictWindow").then(module => module.SceneSwitchConflictWindow);
    default:
      return import("./App").then(module => module.default);
  }
}

void Promise.all([desktopReady.then(getInitialSettings), loadWindow()]).then(([{ locale, theme, seasonalEffectsDisabled }, WindowContent]) => {
  // Apply the persisted theme before first paint to avoid a flash.
  applyTheme(theme);
  startSeasonalEffects(seasonalEffectsDisabled === true);
  root.render(
    <I18nProvider initialLocale={locale}>
      <TooltipLayer />
      <WindowContent />
    </I18nProvider>
  );
});
