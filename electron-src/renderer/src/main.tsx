import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
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

createRoot(document.getElementById("root")!).render(<App />);
