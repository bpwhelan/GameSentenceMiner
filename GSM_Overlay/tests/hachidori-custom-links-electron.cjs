// SPDX-License-Identifier: LGPL-3.0-only
// Electron child for run-hachidori-custom-links-electron.cjs. The runner starts
// this file twice with one profile to prove reload and full-process persistence.
const {
  app,
  BrowserWindow,
  clipboard,
  nativeImage,
  shell,
} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const evidenceDirectory = process.env.GSM_HACHIDORI_EVIDENCE_DIR;
const runDirectory = process.env.GSM_HACHIDORI_RUN_DIRECTORY;
const fixturePath = process.env.GSM_HACHIDORI_FIXTURE;
const phase = process.env.GSM_HACHIDORI_PHASE;
for (const [name, value] of Object.entries({
  GSM_HACHIDORI_EVIDENCE_DIR: evidenceDirectory,
  GSM_HACHIDORI_RUN_DIRECTORY: runDirectory,
  GSM_HACHIDORI_FIXTURE: fixturePath,
  GSM_HACHIDORI_PHASE: phase,
})) {
  if (!value) throw new Error(`${name} is required.`);
}
if (!['edit', 'restart'].includes(phase)) {
  throw new Error(`Unknown GSM_HACHIDORI_PHASE: ${phase}`);
}
if (!fs.existsSync(fixturePath)) {
  throw new Error(`Hachidori fixture does not exist: ${fixturePath}`);
}

const overlayDataPath = path.join(runDirectory, 'overlay-data');
const gsmDataPath = path.join(runDirectory, 'gsm-data');
fs.mkdirSync(evidenceDirectory, { recursive: true });
fs.mkdirSync(overlayDataPath, { recursive: true });
fs.mkdirSync(gsmDataPath, { recursive: true });

const configPath = path.join(gsmDataPath, 'config.json');
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, JSON.stringify({
    experimental: {
      enable_experimental_features: true,
      enable_hachidori: true,
    },
    current_profile: 'Default',
    configs: {
      Default: {
        general: { single_port: 7275 },
        advanced: {},
        overlay: {},
      },
    },
  }, null, 2));
}
const settingsPath = path.join(overlayDataPath, 'settings.json');
if (!fs.existsSync(settingsPath)) {
  fs.writeFileSync(settingsPath, JSON.stringify({
    pushToShowEnforcedDialogDismissed: true,
    mainBoxStartupWarningAcknowledged: true,
    openSettingsOnStartup: false,
    hideOnStartup: false,
    enableJitenReader: false,
    gamepadEnabled: false,
    gamepadControllerEnabled: false,
    gamepadKeyboardEnabled: false,
    routeAllHotkeysThroughInputServer: false,
  }, null, 2));
}

process.env.GSM_OVERLAY_IN_PROCESS = '1';
process.env.GSM_OVERLAY_DATA_PATH = overlayDataPath;
process.env.GSM_DATA_DIR = gsmDataPath;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch(
  'host-resolver-rules',
  'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
);

const LINK_LABEL = 'gsm 辞書 link';
const LINK_TEMPLATE = 'https://example.test/find?word=%w&reading=%r&sentence=%s';
const EXPECTED_WORD = '食べる';
const EXPECTED_READING = 'たべる';
const EXPECTED_SENTENCE = '昨日、食べる & 飲む？';
const EXPECTED_URL = `${'https://example.test/find?word='}${encodeURIComponent(EXPECTED_WORD)}`
  + `&reading=${encodeURIComponent(EXPECTED_READING)}`
  + `&sentence=${encodeURIComponent(EXPECTED_SENTENCE)}`;
const CONFIGURED_LOOPBACK_ENDPOINTS = [
  'ws://127.0.0.1:7275/ws/plaintext',
  'ws://127.0.0.1:7275/ws/overlay',
  'http://127.0.0.1:7275/texthooker',
];

const openExternalAttempts = [];
shell.openExternal = async (url) => {
  const attempt = {
    sequence: openExternalAttempts.length + 1,
    url,
    outcome: 'pending',
  };
  openExternalAttempts.push(attempt);
  if (new URL(url).pathname === '/opener-failure') {
    attempt.outcome = 'rejected';
    attempt.error = 'injected OS browser failure';
    throw new Error(attempt.error);
  }
  attempt.outcome = 'resolved';
  return '';
};

const timeout = setTimeout(() => {
  console.error(`GSM Hachidori custom-link ${phase} phase timed out.`);
  app.exit(1);
}, 180_000);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, callback, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  const suffix = lastError ? ` Last error: ${lastError.stack || lastError}` : '';
  throw new Error(`Timed out waiting for ${description}.${suffix}`);
}

function windowBy(predicate) {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && predicate(window),
  );
}

