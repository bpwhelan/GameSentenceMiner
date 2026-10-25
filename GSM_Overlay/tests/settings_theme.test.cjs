const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const sourcePath = path.join(__dirname, "../settings/theme.js");

function createSettingsTheme({ savedTheme = "solarized-light", request, inProcess = true, readConfig } = {}) {
  const ipc = new EventEmitter();
  ipc.invoke = request || (async () => savedTheme);
  const window = new EventEmitter();
  window.addEventListener = window.on.bind(window);
  const document = { documentElement: { dataset: { theme: "gsm-dark" } } };
  vm.runInNewContext(fs.readFileSync(sourcePath, "utf8"), {
    document,
    window,
    process: { env: { GSM_DATA_DIR: "/gsm-data", GSM_OVERLAY_IN_PROCESS: inProcess ? "1" : undefined } },
    require: (id) => {
      if (id === "electron") return { ipcRenderer: ipc };
      if (id === "node:fs") return { readFileSync: readConfig || (() => JSON.stringify({ theme: savedTheme })) };
      return require(id);
    },
  });
  return { ipc, window, document };
}

test("settings starts with the saved app theme and follows live changes", async () => {
  const { document, ipc } = createSettingsTheme();
  assert.equal(document.documentElement.dataset.theme, "solarized-light");
  await new Promise(setImmediate);
  ipc.emit("settings.themeChanged", {}, "catppuccin-mocha");
  assert.equal(document.documentElement.dataset.theme, "catppuccin-mocha");
});

test("a slow initial request cannot overwrite a newer theme change", async () => {
  let resolve;
  const { document, ipc } = createSettingsTheme({ request: () => new Promise((done) => { resolve = done; }) });
  ipc.emit("settings.themeChanged", {}, "high-contrast");
  resolve("solarized-light");
  await new Promise(setImmediate);
  assert.equal(document.documentElement.dataset.theme, "high-contrast");
});

test("settings keeps the saved theme when the app IPC is unavailable", async () => {
  const { document, window } = createSettingsTheme({ request: async () => { throw new Error("No handler"); } });
  await new Promise(setImmediate);
  assert.equal(document.documentElement.dataset.theme, "solarized-light");
  window.emit("focus");
  await new Promise(setImmediate);
  assert.equal(document.documentElement.dataset.theme, "solarized-light");
});

test("standalone settings refreshes the saved theme on focus without desktop IPC", () => {
  let theme = "solarized-light";
  const { document, window } = createSettingsTheme({
    inProcess: false,
    readConfig: () => JSON.stringify({ theme }),
    request: () => { assert.fail("Standalone settings must not invoke desktop IPC"); },
  });
  theme = "nord";
  window.emit("focus");
  assert.equal(document.documentElement.dataset.theme, "nord");
});

test("missing or invalid desktop preferences preserve the default palette", () => {
  for (const readConfig of [() => { throw new Error("File missing"); }, () => "{"]) {
    const { document } = createSettingsTheme({ inProcess: false, readConfig });
    assert.equal(document.documentElement.dataset.theme, "gsm-dark");
  }
});
