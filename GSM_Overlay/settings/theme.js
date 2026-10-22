// Use the desktop theme before first paint, including when running standalone.
// The managed overlay also receives changes immediately through the shared IPC.
(() => {
  const { ipcRenderer } = require("electron");
  const { readFileSync } = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const dataDir = process.env.GSM_DATA_DIR || path.join(
    process.env.APPDATA || path.join(os.homedir(), ".config"), "GameSentenceMiner",
  );
  const configPath = path.join(dataDir, "electron", "config.json");
  let revision = 0;

  function applyTheme(theme) {
    document.documentElement.dataset.theme = typeof theme === "string" && theme ? theme : "gsm-dark";
  }

  function refreshTheme() {
    const requestRevision = ++revision;
    try {
      applyTheme(JSON.parse(readFileSync(configPath, "utf8")).theme);
    } catch {
      // A standalone overlay can run before GSM has saved desktop preferences.
    }
    if (process.env.GSM_OVERLAY_IN_PROCESS === "1") {
      void ipcRenderer.invoke("settings.getTheme").then((theme) => {
        if (revision === requestRevision) applyTheme(theme);
      }).catch(() => {
        // Older desktop hosts can still use the saved preference above.
      });
    }
  }

  ipcRenderer.on("settings.themeChanged", (_event, theme) => {
    ++revision;
    applyTheme(theme);
  });
  window.addEventListener("focus", refreshTheme);
  refreshTheme();
})();