async function clickAt(webContents, point) {
  webContents.sendInputEvent({
    type: 'mouseMove',
    x: Math.round(point.x),
    y: Math.round(point.y),
  });
  await delay(40);
  webContents.sendInputEvent({
    type: 'mouseDown',
    x: Math.round(point.x),
    y: Math.round(point.y),
    button: 'left',
    clickCount: 1,
  });
  webContents.sendInputEvent({
    type: 'mouseUp',
    x: Math.round(point.x),
    y: Math.round(point.y),
    button: 'left',
    clickCount: 1,
  });
  await delay(80);
}

async function sendKey(webContents, keyCode, modifiers = []) {
  webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(40);
}

async function typePhysicalText(webContents, text) {
  for (const character of text) {
    const keyCode = character === ' ' ? 'Space' : character.toUpperCase();
    webContents.sendInputEvent({ type: 'keyDown', keyCode });
    webContents.sendInputEvent({ type: 'char', keyCode: character });
    webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await delay(20);
  }
}

async function withDebugger(webContents, callback) {
  const attachedHere = !webContents.debugger.isAttached();
  if (attachedHere) webContents.debugger.attach('1.3');
  try {
    return await callback(webContents.debugger);
  } finally {
    if (attachedHere && webContents.debugger.isAttached()) {
      webContents.debugger.detach();
    }
  }
}

async function showSettingsSection(settingsWindow, section) {
  await settingsWindow.webContents.executeJavaScript(
    `location.hash = ${JSON.stringify(`#${section}`)};`,
  );
  await waitFor(`the ${section} Settings section`, async () => (
    await settingsWindow.webContents.executeJavaScript(
      `document.getElementById(${JSON.stringify(section)})?.hidden === false`,
    )
  ));
}

async function importFixture(settingsWindow) {
  await showSettingsSection(settingsWindow, 'add-dictionaries');
  const alreadyImported = await settingsWindow.webContents.executeJavaScript(
    `document.getElementById("engine-status")?.textContent?.includes("1 dictionary enabled") === true`,
  );
  if (alreadyImported) return 'already imported';
  await withDebugger(settingsWindow.webContents, async (debuggerApi) => {
    await debuggerApi.sendCommand('DOM.enable');
    const { root } = await debuggerApi.sendCommand('DOM.getDocument');
    const { nodeId } = await debuggerApi.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#import-file',
    });
    assert.ok(nodeId > 0, 'real Settings exposes the dictionary file input');
    await debuggerApi.sendCommand('DOM.setFileInputFiles', {
      nodeId,
      files: [fixturePath],
    });
  });
  await settingsWindow.webContents.executeJavaScript(
    `document.getElementById("import-file").dispatchEvent(new Event("change", { bubbles: true }));`,
  );
  await waitFor('the real dictionary import to finish', async () => (
    await settingsWindow.webContents.executeJavaScript(
      `document.getElementById("import-state")?.textContent?.trim()
        === "Finished 1 of 1 archive — 1 imported, 0 failed."`,
    )
  ), 120_000);
  await waitFor('the imported dictionary to become enabled', async () => (
    await settingsWindow.webContents.executeJavaScript(
      `document.getElementById("engine-status")?.textContent?.includes("1 dictionary enabled") === true`,
    )
  ), 90_000);
  return 'imported';
}

