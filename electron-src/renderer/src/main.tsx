import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n";
import { applyTheme } from "./lib/theme";
import "./styles.css";
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

async function getInitialSettings(): Promise<{ locale: string; theme?: string }> {
  try {
    const settings = await window.ipcRenderer.invoke<{
      locale?: string;
      theme?: string;
    }>("settings.getSettings");
    return { locale: settings?.locale || "en", theme: settings?.theme };
  } catch (error) {
    console.error("Failed to load initial settings:", error);
    return { locale: "en" };
  }
}

const root = createRoot(document.getElementById("root")!);

void getInitialSettings().then(({ locale, theme }) => {
  // Apply the persisted theme before first paint to avoid a flash.
  applyTheme(theme);
  root.render(
    <I18nProvider initialLocale={locale}>
      <App />
    </I18nProvider>
  );
});
