import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n";
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

async function getInitialLocale(): Promise<string> {
  try {
    const settings = await window.ipcRenderer.invoke<{ locale?: string }>(
      "settings.getSettings"
    );
    return settings?.locale || "en";
  } catch (error) {
    console.error("Failed to load initial locale:", error);
    return "en";
  }
}

const root = createRoot(document.getElementById("root")!);

void getInitialLocale().then((initialLocale) => {
  root.render(
    <I18nProvider initialLocale={initialLocale}>
      <App />
    </I18nProvider>
  );
});
