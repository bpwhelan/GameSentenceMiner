"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, nativeTheme } = require("electron");

app.commandLine.appendSwitch("disable-gpu");

const outputDirectory = process.argv.at(-1);
const fixturePath = path.resolve(
  process.cwd(),
  "electron-src/main/ui/fixtures/hoshidicts-popup-visual.html",
);
const scenarios = [
  { name: "short" },
  { name: "long" },
  { name: "multiple" },
  { name: "media" },
  { name: "empty" },
  { name: "error" },
  { name: "edge", model: "short", edge: true },
  { name: "light", model: "short", theme: "light" },
  { name: "dark", model: "short", theme: "dark" },
  { name: "high-dpi", model: "multiple", zoomFactor: 1.5 },
];

async function main() {
  if (!outputDirectory || outputDirectory === __filename) {
    throw new Error("Screenshot output directory is required");
  }
  fs.mkdirSync(outputDirectory, { recursive: true });
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: 820,
    height: 680,
    useContentSize: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      offscreen: true,
    },
  });
  await window.loadFile(fixturePath);
  const results = [];
  for (const scenario of scenarios) {
    nativeTheme.themeSource = scenario.theme || "dark";
    window.webContents.setZoomFactor(scenario.zoomFactor || 1);
    const metrics = await window.webContents.executeJavaScript(
      `window.renderScenario(${JSON.stringify(scenario.model || scenario.name)}, ${JSON.stringify(scenario)})`,
      true,
    );
    const image = await window.webContents.capturePage();
    const filePath = path.join(outputDirectory, `${scenario.name}.png`);
    fs.writeFileSync(filePath, image.toPNG());
    results.push({
      ...metrics,
      name: scenario.name,
      filePath,
      bitmapSize: image.getSize(),
      pngBytes: fs.statSync(filePath).size,
    });
  }
  process.stdout.write(`${JSON.stringify(results)}\n`);
  window.destroy();
  app.quit();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