async function setImeComposition(webContents, text) {
  await withDebugger(webContents, async (debuggerApi) => {
    await debuggerApi.sendCommand('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
    await delay(80);
    await debuggerApi.sendCommand('Input.insertText', { text });
  });
  await delay(100);
}

async function waitForSettingsStartup(settingsWindow) {
  await waitFor('Hachidori Settings startup', async () => (
    settingsWindow.webContents.getURL().startsWith('chrome-extension://')
    && await settingsWindow.webContents.executeJavaScript(
      `document.readyState === "complete"
        && document.getElementById("custom-links-settings") !== null
        && document.getElementById("engine-status") !== null`,
    )
  ));
  await waitFor('the Hachidori engine status', async () => (
    await settingsWindow.webContents.executeJavaScript(`(() => {
      const text = document.getElementById("engine-status")?.textContent?.toLowerCase() || "";
      return text.includes("ready") || text.includes("no dictionaries")
        || text.includes("dictionary enabled") || text.includes("error");
    })()`)
  ), 90_000);
}

async function openSettings(mainWindow) {
  await mainWindow.webContents.executeJavaScript(
    `require("electron").ipcRenderer.send("open-yomitan-settings");`,
  );
  const settingsWindow = await waitFor('the real Hachidori Settings window', () => (
    windowBy((window) => {
      const url = window.webContents.getURL();
      return url.startsWith('chrome-extension://') && url.endsWith('/settings.html');
    })
  ));
  await waitForSettingsStartup(settingsWindow);
  return settingsWindow;
}

async function installInputRecorder(settingsWindow) {
  await settingsWindow.webContents.executeJavaScript(`(() => {
    globalThis.__i17InputEvents = [];
    const describe = event => ({
      type: event.type,
      target: event.target?.id || "",
      key: event.key || "",
      code: event.code || "",
      inputType: event.inputType || "",
      data: event.data ?? null,
      isComposing: event.isComposing === true,
      pasted: event.clipboardData?.getData("text/plain") || "",
      value: event.target?.value ?? "",
    });
    for (const id of ["opt-custom-link-name", "opt-custom-link-url", "custom-link-submit"]) {
      const node = document.getElementById(id);
      for (const type of [
        "focus", "blur", "keydown", "keyup", "beforeinput", "input",
        "compositionstart", "compositionupdate", "compositionend", "paste",
      ]) {
        node.addEventListener(type, event => globalThis.__i17InputEvents.push(describe(event)));
      }
    }
    document.getElementById("custom-link-form").addEventListener("submit", event => {
      globalThis.__i17InputEvents.push({
        ...describe(event),
        type: "submit",
        target: "custom-link-form",
      });
    });
  })()`);
}

async function readCustomLinkState(settingsWindow) {
  return settingsWindow.webContents.executeJavaScript(`(async () => {
    const stored = await chrome.storage.local.get("options");
    const fieldset = document.getElementById("custom-links-settings");
    const help = document.getElementById("custom-links-overlay-help");
    return {
      fieldsetDisabled: fieldset.disabled,
      nameDisabled: document.getElementById("opt-custom-link-name").matches(":disabled"),
      urlDisabled: document.getElementById("opt-custom-link-url").matches(":disabled"),
      helpHidden: help.hidden,
      helpText: help.textContent.trim(),
      activeElementId: document.activeElement?.id || "",
      renderedLinks: [...document.querySelectorAll("#custom-link-list .custom-link-row")].map(row => ({
        label: row.querySelector("strong")?.textContent || "",
        url: row.querySelector("code")?.textContent || "",
      })),
      storedLinks: stored.options?.customLinks || [],
      optionsStatus: document.getElementById("options-status")?.textContent || "",
    };
  })()`);
}

async function captureCustomLinksSection(settingsWindow, filename) {
  await settingsWindow.webContents.executeJavaScript(`(() => {
    document.getElementById("custom-links-settings").scrollIntoView({
      block: "center",
      inline: "nearest",
    });
  })()`);
  await delay(150);
  const rect = await settingsWindow.webContents.executeJavaScript(`(() => {
    const bounds = document.getElementById("custom-links-settings").getBoundingClientRect();
    const left = Math.max(0, Math.floor(bounds.left + scrollX - 8));
    const top = Math.max(0, Math.floor(bounds.top + scrollY - 8));
    const right = Math.min(
      document.documentElement.scrollWidth,
      Math.ceil(bounds.right + scrollX + 8),
    );
    const bottom = Math.min(
      document.documentElement.scrollHeight,
      Math.ceil(bounds.bottom + scrollY + 8),
    );
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      scrollX,
      scrollY,
    };
  })()`);
  assert.ok(rect.width > 100 && rect.height > 100, `custom-link screenshot clip is usable: ${JSON.stringify(rect)}`);
  const png = await withDebugger(settingsWindow.webContents, async (debuggerApi) => {
    await debuggerApi.sendCommand('Page.enable');
    const { data } = await debuggerApi.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        scale: 1,
      },
    });
    return Buffer.from(data, 'base64');
  });
  const screenshotPath = path.join(evidenceDirectory, filename);
  fs.writeFileSync(screenshotPath, png);
  return {
    path: screenshotPath,
    clip: rect,
    size: nativeImage.createFromBuffer(png).getSize(),
  };
}

async function invokeExternalBridge(mainWindow, payload) {
  return mainWindow.webContents.executeJavaScript(`(async () => {
    try {
      return {
        ok: true,
        value: await require("electron").ipcRenderer.invoke(
          "hachidori-open-external",
          ${JSON.stringify(payload)}
        ),
      };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  })()`);
}

