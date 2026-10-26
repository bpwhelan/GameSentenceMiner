// Real Yomitan startup in a disposable profile, without selecting another reader.
const { app, BrowserWindow, session, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { between } = require('./helpers/overlay-startup.cjs');
const { getExtensionContentRevision } = require('../extension_revision');

const root = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-yomitan-startup-'));
const phase = process.argv[3] || 'lookup';
const overlay = path.resolve(__dirname, '..');
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => { console.error('Yomitan startup smoke timed out'); app.exit(1); }, 45000);

app.whenReady().then(async () => {
  const overlaySession = session.fromPath(path.join(root, 'overlay-profile'));
  overlaySession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    (_details, callback) => callback({ cancel: true }));
  const context = vm.createContext({
    isDev: true, path, fs, __dirname: path.join(root, 'GSM_Overlay'), setTimeout, clearTimeout, console,
    dataPath: path.join(root, 'overlay-profile'),
    getExtensionContentRevision,
    getOverlaySession: () => overlaySession,
    ensureExtensionCopy: (_name, source) => source,
  });
  const main = fs.readFileSync(path.join(overlay, 'main.js'), 'utf8');
  vm.runInContext(between(main, 'const EXTENSION_READY_TIMEOUT_MS', 'async function createHachidoriEngineWindow('), context);
  vm.runInContext(`async function startYomitan() {
    let yomitanExt;
    ${between(main, "    const yomitanExtDir = isDev ? path.join(__dirname, 'yomitan')", '  } else if (dictionaryReader === DICTIONARY_READER_HACHIDORI)')}
    return yomitanExt;
  }`, context);
  const page = path.join(root, 'GSM_Overlay', 'index.html');
  fs.mkdirSync(path.dirname(page), { recursive: true });
  const hoverBootstrap = ['hover', 'auto-hide', 'mining'].includes(phase) ? `<script>
    const {createTextHoverController} = require(${JSON.stringify(path.join(overlay, 'text_hover.js'))});
    window.hoverFixture = createTextHoverController({window, document,
      isClickThroughEnabled: () => window.textClickThrough !== false,
      onIgnore: ignore => require('electron').ipcRenderer.send('fixture-hover-ignore', ignore)});
    window.syntheticClicks = 0; window.rawMoves = 0;
    window.addEventListener('click', () => window.syntheticClicks++);
    window.addEventListener('pointermove', event => { if (event.isTrusted) window.rawMoves++; });
  </script>` : '';
  const renderer = fs.readFileSync(path.join(overlay, 'index.html'), 'utf8');
  const miningBootstrap = phase === 'mining' ? `<script>
    let dictionaryReader = 'yomitan', hideYomitanAfterMine = false, yomitanShowing = false, hideOnYomitanClose = false;
    window.minedNotes = 0; window.popupHideCount = 0;
    window.addEventListener('yomitan-popup-shown', () => { yomitanShowing = true; });
    window.addEventListener('yomitan-popup-hidden', () => { yomitanShowing = false; window.popupHideCount++; });
    window.addEventListener('gsm-anki-note-added', () => { window.minedNotes++; });
    ${between(renderer, '  async function closeYomitanLookups(', '  function getGsmDictionaryUrls(')}
    ${between(renderer, '  // Listen for mining success signal', '  let unHoverTimer')}
  </script>` : '';
  // Like index.html, install hover routing before Yomitan's document_idle script.
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><div id="word" class="text-box interactive" style="font:32px sans-serif;margin:80px">食べる</div>' + hoverBootstrap + miningBootstrap);
  const extension = await context.startYomitan();
  assert.ok(extension);
  if (phase === 'seed') {
    const settings = new BrowserWindow({ show: false, webPreferences: { session: overlaySession } });
    await settings.loadURL(`chrome-extension://${extension.id}/settings.html`);
    const archive = fs.readFileSync(path.join(__dirname, 'fixtures/yomitan-startup.zip')).toString('base64');
    await settings.webContents.executeJavaScript(`(async () => {
      const {API} = await import('./js/comm/api.js');
      const {WebExtension} = await import('./js/extension/web-extension.js');
      const {DictionaryDatabase} = await import('./js/dictionary/dictionary-database.js');
      const {DictionaryImporter} = await import('./js/dictionary/dictionary-importer.js');
      const {DictionaryImporterMediaLoader} = await import('./js/dictionary/dictionary-importer-media-loader.js');
      const {DictionaryController} = await import('./js/pages/settings/dictionary-controller.js');
      const database = new DictionaryDatabase();
      await database.prepare();
      const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
      const {errors} = await importer.importDictionary(database,
        Uint8Array.from(atob(${JSON.stringify(archive)}), c => c.charCodeAt(0)).buffer, {prefixWildcardsSupported: false});
      if (errors.length) throw new Error(errors.map(e => e.message).join('; '));
      await database.close();
      const api = new API(new WebExtension());
      const options = await api.optionsGetFull();
      const profile = options.profiles[options.profileCurrent].options;
      profile.general.showGuide = false;
      profile.general.enable = true;
      profile.audio.enabled = false;
      profile.dictionaries = [DictionaryController.createDefaultDictionarySettings('GSM startup fixture', true, '')];
      profile.scanning.inputs[0].include = '';
      profile.scanning.delay = 0;
      await api.setAllSettings(options, 'gsm-startup-smoke');
      await api.triggerDatabaseUpdated('dictionary', 'import');
    })()`);
    await overlaySession.flushStorageData();
    settings.destroy();
    clearTimeout(timeout);
    console.log('PASS: seeded a saved Yomitan dictionary and mouse-scan settings');
    app.exit(0);
    return;
  }
  const win = new BrowserWindow({ show: false, webPreferences: {
    session: overlaySession, nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, webSecurity: false,
  } });
  if (['auto-hide', 'mining'].includes(phase)) {
    const settings = new BrowserWindow({ show: false, webPreferences: { session: overlaySession } });
    await settings.loadURL(`chrome-extension://${extension.id}/settings.html`);
    await settings.webContents.executeJavaScript(`(async () => {
      const {API} = await import('./js/comm/api.js');
      const {WebExtension} = await import('./js/extension/web-extension.js');
      const api = new API(new WebExtension());
      const options = await api.optionsGetFull();
      const profile = options.profiles[options.profileCurrent].options;
      const scanning = profile.scanning;
      scanning.autoHideResults = true;
      scanning.hideDelay = 80;
      scanning.hidePopupOnCursorExit = false;
      if (${phase === 'mining'}) {
        scanning.hidePopupOnCursorExit = true;
        scanning.hidePopupOnCursorExitDelay = 50;
        profile.anki.enable = true;
        profile.anki.duplicateBehavior = 'new';
        profile.anki.cardFormats = [{...profile.anki.cardFormats[0], type: 'term', deck: 'Fixture', model: 'Fixture',
          fields: {Word: {value: '{expression}', overwriteMode: 'overwrite'},
            Screenshot: {value: '{screenshot}', overwriteMode: 'overwrite'}}}];
      }
      await api.setAllSettings(options, 'gsm-auto-hide-smoke');
    })()`);
    settings.destroy();
  }
  win.webContents.on('console-message', event => console.log('[page]', event.message));
  await win.loadFile(page);
  for (const name of ['extension_bridge.js', 'yomitan_bridge.js']) {
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(overlay, name), 'utf8'));
  }
  const version = await win.webContents.executeJavaScript(`(async () => {
    let lastError;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { return await gsmYomitanBridge.yomitanVersion({timeoutMs: 500}); }
      catch (error) { lastError = error; }
    }
    throw lastError;
  })()`);
  console.log('Yomitan frontend ready:', version);
  const entries = await win.webContents.executeJavaScript("gsmYomitanBridge.termEntries('食べる')");
  assert.ok(entries.dictionaryEntries.length > 0, 'the saved dictionary must remain available');
  await win.webContents.executeJavaScript(`window.popupShown = false;
    window.addEventListener('yomitan-popup-shown', () => { window.popupShown = true; });`);
  const point = await win.webContents.executeJavaScript(`(() => {
    const r = document.querySelector('#word').getBoundingClientRect();
    return {x: Math.round(r.x + 12), y: Math.round(r.y + 16)};
  })()`);
  if (phase === 'hover') {
    win.setIgnoreMouseEvents(true, { forward: true });
    ipcMain.on('fixture-hover-ignore', (_event, ignore) => win.setIgnoreMouseEvents(ignore, { forward: true }));
  }
  win.webContents.sendInputEvent({type: 'mouseMove', ...point});
  await win.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 100; i++) {
      if (window.popupShown) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('A mouse lookup did not show a Yomitan popup');
  })()`);
  const popup = win.webContents.mainFrame.frames.find(frame => frame.url.includes('/popup.html'));
  assert.ok(popup, 'a real Yomitan popup frame must be created');
  const definition = await popup.executeJavaScript(`(async () => {
    for (let i = 0; i < 100; i++) {
      if (document.querySelector('.gloss-list')?.textContent.includes('to eat')) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  })()`);
  assert.equal(definition, true, 'the popup must render the actual dictionary definition');
  if (phase === 'mining') {
    const buttonPoint = await popup.executeJavaScript(`(async () => {
      for (let i = 0; i < 100; i++) {
        const button = document.querySelector('[data-action="save-note"]');
        if (button && !button.disabled) {
          const rect = button.getBoundingClientRect();
          return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('The real Add note button did not become ready');
    })()`);
    const buttonScreenPoint = await win.webContents.executeJavaScript(`(() => {
      const rect = document.querySelector('iframe.yomitan-popup').getBoundingClientRect();
      return {x: Math.round(rect.x + ${buttonPoint.x}), y: Math.round(rect.y + ${buttonPoint.y})};
    })()`);
    win.webContents.sendInputEvent({type: 'mouseMove', ...buttonScreenPoint});
    await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 200))');
    await win.webContents.executeJavaScript('window.popupHideCount = 0');
    await popup.executeJavaScript(`window.addEventListener('click', event => { window.fixtureClickedAction = event.target.closest('[data-action]')?.dataset.action; });`);
    // A hidden BrowserWindow has no compositor hit-test surface for native
    // clicks into its extension iframe. Activate the actual button in-frame.
    const clickNote = () => popup.executeJavaScript(`document.querySelector('[data-action="save-note"]').click()`);
    await clickNote();
    try { await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100; i++) {
        if (window.minedNotes === 1) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Mining success did not reach the overlay');
    })()`); } catch (error) {
      console.error('Mining fixture:', await popup.executeJavaScript(`({clicked: window.fixtureClickedAction,
        disabled: document.querySelector('[data-action="save-note"]')?.disabled,
        notifications: document.querySelector('#content-footer')?.textContent,
        error: document.querySelector('.anki-note-error')?.textContent})`));
      throw error;
    }
    await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 250))');
    assert.equal(await win.webContents.executeJavaScript('window.popupHideCount'), 0,
      'Add note must not hide or flicker the popup when opt-in is off, including screenshot templates');
    await popup.executeJavaScript(`(async () => {
      for (let i = 0; i < 80; i++) {
        if (!document.querySelector('[data-action="save-note"]').disabled) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Add note did not become available again');
    })()`);
    await win.webContents.executeJavaScript('hideYomitanAfterMine = true');
    await clickNote();
    await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100; i++) {
        if (window.minedNotes === 2 && window.popupHideCount === 1) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Explicit close-after-mining opt-in did not close the popup');
    })()`);
    console.log('PASS: real Add note stays open by default, skips unsupported screenshot hiding, and closes only on opt-in');
    win.destroy(); clearTimeout(timeout); app.exit(0); return;
  }
  if (phase === 'auto-hide') {
    await win.webContents.executeJavaScript(`(async () => {
      window.popupHidden = false;
      window.addEventListener('yomitan-popup-hidden', () => { window.popupHidden = true; });
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      // Reproduce a missed native mouseout followed by leaving the viewport.
      // There is no element at the destination to generate an empty scan.
      const frame = document.querySelector('iframe.yomitan-popup');
      if (!frame) throw new Error('Missing popup frame');
      const rect = frame.getBoundingClientRect();
      const popupPoint = {x: rect.x + 10, y: rect.y + 10, captured: false};
      hoverFixture.project(popupPoint);
      await delay(200);
      if (window.popupHidden) throw new Error('Auto-hide closed a popup while it was being read');
      hoverFixture.project({x: -1, y: -1, captured: true});
      await delay(60);
      hoverFixture.project(popupPoint);
      await delay(200);
      if (window.popupHidden) throw new Error('Returning to the popup did not cancel auto-hide');
      frame.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
      hoverFixture.project({...${JSON.stringify(point)}, captured: true});
      hoverFixture.project({x: -1, y: -1, captured: true});
      for (let i = 0; i < 40; i++) {
        if (window.popupHidden) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Auto-hide left the popup stuck after the pointer moved away');
    })()`);
    await win.webContents.executeJavaScript(`hoverFixture.reset(); window.popupShown = false; window.popupHidden = false;`);
    win.webContents.sendInputEvent({type: 'mouseMove', ...point});
    const nativePopupPoint = await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100; i++) {
        if (window.popupShown) {
          const rect = document.querySelector('iframe.yomitan-popup').getBoundingClientRect();
          return {x: Math.round(rect.x + 10), y: Math.round(rect.y + 10)};
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('A native mouse lookup did not reopen the popup');
    })()`);
    win.webContents.sendInputEvent({type: 'mouseMove', ...nativePopupPoint});
    await win.webContents.executeJavaScript(`new Promise(resolve => setTimeout(resolve, 200))`);
    assert.equal(await win.webContents.executeJavaScript('window.popupHidden'), false,
      'ordinary mouse movement into the popup must preserve it');
    win.webContents.sendInputEvent({type: 'mouseMove', x: 20, y: 20});
    await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 40; i++) {
        if (window.popupHidden) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Ordinary mouse movement away from the popup did not auto-hide it');
    })()`);
    console.log('PASS: real popup auto-hide handles native/projected mouse leave, reading/re-entry, and missed mouseout');
    win.destroy(); clearTimeout(timeout); app.exit(0); return;
  }
  if (phase === 'hover') {
    // A real dictionary lookup succeeded using ordinary Chromium hover while
    // the window retained its native pass-through style. Now exercise Magpie's
    // projected stream against that same unmodified Yomitan frontend.
    const tooltipBeforeCapture = await popup.executeJavaScript(`(() => {
      window.dictionaryTooltipState = () => {
        // The fixture window is hidden. Disable offscreen rendering skips so
        // Chromium hit-tests the dictionary's children as it does on screen.
        for (const entry of document.querySelectorAll('.entry')) entry.style.contentVisibility = 'visible';
        const tag = document.querySelector('.tag[data-category="dictionary"]');
        if (!tag?.title) throw new Error('Missing dictionary metadata tooltip');
        const label = tag.querySelector('.tag-label-content');
        const rect = label.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return {title: tag.title, nativeHit: tag.contains(hit)};
      };
      return dictionaryTooltipState();
    })()`);
    assert.equal(tooltipBeforeCapture.nativeHit, true, 'ordinary dictionary tooltips stay available');
    const lib = process.platform === 'win32' ? require('koffi').load('user32.dll') : null;
    const style = lib?.func('long __stdcall GetWindowLongW(uintptr_t, int)');
    const foreground = lib?.func('uintptr_t __stdcall GetForegroundWindow()');
    const hwnd = win.getNativeWindowHandle();
    const handle = hwnd.length === 8 ? hwnd.readBigUInt64LE() : BigInt(hwnd.readUInt32LE());
    const previousForeground = foreground?.();
    if (style) assert.ok(style(handle, -20) & 0x20, 'text hover must retain native click-through');
    await win.webContents.executeJavaScript(`(async () => {
      await gsmYomitanBridge.closePopups();
      await new Promise(resolve => setTimeout(resolve, 100));
      window.popupShown = false;
      hoverFixture.reset();
      const sample = {...${JSON.stringify(point)}, buttons: 0, captured: true};
      if (hoverFixture.project(sample)) throw new Error('Projected game text captured clicks');
      // Repeated stationary samples must not restart the dictionary scan delay.
      for (let i = 0; i < 100; i++) {
        hoverFixture.project(sample);
        if (window.popupShown) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Projected hover did not open the real Yomitan popup');
    })()`);
    await win.webContents.executeJavaScript('window.rawMoves = 0;');
    win.webContents.sendInputEvent({type: 'mouseMove', x: 1, y: 1});
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await win.webContents.executeJavaScript('window.rawMoves'), 0,
      'raw source coordinates must not reach the scanner after projected hover starts');
    await popup.executeJavaScript(`(async () => {
      const {TextScanner} = await import('./js/language/text-scanner.js');
      window.syncPopupPointerState = () => new Promise(resolve => {
        const listener = event => {
          if (event.source !== top || event.data?.type !== 'gsm-magpie-pointer-state') return;
          window.removeEventListener('message', listener);
          resolve(event.data.captured);
        };
        window.addEventListener('message', listener);
        top.postMessage({type: 'gsm-magpie-pointer-state-request'}, '*');
      });
      if (!await syncPopupPointerState()) throw new Error('Popup did not receive the captured cursor state');
      const original = TextScanner.prototype._searchAtFromMouseMove;
      window.popupHoverScans = 0;
      TextScanner.prototype._searchAtFromMouseMove = function(...args) {
        window.popupHoverScans++;
        return original.apply(this, args);
      };
      window.moveOverPopupWord = () => {
        const target = document.querySelector('.headword');
        if (!target) throw new Error('Missing dictionary headword');
        const rect = target.getBoundingClientRect();
        target.dispatchEvent(new PointerEvent('pointermove', {bubbles: true,
          pointerType: 'mouse', isPrimary: true, pointerId: 1,
          clientX: rect.x + 5, clientY: rect.y + 5}));
      };
      moveOverPopupWord();
    })()`);
    assert.equal(await popup.executeJavaScript('window.popupHoverScans'), 0,
      'source-space movement inside the real popup frame must not start a nested lookup');
    assert.deepEqual(await popup.executeJavaScript('dictionaryTooltipState()'),
      {title: tooltipBeforeCapture.title, nativeHit: false},
      'the raw cursor cannot hit native dictionary tooltips during Magpie capture');
    assert.equal(await popup.executeJavaScript(`(() => {
      const tag = document.querySelector('.tag[data-category="dictionary"]');
      const replacement = tag.cloneNode(true);
      replacement.title = 'Updated dictionary metadata';
      replacement.querySelector('.tag-label-content').style.pointerEvents = 'auto';
      tag.replaceWith(replacement);
      return dictionaryTooltipState().nativeHit;
    })()`), false, 'new dictionary content and its descendants also suppress native tooltips');
    await win.webContents.executeJavaScript(`hoverFixture.project({...${JSON.stringify(point)}, captured: false});`);
    await popup.executeJavaScript('syncPopupPointerState()');
    assert.deepEqual(await popup.executeJavaScript('dictionaryTooltipState()'),
      {title: 'Updated dictionary metadata', nativeHit: true},
      'native tooltip hit testing and current metadata survive cursor handoff');
    await popup.executeJavaScript('moveOverPopupWord()');
    assert.ok(await popup.executeJavaScript('window.popupHoverScans > 0'),
      'intentional popup word scanning resumes after native cursor handoff');
    const hitResults = await win.webContents.executeJavaScript(`(() => {
      let popupPoint = null;
      for (let y = 5; y < innerHeight && !popupPoint; y += 10) {
        for (let x = 5; x < innerWidth; x += 10) {
          if (document.elementFromPoint(x, y)?.closest('iframe.yomitan-popup, yomitan-popup-tag-name')) {
            popupPoint = {x, y, captured: false}; break;
          }
        }
      }
      if (!popupPoint) throw new Error('No visible dictionary surface found');
      return {popup: hoverFixture.project(popupPoint),
        text: hoverFixture.project({...${JSON.stringify(point)}, captured: false}), clicks: syntheticClicks};
    })()`);
    assert.deepEqual(hitResults, { popup: true, text: false, clicks: 0 });
    assert.equal(await win.webContents.executeJavaScript(`window.textClickThrough = false;
      hoverFixture.project({...${JSON.stringify(point)}, captured: true});`), true,
    'disabling click-through captures text while retaining projected lookup');
    if (foreground) assert.equal(foreground(), previousForeground, 'hover must not activate the overlay');
    assert.equal(win.isFocused(), false);
    console.log('PASS: real Yomitan normal/projected hover, dictionary tooltip capture/handoff, text click-through, popup hit regions, no synthetic clicks or focus changes');
    win.destroy(); clearTimeout(timeout); app.exit(0); return;
  }
  for (const name of ['dictionary_navigation.js', 'gamepad.js', 'jiten_highlight.js']) {
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(overlay, name), 'utf8') + '\nvoid 0;');
  }
  const navigation = await win.webContents.executeJavaScript(`(async () => {
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitFor = async predicate => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await delay(50);
      }
      throw new Error('Gamepad popup did not become ready');
    };
    await gsmYomitanBridge.closePopups();
    await delay(100);
    document.querySelector('#word').remove();
    const handler = new GamepadHandler({ connectToServer: false, keyboardEnabled: false,
      focusOverlayOnEntry: false, initialPosition: 'first-new' });
    handler.requestTokenizationForBlock = () => {};
    let hidden = 0;
    window.addEventListener('yomitan-popup-hidden', () => hidden++);
    handler.activateNavigation(); // Enter before OCR has supplied any text.
    let block = document.createElement('p');
    block.className = 'text-block-container';
    block.style.cssText = 'position:absolute;left:80px;top:80px;font:32px sans-serif';
    for (const glyph of '食べる食べる') {
      const box = document.createElement('span');
      box.className = 'text-box';
      box.dataset.lineIndex = '0';
      box.textContent = glyph;
      block.appendChild(box);
    }
    document.body.appendChild(block);
    handler.handleOverlayTextRenderComplete();
    // Replace the target before the posted lookup can be consumed by Yomitan.
    const snapshot = handler.prepareForOverlayTextRender();
    const replacement = block.cloneNode(true);
    block.replaceWith(replacement);
    block = replacement;
    handler.handleOverlayTextRenderComplete({ snapshot });
    await waitFor(() => handler.dictionaryPopupVisible);
    const hiddenBeforeParse = hidden;
    GsmJitenHighlight.requestParse([{ text: block.textContent }]);
    await delay(20);
    document.querySelector('#jiten-parse-container p').innerHTML =
      '<span class="jiten-word mature">食べる</span><span class="jiten-word new">食べる</span>';
    await waitFor(() => handler.getCurrentAnchorCharIndex() === 3);
    await delay(400); // Let the real reader and DOM observers finish.
    const afterParse = { visible: handler.dictionaryPopupVisible, hidden: hidden - hiddenBeforeParse };
    // An explicit cancel must survive further recalibration/highlighting.
    handler.cancelSelection();
    await waitFor(() => !handler.dictionaryPopupVisible);
    block.style.left = '100px';
    handler.handleOverlayTextRenderComplete({ snapshot: handler.prepareForOverlayTextRender() });
    await delay(300);
    const afterCancel = handler.dictionaryPopupVisible;
    handler.destroy();
    GsmJitenHighlight.setEnabled(false);
    return { afterParse, afterCancel };
  })()`);
  assert.deepEqual(navigation, { afterParse: { visible: true, hidden: 0 }, afterCancel: false });
  console.log('PASS: real gamepad lookup survives early activation, target replacement and late Jiten parsing');
  console.log('PASS:', phase, 'startup, saved dictionary, bridge and real mouse popup without switching readers');
  win.destroy();
  clearTimeout(timeout);
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
