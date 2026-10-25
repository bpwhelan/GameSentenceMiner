const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const directory = process.env.GSM_SETTINGS_SCREENSHOTS || fs.mkdtempSync(path.join(os.tmpdir(), "gsm-settings-"));
process.env.GSM_OVERLAY_IN_PROCESS = "1";
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
ipcMain.handle("settings.getTheme", () => "gsm-dark");
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
    // Scrolling a continuous category must keep both navigation bars in sync.
    view.setContentSize(1200, 520);
    await run("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await run(`GSMSettingsNavigation.navigate('capture-source')`);
    for (const page of ["capture-results", "capture-scanning", "capture-source"]) {
      await run(`(() => {
        const panel = document.getElementById('settingsPagePanel');
        const section = document.querySelector('[data-page="${page}"]');
        panel.scrollTop += section.getBoundingClientRect().top - panel.getBoundingClientRect().top - 8;
      })()`);
      await run("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      assert.equal(await run("GSMSettingsNavigation.activePage.id"), page, "Scrolling must select the current section");
      assert.equal(await run(`document.querySelector('[data-settings-page="${page}"]').getAttribute('aria-selected')`), "true");
      assert.equal(await run(`document.querySelector('[data-settings-tree-page="${page}"]').classList.contains('active')`), true);
    }
    await run(`document.getElementById('settingsPagePanel').scrollTop = document.getElementById('settingsPagePanel').scrollHeight`);
    await run("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert.equal(await run("GSMSettingsNavigation.activePage.id"), "capture-advanced", "The final short section is selected at the bottom");
    const pages = await run("GSMSettingsNavigation.availablePages.map(page => page.id)");
    assert.ok(pages.includes("system-tokenizer"));
    assert.ok(!pages.includes("reading-tokenizer") && !pages.includes("reading-appearance"));
    assert.equal(await run(`document.getElementById('furiganaScale').closest('[data-page]').dataset.page`), "reading-readings");
    // The actual Electron renderer must recolor controls and native widgets live.
    // Compare semantic colors rather than Chromium's serialized color syntax.
    view.setContentSize(1200, 980);
    for (const theme of ["gsm-dark", "solarized-light", "catppuccin-mocha", "high-contrast", "light", "nord"]) {
      view.webContents.send("settings.themeChanged", theme);
      await run("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      assert.equal(await run("document.documentElement.dataset.theme"), theme);
      await run(`GSMSettingsNavigation.navigate('overview-start')`);
      const colors = await run(`(() => {
        const probe = document.createElement('span');
        document.body.append(probe);
        const color = (token) => {
          probe.style.backgroundColor = 'var(' + token + ')';
          return getComputedStyle(probe).backgroundColor;
        };
        const result = {
          body: getComputedStyle(document.body).backgroundColor === color('--color-base-100'),
          card: getComputedStyle(document.querySelector('.home-card')).backgroundColor === color('--color-base-200'),
          text: getComputedStyle(document.querySelector('.home-card h4')).color === color('--color-base-content'),
          toggle: getComputedStyle(document.getElementById('home-manualMode')).backgroundColor === color('--color-primary'),
          thumb: getComputedStyle(document.getElementById('home-manualMode'), '::after').backgroundColor === color('--color-primary-content'),
          scheme: getComputedStyle(document.documentElement).colorScheme,
        };
        probe.remove();
        return result;
      })()`);
      for (const key of ["body", "card", "text", "toggle", "thumb"]) {
        assert.equal(colors[key], true, `${theme}: ${key} must use the desktop palette`);
      }
      assert.equal(colors.scheme, ["solarized-light", "light", "nord"].includes(theme) ? "light" : "dark");
      fs.writeFileSync(path.join(directory, `theme-${theme}.png`), (await view.webContents.capturePage()).toPNG());
    }
    view.webContents.send("settings.themeChanged", "gsm-dark");
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
      for (const page of ["overview-start", "reading-readings", "capture-source", "gamepad-bindings", "tools-guide", "tools-translation", "system-tokenizer"]) {
        await run(`GSMSettingsNavigation.navigate(${JSON.stringify(page)})`);
        if (page === "overview-start") {
          await run(`document.querySelectorAll('#settingsHome details').forEach(details => { details.open = false; })`);
        }
        await run("new Promise(resolve => setTimeout(resolve, 80))");
        fs.writeFileSync(path.join(directory, `${page}-${width}.png`), (await view.webContents.capturePage()).toPNG());
      }
      await run(`GSMSettingsNavigation.navigate('overview-start')`);
      assert.equal(await run(`document.querySelector('.home-anchor-nav') === null`), true);
      if (width > 1050) {
        const cards = await run(`Array.from(document.querySelectorAll('.home-card'), card => ({ height: card.offsetHeight, bottom: card.querySelector('.home-card-actions').offsetTop - card.offsetTop }))`);
        assert.ok(cards.every(card => card.height === cards[0].height), "Home cards must share a height");
        assert.ok(cards.every(card => Math.abs(card.bottom - cards[0].bottom) <= 1), `Home card actions must line up: ${JSON.stringify(cards)}`);
      }
      await run(`(() => {
        const panel = document.getElementById('settingsPagePanel');
        const card = document.getElementById('home-section-readings');
        panel.scrollTop += card.getBoundingClientRect().top - panel.getBoundingClientRect().top - 12;
      })()`);
      assert.equal(
        await run(`document.documentElement.scrollTop + document.body.scrollTop`),
        0,
        "Scrolling the Home cards must keep the app header in place",
      );
      await run("new Promise(resolve => setTimeout(resolve, 80))");
      fs.writeFileSync(path.join(directory, `home-controls-${width}.png`), (await view.webContents.capturePage()).toPNG());
    }
    await run(`GSMSettingsNavigation.navigate('overview-start')`);
    const help = `document.querySelector('#home-manualMode').closest('label').querySelector('.setting-help')`;
    await run(`(() => {
      const panel = document.getElementById('settingsPagePanel');
      const card = document.getElementById('home-section-activation');
      panel.scrollTop += card.getBoundingClientRect().top - panel.getBoundingClientRect().top - 12;
    })()`);
    await run("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    // Offscreen windows do not receive OS focus, so dispatch its focus event.
    await run(`${help}.focus({ preventScroll: true }); ${help}.dispatchEvent(new FocusEvent('focus'))`);
    assert.equal(await run(`document.querySelector('.setting-tooltip:popover-open') !== null`), true, "Keyboard focus opens contextual help");
    assert.equal(await run(`(() => {
      const rect = document.querySelector('.setting-tooltip:popover-open').getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    })()`), true, "Help must fit in the window");
    await run("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert.equal(await run(`document.querySelector('.setting-tooltip:popover-open') !== null`), true);
    fs.writeFileSync(path.join(directory, "home-help-640.png"), (await view.webContents.capturePage()).toPNG());
    await run(`${help}.click()`);
    assert.equal(await run(`document.getElementById('home-manualMode').checked`), true, "Help must not toggle the setting");
    await run(`${help}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(await run(`document.querySelector('.setting-tooltip:popover-open') === null`), true, "Escape closes help");
    assert.deepEqual(saved, [], "Navigation and contextual help must not save settings");
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
    // Help stays searchable even while it is tucked away in a tooltip.
    await run(`(() => {
      const input = document.getElementById('settingsSearchInput');
      input.value = 'tightly cropped';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('settingsPagePanel').scrollTop = 10000;
    })()`);
    await run("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert.equal(await run(`document.getElementById('last_sent_ocr_presence_check').getClientRects().length > 0`), true);
    assert.equal(await run("GSMSettingsNavigation.activePage.id"), "overview-start", "Scrolling search results must not change categories");
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
    await run(`GSMSettingsNavigation.navigate('reading-readings')`);
    assert.equal(await run(`document.getElementById('pinyinToneColorsGroup').getClientRects().length > 0`), true);
    assert.deepEqual(errors, []);
    console.log(
      `Settings: 6 live themes and ${pages.length} pages checked at ${sizes.length} sizes; scrolling, search, help, save and profile updates passed. Screenshots: ${directory}`,
    );
    clearTimeout(timeout);
    view.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