async function exerciseBridgeFailures(mainWindow) {
  const rejected = [];
  for (const [name, payload] of [
    ['javascript scheme', { url: 'javascript:alert(1)', active: true }],
    ['data scheme', { url: 'data:text/html,unsafe', active: true }],
    ['file scheme', { url: 'file:///tmp/unsafe', active: true }],
    ['malformed scheme', { url: 'https:example.test/path', active: true }],
    ['malformed authority', { url: 'https://[::1', active: true }],
    ['credentials', { url: 'https://user:pass@example.test/', active: true }],
    ['leading control', { url: '\nhttps://example.test/', active: true }],
    ['trailing control', { url: 'https://example.test/\r', active: true }],
    ['embedded control', { url: 'https://exam\tple.test/', active: true }],
    ['invalid activation', { url: 'https://example.test/', active: 'yes' }],
  ]) {
    const result = await invokeExternalBridge(mainWindow, payload);
    assert.equal(result.ok, false, `${name} request is rejected`);
    assert.equal(openExternalAttempts.length, 0, `${name} reaches no OS opener`);
    rejected.push({ name, payload, result });
  }

  const beforeFailure = openExternalAttempts.length;
  const failure = await invokeExternalBridge(mainWindow, {
    url: 'https://example.test/opener-failure',
    active: true,
  });
  assert.equal(failure.ok, false);
  assert.match(failure.error, /injected OS browser failure/u);
  assert.equal(openExternalAttempts.length, beforeFailure + 1);
  await delay(300);
  assert.equal(openExternalAttempts.length, beforeFailure + 1, 'an OS opener failure is never retried');
  return {
    rejected,
    openerFailure: {
      result: failure,
      attemptsAdded: openExternalAttempts.length - beforeFailure,
      noRetryAfterMilliseconds: 300,
    },
  };
}

function ocrPayload() {
  const y1 = 0.22;
  const y3 = 0.31;
  const words = [
    { text: '昨日、', bounding_rect: { x1: 0.12, y1, x3: 0.27, y3 } },
    { text: '食べる', bounding_rect: { x1: 0.27, y1, x3: 0.42, y3 } },
    { text: ' & ', bounding_rect: { x1: 0.42, y1, x3: 0.49, y3 } },
    { text: '飲む？', bounding_rect: { x1: 0.49, y1, x3: 0.64, y3 } },
  ];
  return {
    type: 'word_coordinates',
    line_id: 'i17-custom-link-substitution',
    latest_text: EXPECTED_SENTENCE,
    data: [{
      text: EXPECTED_SENTENCE,
      bounding_rect: { x1: 0.12, y1, x3: 0.64, y3 },
      words,
    }],
  };
}

async function popupState(mainWindow) {
  return mainWindow.webContents.executeJavaScript(`(() => {
    const root = document.querySelector("hachidori-host")?.shadowRoot;
    const popup = root?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    const link = popup?.querySelector(".gsm-hoshidicts-external-link-button");
    const bounds = link?.getBoundingClientRect();
    const plain = popup?.cloneNode(true);
    for (const annotation of plain?.querySelectorAll("rt, rp") || []) {
      annotation.remove();
    }
    return {
      hostPresent: Boolean(root),
      hidden: popup?.hidden ?? true,
      popupText: (plain?.textContent || "").replace(/\\s+/g, " ").trim(),
      linkCount: popup?.querySelectorAll(".gsm-hoshidicts-external-link-button").length || 0,
      linkLabel: link?.getAttribute("aria-label") || "",
      linkRect: bounds ? {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      } : null,
    };
  })()`);
}

