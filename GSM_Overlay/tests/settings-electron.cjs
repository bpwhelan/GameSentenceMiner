const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const directory = process.env.GSM_SETTINGS_SCREENSHOTS || fs.mkdtempSync(path.join(os.tmpdir(), "gsm-settings-"));
fs.mkdirSync(directory, { recursive: true });
app.setPath("userData", path.join(directory, "profile"));
app.commandLine.appendSwitch("disable-background-networking");
const timeout = setTimeout(() => {
  console.error("Settings render test timed out");
  app.exit(1);
}, 45000);
const errors = [];
const saved = [];
ipcMain.on("settings-test-error", (_event, error) => errors.push(error));
ipcMain.on("setting-changed", (_event, value) => saved.push(value));
ipcMain.handle("get-effective-platform", () => process.platform);
ipcMain.handle("overlay-get-active-goals", () => ({ goals: [] }));
ipcMain.handle("vn-guide-state", () => null);

app
  .whenReady()
  .then(async () => {
    const view = new BrowserWindow({
      show: false,
      width: 1200,
      height: 980,
      useContentSize: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        backgroundThrottling: false,
        offscreen: true,
        preload: path.join(__dirname, "helpers/settings-electron-preload.cjs"),
      },
    });
    const run = (source) => view.webContents.executeJavaScript(source);
    await view.loadFile(path.join(__dirname, "../settings.html"));
    view.webContents.send("preload-settings", {
      userSettings: { gamepadEnabled: true, showFurigana: true, showTextIndicators: true },
      defaultSettings: { showTextIndicators: true },
      websocketStates: { ws1: false, ws2: false },
      runtimeSettings: {},
    });
    await run("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    // Exercise the conditional Home rows and the same settings in full pages.
    view.webContents.send("settings-updated", {
      manualMode: true,
      periodic: true,
      pomodoroEnabled: true,
      vnGuideEnabled: true,
      customPageEnabled: true,
      enableJitenReader: true,
    });
    await run("new Promise(resolve => setTimeout(resolve, 0))");
    const pages = await run("GSMSettingsNavigation.availablePages.map(page => page.id)");
    const sizes = [
      [1200, 980],
      [900, 720],
      [640, 720],
    ];
    for (const [width, height] of sizes) {
      view.setContentSize(width, height);
      await run("new Promise(resolve => setTimeout(resolve, 80))");
      for (const page of pages) {
        await run(`GSMSettingsNavigation.navigate(${JSON.stringify(page)})`);
        if (page === "overview-start") {
          await run(`document.querySelectorAll('#settingsHome details').forEach(details => { details.open = true; })`);
        }
        const layout = await run(`(() => {
        const panel = document.getElementById('settingsPagePanel');
        const controls = [...document.querySelectorAll('#settingsContent input, #settingsContent select, #settingsContent button')].filter(el => el.getClientRects().length);
        return {
          page: GSMSettingsNavigation.activePage.id,
          overflow: panel.scrollWidth > panel.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth,
          controls: controls.length,
          clipped: controls.filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.left < panel.getBoundingClientRect().left - 1 || rect.right > panel.getBoundingClientRect().right + 1;
          }).map(el => el.id || el.textContent),
        };
      })()`);
        assert.equal(layout.page, page);
        assert.equal(layout.overflow, false, `${page} overflows at ${width}px: ${layout.clipped}`);
        assert.deepEqual(layout.clipped, [], `${page} clips controls at ${width}px`);
        assert.ok(layout.controls > 0, `${page} has no visible controls`);
      }
      for (const page of ["overview-start", "reading-readings", "gamepad-bindings", "tools-guide"]) {
        await run(`GSMSettingsNavigation.navigate(${JSON.stringify(page)})`);
        if (page === "overview-start") {
          await run(`document.querySelectorAll('#settingsHome details').forEach(details => { details.open = false; })`);
        }
        await run("new Promise(resolve => setTimeout(resolve, 80))");
        const png = await new Promise((resolve) => {
          view.webContents.once("paint", (_event, _dirty, image) => resolve(image.toPNG()));
          view.webContents.invalidate();
        });
        fs.writeFileSync(path.join(directory, `${page}-${width}.png`), png);
      }
      await run(
        `GSMSettingsNavigation.navigate('overview-start'); GSMSettingsHome.scrollToSection('readings', {behavior: 'instant'})`,
      );
      assert.equal(
        await run(`document.documentElement.scrollTop + document.body.scrollTop`),
        0,
        "Home jump links must keep the app header in place",
      );
      assert.equal(
        await run(
          `document.getElementById('home-heading-readings').getBoundingClientRect().top >= document.querySelector('.home-anchor-nav').getBoundingClientRect().bottom`,
        ),
        true,
        "The section title must clear the sticky jump links",
      );
      await run("new Promise(resolve => setTimeout(resolve, 80))");
      const controlsPng = await new Promise((resolve) => {
        view.webContents.once("paint", (_event, _dirty, image) => resolve(image.toPNG()));
        view.webContents.invalidate();
      });
      fs.writeFileSync(path.join(directory, `home-controls-${width}.png`), controlsPng);
    }
    await run(
      `GSMSettingsNavigation.navigate('overview-start'); document.getElementById('home-showTextIndicators').click()`,
    );
    await run("new Promise(resolve => setTimeout(resolve, 0))");
    assert.equal(await run(`document.getElementById('showTextIndicators').checked`), false);
    assert.deepEqual(saved, [{ key: "showTextIndicators", value: false }]);
    view.webContents.send("settings-updated", { showTextIndicators: true });
    await run("new Promise(resolve => setTimeout(resolve, 0))");
    assert.equal(await run(`document.getElementById('home-showTextIndicators').checked`), true);
    saved.length = 0;
    await run(`(() => {
    const input = document.getElementById('settingsSearchInput');
    input.value = 'Periodic Scan Ratio';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
    assert.equal(await run(`document.getElementById('periodic_ratio').getClientRects().length > 0`), true);
    await run(`document.querySelector('[data-settings-tab="reading"]').click()`);
    assert.equal(await run(`document.body.classList.contains('search-active')`), false);
    await run(
      `GSMSettingsNavigation.navigate('reading-indicators'); document.getElementById('showTextIndicators').click()`,
    );
    await run("new Promise(resolve => setTimeout(resolve, 0))");
    assert.deepEqual(saved, [{ key: "showTextIndicators", value: false }]);
    view.webContents.send("settings-updated", { showTextIndicators: true });
    await run("new Promise(resolve => setTimeout(resolve, 0))");
    assert.equal(await run(`document.getElementById('showTextIndicators').checked`), true);
    await run(
      `document.querySelector('[data-settings-page="reading-readings"]').click(); document.getElementById('readingLanguage').value = 'chinese'; document.getElementById('readingLanguage').dispatchEvent(new Event('change', { bubbles: true }))`,
    );
    await run(`GSMSettingsNavigation.navigate('reading-appearance')`);
    assert.equal(await run(`document.getElementById('pinyinToneColorsGroup').getClientRects().length > 0`), true);
    assert.deepEqual(errors, []);
    console.log(
      `Settings: ${pages.length} pages checked at ${sizes.length} sizes; save and profile updates passed. Screenshots: ${directory}`,
    );
    clearTimeout(timeout);
    view.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