async function readPopupDiagnostics(mainWindow, settingsWindow) {
  const page = await mainWindow.webContents.executeJavaScript(`(() => {
    const describeNode = node => {
      if (!node) return null;
      return {
        nodeName: node.nodeName,
        id: node.id || "",
        className: typeof node.className === "string" ? node.className : "",
        text: (node.textContent || "").slice(0, 80),
      };
    };
    const glyph = [...document.querySelectorAll(".text-box[data-selectable='true']")]
      .find(element => element.textContent === "食");
    const glyphBounds = glyph?.getBoundingClientRect();
    const point = glyphBounds ? {
      x: glyphBounds.x + glyphBounds.width / 2,
      y: glyphBounds.y + glyphBounds.height / 2,
    } : null;
    let caret = null;
    if (point) {
      try {
        const range = document.caretRangeFromPoint?.(point.x, point.y);
        caret = range ? {
          containerText: (range.startContainer?.nodeValue || range.startContainer?.textContent || "").slice(0, 80),
          containerNodeName: range.startContainer?.nodeName || "",
          offset: range.startOffset,
        } : null;
      } catch (error) {
        caret = { error: error?.message || String(error) };
      }
    }
    const host = document.querySelector("hachidori-host");
    const root = host?.shadowRoot;
    const hostBounds = host?.getBoundingClientRect();
    const hostStyle = host ? getComputedStyle(host) : null;
    const popup = root?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    return {
      url: location.href,
      readyState: document.readyState,
      dictionaryReader: typeof dictionaryReader === "undefined" ? null : dictionaryReader,
      manualMode: typeof manualMode === "undefined" ? null : manualMode,
      manualHotkeyPressed: typeof manualHotkeyPressed === "undefined" ? null : manualHotkeyPressed,
      bodyClassName: document.body.className,
      activeElement: describeNode(document.activeElement),
      textBoxCount: document.querySelectorAll(".text-box[data-selectable='true']").length,
      glyph: glyphBounds ? {
        text: glyph.textContent,
        rect: {
          x: glyphBounds.x,
          y: glyphBounds.y,
          width: glyphBounds.width,
          height: glyphBounds.height,
        },
        point,
        display: getComputedStyle(glyph).display,
        visibility: getComputedStyle(glyph).visibility,
        pointerEvents: getComputedStyle(glyph).pointerEvents,
      } : null,
      hitTest: point ? describeNode(document.elementFromPoint(point.x, point.y)) : null,
      caret,
      glyphEvents: globalThis.__i17GlyphEvents || [],
      host: {
        present: Boolean(host),
        connected: host?.isConnected === true,
        shadowRootPresent: Boolean(root),
        childElementCount: root?.childElementCount ?? null,
        rect: hostBounds ? {
          x: hostBounds.x,
          y: hostBounds.y,
          width: hostBounds.width,
          height: hostBounds.height,
        } : null,
        display: hostStyle?.display || null,
        visibility: hostStyle?.visibility || null,
        pointerEvents: hostStyle?.pointerEvents || null,
        dataset: host ? { ...host.dataset } : null,
        popupHidden: popup?.hidden ?? null,
        popupInert: popup?.inert ?? null,
        popupText: (popup?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500),
      },
    };
  })()`);
  const extension = await settingsWindow.webContents.executeJavaScript(`(async () => {
    const stored = await chrome.storage.local.get(["options", "dictionaryState"]);
    let engine;
    try {
      engine = await chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen",
        type: "hd_status",
        requestId: "i17-popup-diagnostics-" + Date.now(),
      });
    } catch (error) {
      engine = { error: error?.message || String(error) };
    }
    const options = HDReaderOptions.normaliseOptions(stored.options);
    const state = stored.dictionaryState;
    return {
      options: {
        revision: options.revision,
        hoverEnabled: options.hoverEnabled,
        onlyScanJapaneseText: options.onlyScanJapaneseText,
        lookupMode: options.lookupMode,
        activationKey: options.activationKey,
        hoverDelayMs: options.hoverDelayMs,
        popupHideDelayMs: options.popupHideDelayMs,
        scanLength: options.scanLength,
        maxResults: options.maxResults,
        customLinks: options.customLinks,
      },
      dictionaryState: {
        revision: state?.revision ?? null,
        dictionaries: (state?.dictionaries || []).map(dictionary => ({
          id: dictionary.id,
          title: dictionary.title,
          enabled: dictionary.enabled,
          generation: dictionary.generation,
        })),
        groups: (state?.groups || []).map(group => ({
          id: group.id,
          name: group.name,
          enabled: group.enabled,
        })),
      },
      engine,
      engineStatusText: document.getElementById("engine-status")?.textContent?.trim() || "",
      engineStatusClassName: document.getElementById("engine-status")?.className || "",
      importStateText: document.getElementById("import-state")?.textContent?.trim() || "",
    };
  })()`);
  return {
    capturedAt: new Date().toISOString(),
    mainWindow: {
      bounds: mainWindow.getBounds(),
      contentBounds: mainWindow.getContentBounds(),
      visible: mainWindow.isVisible(),
      focused: mainWindow.isFocused(),
      minimized: mainWindow.isMinimized(),
      destroyed: mainWindow.isDestroyed(),
      webContentsDestroyed: mainWindow.webContents.isDestroyed(),
      webContentsFocused: typeof mainWindow.webContents.isFocused === 'function'
        ? mainWindow.webContents.isFocused()
        : null,
    },
    page,
    extension,
    popup: await popupState(mainWindow),
  };
}

async function exerciseRealPopupClick(mainWindow, settingsWindow) {
  mainWindow.setIgnoreMouseEvents(false);
  mainWindow.show();
  mainWindow.moveTop();
  mainWindow.focus();
  mainWindow.webContents.focus();
  mainWindow.webContents.send('show-overlay-hotkey', true, {
    deferRevealForBackground: false,
  });
  await waitFor('the active GSM manual overlay', async () => (
    await mainWindow.webContents.executeJavaScript(
      `manualHotkeyPressed === true
        && !document.body.classList.contains("manual-interaction-suppressed")`,
    )
  ));
  await waitFor('the Hachidori content host', async () => (
    await mainWindow.webContents.executeJavaScript(
      `document.querySelector("hachidori-host")?.shadowRoot !== null`,
    )
  ));
  mainWindow.webContents.send('overlay-websocket-data', {
    data: JSON.stringify(ocrPayload()),
  });
  await waitFor('the visible GSM OCR glyph boxes', async () => (
    await mainWindow.webContents.executeJavaScript(`(() => {
      const glyphs = [...document.querySelectorAll(".text-box[data-selectable='true']")];
      const sample = glyphs.find(element => element.textContent === "食");
      if (!sample) return false;
      const bounds = sample.getBoundingClientRect();
      const style = getComputedStyle(sample);
      return glyphs.length >= 10
        && bounds.width > 0
        && bounds.height > 0
        && style.display !== "none"
        && style.pointerEvents !== "none";
    })()`)
  ));
  const glyph = await mainWindow.webContents.executeJavaScript(`(() => {
    const node = [...document.querySelectorAll(".text-box[data-selectable='true']")]
      .find(element => element.textContent === "食");
    if (!node) return null;
    const bounds = node.getBoundingClientRect();
    globalThis.__i17GlyphEvents = [];
    for (const type of [
      "pointerover", "pointerenter", "pointermove",
      "mouseover", "mouseenter", "mousemove",
    ]) {
      node.addEventListener(type, event => globalThis.__i17GlyphEvents.push({
        type,
        isTrusted: event.isTrusted,
        shiftKey: event.shiftKey,
        clientX: event.clientX,
        clientY: event.clientY,
      }));
    }
    return {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
      rect: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
    };
  })()`);
  assert.ok(glyph, 'the real GSM OCR output contains the 食 glyph');
  const beforeHover = await readPopupDiagnostics(mainWindow, settingsWindow);
  mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 });
  await delay(80);
  const requiresActivation = beforeHover.extension.options.lookupMode !== 'hover';
  if (requiresActivation) {
    assert.equal(beforeHover.extension.options.activationKey, 'Shift');
    mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' });
  }
  let popup;
  try {
    mainWindow.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(glyph.x),
      y: Math.round(glyph.y),
      modifiers: requiresActivation ? ['shift'] : [],
    });
    popup = await waitFor('the real Hachidori popup and custom link', async () => {
      const state = await popupState(mainWindow);
      return !state.hidden && state.linkCount === 1 && state.linkLabel === LINK_LABEL ? state : null;
    }, 30_000);
  } catch (error) {
    const diagnostics = await readPopupDiagnostics(mainWindow, settingsWindow);
    console.error(`I17 popup diagnostics ${JSON.stringify({ beforeHover, final: diagnostics }, null, 2)}`);
    throw new Error(
      `${error.message} Popup diagnostics: ${JSON.stringify({ beforeHover, final: diagnostics })}`,
    );
  } finally {
    if (requiresActivation) {
      mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' });
    }
  }
  assert.match(popup.popupText, /食べる/u);
  const afterHover = await readPopupDiagnostics(mainWindow, settingsWindow);
  await mainWindow.webContents.executeJavaScript(`(() => {
    const button = document.querySelector("hachidori-host").shadowRoot
      .querySelector(".gsm-hoshidicts-external-link-button");
    globalThis.__i17PopupClickEvents = [];
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      button.addEventListener(type, event => globalThis.__i17PopupClickEvents.push({
        type,
        label: event.target.getAttribute("aria-label") || "",
        isTrusted: event.isTrusted,
      }), { once: true });
    }
  })()`);
  const popupScreenshotPath = path.join(evidenceDirectory, 'real-gsm-electron-popup-custom-link.png');
  fs.writeFileSync(popupScreenshotPath, (await mainWindow.webContents.capturePage()).toPNG());

  const attemptsBeforeClick = openExternalAttempts.length;
  await clickAt(mainWindow.webContents, {
    x: popup.linkRect.x + popup.linkRect.width / 2,
    y: popup.linkRect.y + popup.linkRect.height / 2,
  });
  await waitFor('one successful shell.openExternal call', () => (
    openExternalAttempts.filter((attempt) => attempt.outcome === 'resolved').length === 1
  ));
  assert.equal(openExternalAttempts.length, attemptsBeforeClick + 1);
  const successful = openExternalAttempts.find((attempt) => attempt.outcome === 'resolved');
  assert.equal(successful.url, EXPECTED_URL);
  const opened = new URL(successful.url);
  assert.equal(opened.searchParams.get('word'), EXPECTED_WORD);
  assert.equal(opened.searchParams.get('reading'), EXPECTED_READING);
  assert.equal(opened.searchParams.get('sentence'), EXPECTED_SENTENCE);
  const clickEvents = await mainWindow.webContents.executeJavaScript(
    `globalThis.__i17PopupClickEvents || []`,
  );
  assert.deepEqual(clickEvents.map((event) => event.type), [
    'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click',
  ]);
  assert.ok(clickEvents.every((event) => event.isTrusted === true));
  mainWindow.webContents.send('show-overlay-hotkey', false);
  return {
    glyph,
    requiresActivation,
    beforeHover,
    afterHover,
    popup,
    clickEvents,
    successfulAttempt: successful,
    decoded: {
      word: opened.searchParams.get('word'),
      reading: opened.searchParams.get('reading'),
      sentence: opened.searchParams.get('sentence'),
    },
    expectedEncodedUrl: EXPECTED_URL,
    popupScreenshotPath,
  };
}

async function runEditPhase(mainWindow) {
  const settingsWindow = await openSettings(mainWindow);
  const importResult = await importFixture(settingsWindow);
  await showSettingsSection(settingsWindow, 'design');
  await settingsWindow.webContents.executeJavaScript(
    `document.getElementById("custom-links-settings").scrollIntoView({ block: "center" });`,
  );
  await installInputRecorder(settingsWindow);

  const initial = await readCustomLinkState(settingsWindow);
  assert.equal(initial.fieldsetDisabled, false);
  assert.equal(initial.nameDisabled, false);
  assert.equal(initial.urlDisabled, false);
  assert.equal(initial.helpHidden, false);
  assert.match(initial.helpText, /system browser/u);
  assert.match(initial.helpText, /live preview cannot launch/u);
  assert.deepEqual(initial.storedLinks, []);

  const namePoint = await settingsWindow.webContents.executeJavaScript(`(() => {
    const bounds = document.getElementById("opt-custom-link-name").getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  })()`);
  await clickAt(settingsWindow.webContents, namePoint);
  assert.equal(await settingsWindow.webContents.executeJavaScript(
    `document.activeElement?.id`,
  ), 'opt-custom-link-name');
  await typePhysicalText(settingsWindow.webContents, 'gsm ');
  await setImeComposition(settingsWindow.webContents, '辞書');
  await typePhysicalText(settingsWindow.webContents, ' link');
  const composedName = await settingsWindow.webContents.executeJavaScript(
    `document.getElementById("opt-custom-link-name").value`,
  );
  assert.equal(composedName, LINK_LABEL);

  await sendKey(settingsWindow.webContents, 'Tab');
  const afterNameTab = await settingsWindow.webContents.executeJavaScript(
    `document.activeElement?.id`,
  );
  assert.equal(afterNameTab, 'opt-custom-link-url');
  clipboard.writeText(LINK_TEMPLATE);
  const clipboardBeforePaste = clipboard.readText();
  assert.equal(clipboardBeforePaste, LINK_TEMPLATE);
  settingsWindow.webContents.paste();
  await delay(100);
  assert.equal(await settingsWindow.webContents.executeJavaScript(
    `document.getElementById("opt-custom-link-url").value`,
  ), LINK_TEMPLATE);
  await sendKey(settingsWindow.webContents, 'Tab');
  const afterUrlTab = await settingsWindow.webContents.executeJavaScript(
    `document.activeElement?.id`,
  );
  assert.equal(afterUrlTab, 'custom-link-submit');
  await sendKey(settingsWindow.webContents, 'Space');
  await delay(250);
  const activationSnapshot = await readCustomLinkState(settingsWindow);
  console.log(`I17 custom-link keyboard activation ${JSON.stringify(activationSnapshot)}`);

  await waitFor('the custom link to autosave', async () => {
    const state = await readCustomLinkState(settingsWindow);
    return state.optionsStatus === 'Saved.'
      && state.storedLinks.length === 1
      && state.storedLinks[0].label === LINK_LABEL
      && state.storedLinks[0].url === LINK_TEMPLATE
      ? state : null;
  });
  const saved = await readCustomLinkState(settingsWindow);
  const inputEvents = await settingsWindow.webContents.executeJavaScript(
    `globalThis.__i17InputEvents || []`,
  );
  assert.ok(inputEvents.some((event) => event.type === 'keydown' && event.target === 'opt-custom-link-name'));
  assert.ok(inputEvents.some((event) => event.type === 'compositionstart'));
  assert.ok(inputEvents.some((event) => event.type === 'compositionupdate'));
  assert.ok(inputEvents.some((event) => event.type === 'compositionend'));
  assert.ok(inputEvents.some((event) => event.type === 'paste'
    && event.target === 'opt-custom-link-url'));
  assert.ok(inputEvents.some((event) => event.type === 'beforeinput'
    && event.target === 'opt-custom-link-url'
    && event.inputType === 'insertFromPaste'
    && event.data === LINK_TEMPLATE));
  assert.ok(inputEvents.some((event) => event.type === 'input'
    && event.target === 'opt-custom-link-url'
    && event.inputType === 'insertFromPaste'
    && event.data === LINK_TEMPLATE));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Settings reload timed out.')), 30_000);
    settingsWindow.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
    settingsWindow.webContents.reload();
  });
  await waitForSettingsStartup(settingsWindow);
  await showSettingsSection(settingsWindow, 'design');
  const reloaded = await waitFor('the reloaded Settings custom link', async () => {
    const state = await readCustomLinkState(settingsWindow);
    return state.renderedLinks.length === 1 && state.storedLinks.length === 1 ? state : null;
  });
  assert.deepEqual(reloaded.renderedLinks, [{ label: LINK_LABEL, url: LINK_TEMPLATE }]);
  assert.deepEqual(reloaded.storedLinks, [{ label: LINK_LABEL, url: LINK_TEMPLATE }]);
  assert.equal(reloaded.fieldsetDisabled, false);
  const screenshot = await captureCustomLinksSection(
    settingsWindow,
    'after-real-gsm-electron-custom-links.png',
  );

  const bridgeFailures = await exerciseBridgeFailures(mainWindow);
  settingsWindow.hide();
  const popupClick = await exerciseRealPopupClick(mainWindow, settingsWindow);
  assert.equal(openExternalAttempts.filter((attempt) => attempt.outcome === 'resolved').length, 1);
  assert.equal(openExternalAttempts.filter((attempt) => attempt.outcome === 'rejected').length, 1);

  return {
    phase,
    importResult,
    initial,
    keyboardFocus: {
      clickedName: 'opt-custom-link-name',
      afterNameTab,
      afterUrlTab,
      submitActivation: 'Space',
    },
    activationSnapshot,
    composedName,
    clipboardBeforePaste,
    pastedTemplate: LINK_TEMPLATE,
    inputEvents,
    saved,
    reloaded,
    screenshot,
    bridgeFailures,
    popupClick,
    openExternalAttempts,
  };
}

async function runRestartPhase(mainWindow) {
  const settingsWindow = await openSettings(mainWindow);
  await showSettingsSection(settingsWindow, 'design');
  const restarted = await waitFor('the restarted Settings custom link', async () => {
    const state = await readCustomLinkState(settingsWindow);
    return state.renderedLinks.length === 1 && state.storedLinks.length === 1 ? state : null;
  });
  assert.deepEqual(restarted.renderedLinks, [{ label: LINK_LABEL, url: LINK_TEMPLATE }]);
  assert.deepEqual(restarted.storedLinks, [{ label: LINK_LABEL, url: LINK_TEMPLATE }]);
  assert.equal(restarted.fieldsetDisabled, false);
  assert.equal(restarted.nameDisabled, false);
  assert.equal(restarted.urlDisabled, false);
  assert.match(restarted.helpText, /system browser/u);
  assert.equal(openExternalAttempts.length, 0, 'restart verification opens no external URL');
  const screenshot = await captureCustomLinksSection(
    settingsWindow,
    'after-restart-real-gsm-electron-custom-links.png',
  );
  return {
    phase,
    restarted,
    screenshot,
    openExternalAttempts,
  };
}

app.whenReady().then(async () => {
  const overlay = require('../main.js');
  try {
    await overlay.startOverlayApp();
    const mainWindow = await waitFor('the GSM overlay window', () => (
      windowBy((window) => window.getTitle() === 'GSM Overlay')
    ));
    await waitFor('the GSM overlay page', async () => (
      mainWindow.webContents.getURL().endsWith('/index.html')
      && await mainWindow.webContents.executeJavaScript('document.readyState === "complete"')
    ));
    await waitFor('the renderer-ready Hachidori settings delivery', async () => (
      await mainWindow.webContents.executeJavaScript(
        `dictionaryReader === "hachidori"`,
      )
    ));
    const phaseResult = phase === 'edit'
      ? await runEditPhase(mainWindow)
      : await runRestartPhase(mainWindow);
    const result = {
      ok: true,
      pid: process.pid,
      phase,
      runDirectory,
      sourceCommit: require('../hachidori/SOURCE.json').commit,
      configuredLoopbackEndpoints: CONFIGURED_LOOPBACK_ENDPOINTS,
      ...phaseResult,
    };
    const resultPath = path.join(evidenceDirectory, `real-gsm-electron-${phase}.json`);
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({
      ok: true,
      phase,
      sourceCommit: result.sourceCommit,
      openExternalAttempts: result.openExternalAttempts,
    }));
    await overlay.stopOverlayApp();
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    try {
      await overlay.stopOverlayApp();
    } catch (cleanupError) {
      console.error(cleanupError);
    }
    clearTimeout(timeout);
    app.exit(1);
  }
}).catch((error) => {
  console.error(error);
  clearTimeout(timeout);
  app.exit(1);
});
