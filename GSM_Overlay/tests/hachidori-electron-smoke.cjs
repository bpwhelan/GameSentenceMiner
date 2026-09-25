// Real Chromium content-script isolation and upstream rendering; only the dictionary/Anki services are fixtures.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { loadOverlayStartup, rendererGamepadConfigSource } = require('./helpers/overlay-startup.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-hachidori-smoke-'));
app.setPath('userData', path.join(root, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
const timeout = setTimeout(() => { console.error('Hachidori smoke timed out'); app.exit(1); }, 45000);

const background = `
import './reader-options.js';
const calls = [];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let focusScenario = null;
const ready = chrome.storage.local.set({
  options: { ...globalThis.HDReaderOptions.DEFAULT_OPTIONS, revision: 1, popupWidth: 600,
    audioAutoplay: true, anki: { ...globalThis.HDReaderOptions.DEFAULT_OPTIONS.anki, model: 'Fixture' } },
  dictionaryState: { revision: 1, dictionaries: [{ id: 'fixture', title: 'Fixture', path: 'fixture', enabled: true, termCount: 3 }] }
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  ready.then(async () => {
    calls.push({ type: message.type, text: message.text, request: message.request });
    let payload = {};
    switch (message.type) {
      case 'hd_page_zoom': payload = { zoomFactor: 1 }; break;
      case 'hd_lookup':
        if (message.text.startsWith('遅')) await new Promise(resolve => setTimeout(resolve, 300));
        payload = { generation: 1, dictionaryCount: 1, results: ['猫', '犬', '鳥'].map((word, index) => ({
          matched: message.text[0], term: { expression: word, reading: ['ねこ','いぬ','とり'][index],
            rules: '', frequencies: [], pitches: [], glossaries: [{ dictionary: 'Fixture',
              glossary: JSON.stringify([{ type: 'structured-content', content: { tag: 'a', href: '?query=犬', content: '犬' } }, 'Definition '.repeat(80)]), definitionTags: '', termTags: '', score: 0 }] }
        })) }; break;
      case 'hd_styles': payload = { styles: [] }; break;
      case 'hd_lookup_stats_record':
      case 'hd_lookup_stats_read': payload = { descriptor: { generation: null, revision: 0 }, statistics: null }; break;
      case 'hd_anki_status': payload = { available: true, configKey: 'fixture' }; break;
      case 'hd_anki_preflight':
        if (focusScenario && message.request.term.expression !== '猫') {
          await (message.request.term.expression === '犬' ? focusScenario.first : focusScenario.later).promise;
        }
        payload = { canAdd: true, state: 'ready', action: 'add' }; break;
      case 'hd_anki_submit': payload = { state: 'added', noteId: 1234 }; break;
      case 'hd_audio_play': {
        const scenario = focusScenario;
        if (scenario?.mode === 'playing') await scenario.audio.promise;
        payload = { status: scenario?.mode === 'no-result' ? 'no-result' : 'success' }; break;
      }
      case 'hd_status':
        if (message.focusScenario) focusScenario = { mode: message.focusScenario, first: deferred(), later: deferred(), audio: deferred() };
        if (message.releaseFirst) focusScenario.first.resolve();
        if (message.finishFocus) {
          focusScenario.first.resolve(); focusScenario.later.resolve(); focusScenario.audio.resolve();
          focusScenario = null;
        }
        payload = { calls }; break;
    }
    respond({ ...payload, ok: true, type: message.type + '_result', requestId: message.requestId });
  });
  return true;
});`;

app.whenReady().then(async () => {
  const startup = loadOverlayStartup({ experimental: { enable_experimental_features: true, enable_hachidori: true } });
  const handlerConfig = rendererGamepadConfigSource(startup.settingsPayload(), {
    enabled: true, controllerEnabled: false, keyboardEnabled: false,
    focusOverlayOnEntry: false, initialPosition: 'start',
    tokenizerBackend: 'yomitan', localTokenizerFallbackBackend: 'yomitan',
  });
  const extension = path.join(root, 'extension');
  const page = path.join(root, 'GSM_Overlay', 'index.html');
  fs.mkdirSync(extension, { recursive: true });
  fs.mkdirSync(path.dirname(page));
  const vendor = path.join(__dirname, '../hachidori');
  const manifest = JSON.parse(fs.readFileSync(path.join(vendor, 'manifest.json')));
  const resources = new Set([...manifest.content_scripts[0].js, ...manifest.content_scripts[0].css,
    ...manifest.web_accessible_resources.flatMap(item => item.resources)]);
  for (const file of resources) {
    fs.mkdirSync(path.dirname(path.join(extension, file)), { recursive: true });
    fs.copyFileSync(path.join(vendor, file), path.join(extension, file));
  }
  fs.writeFileSync(path.join(extension, 'background.js'), background);
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'GSM Hachidori smoke', version: '1.0', permissions: ['storage'],
    background: { service_worker: 'background.js', type: 'module' },
    content_scripts: manifest.content_scripts, web_accessible_resources: manifest.web_accessible_resources,
  }));
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>
    body { margin:80px; font:32px sans-serif; } .text-block-container { display:block; }
    .text-box { display:inline-block; } rt { font-size:12px; }
  </style><div class="text-block-container"><span class="text-box" data-line-index="0"><ruby>猫<rt>ねこ</rt></ruby></span><span class="text-box" data-line-index="0">犬</span><span class="text-box" data-line-index="0">遅</span></div>`);
  await session.defaultSession.extensions.loadExtension(extension, { allowFileAccess: true });
  const win = new BrowserWindow({ show: false, width: 1200, height: 850,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (/hachidori:|Error|failed/i.test(event.message)) console.log(event.message); });
  await win.loadFile(page);
  for (const file of ['extension_bridge.js', 'hachidori_bridge.js', 'dictionary_navigation.js', 'gamepad.js']) {
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '..', file), 'utf8') + '\nvoid 0;');
  }
  const result = await win.webContents.executeJavaScript(`(async () => {
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const wait = async (check, label) => {
      for (let attempt = 0; attempt < 150; attempt++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
      throw new Error('Timed out: ' + label);
    };
    await wait(async () => { try { return (await gsmHachidoriBridge.capabilities({ timeoutMs: 150 })).version === 1; } catch { return false; } }, 'bridge ready');
    await wait(async () => (await gsmHachidoriBridge.invoke('options'))?.revision === 1, 'fixture storage');
    window.addEventListener('message', event => {
      if (event.data?.type === 'gsm-jiten-grading-config-request') window.postMessage({ type:'gsm-jiten-grading-config', enabled:true, hasApiKey:true }, '*');
      if (event.data?.type === 'gsm-jiten-grade') { window.lastGrade = event.data; window.postMessage({ type:'gsm-jiten-grade-result', requestId:event.data.requestId, ok:true }, '*'); }
    });
    let mined = 0;
    window.addEventListener('gsm-anki-note-added', () => mined++);
    const root = () => document.querySelector('hachidori-host')?.shadowRoot;
    // Open through native hover before the handler exists, then recover that popup's state.
    const mouseTarget = document.querySelectorAll('.text-box')[1];
    const mouseRect = mouseTarget.getBoundingClientRect();
    mouseTarget.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, shiftKey: true,
      clientX: mouseRect.x + mouseRect.width / 2, clientY: mouseRect.y + mouseRect.height / 2 }));
    await wait(async () => (await gsmHachidoriBridge.state()).popups.length === 1, 'native mouse lookup');
    const handler = new GamepadHandler(${handlerConfig});
    await wait(() => handler.dictionaryPopupVisible, 'existing mouse popup tracking');
    handler.navigateDictionaryNextEntry();
    await wait(async () => (await gsmHachidoriBridge.invoke('selection')).index === 1, 'mouse popup navigation');
    handler.cancelSelection();
    await wait(() => !handler.dictionaryPopupVisible, 'mouse popup cancel');
    handler.activateNavigation();
    await wait(() => handler.dictionaryPopupVisible && root()?.querySelector('.gsm-hoshidicts-entry'), 'gamepad lookup');
    assert(document.querySelectorAll('iframe').length === 0, 'Hachidori should not require a popup iframe');
    const calls = async () => (await gsmHachidoriBridge.invoke('status')).calls;
    assert((await calls()).some(call => call.type === 'hd_lookup' && call.text.startsWith('猫犬')), 'Lookup must skip ruby readings');
    await wait(() => root().querySelector('[data-action="add"]:not(:disabled)'), 'Anki preflight');
    await wait(() => root().querySelector('.gsm-controller-selected[data-action="add"]'), 'mine selection');
    handler.confirmSelection();
    handler.confirmSelection();
    await wait(() => mined === 1, 'native mining completion');
    assert((await calls()).filter(call => call.type === 'hd_anki_submit').length === 1, 'Repeated confirm must not submit twice');
    handler.navigateDictionaryNextEntry();
    await wait(async () => (await gsmHachidoriBridge.invoke('selection')).index === 1, 'next entry');
    handler.navigateDictionaryPrevEntry();
    await wait(async () => (await gsmHachidoriBridge.invoke('selection')).index === 0, 'previous entry');
    window.postMessage({ type:'gsm-jiten-grading-config', enabled:true, hasApiKey:true }, '*');
    await wait(() => root().querySelector('.gsm-jiten-btn'), 'grading bar');
    handler.navigateDictionaryPrevEntry();
    await wait(() => root().querySelector('.gsm-controller-selected[data-rating="3"]'), 'grading selection');
    handler.confirmSelection();
    await wait(() => window.lastGrade?.rating === 3, 'grade request');
    assert(window.lastGrade.term === '猫', 'Grade must use the active entry');
    handler.navigateDictionaryNextEntry();
    await gsmHachidoriBridge.control('command', { command: 'playAudio' });
    await wait(async () => (await calls()).some(call => call.type === 'hd_audio_play'), 'native audio command');
    const scroller = root().querySelector('.gsm-hoshidicts-content-scroll');
    await gsmHachidoriBridge.control('scroll', { direction: 1, step: 80 });
    assert(scroller.scrollTop > 0, 'Right stick scroll must move popup content');
    root().querySelector('[data-hoshidicts-query="犬"]').click();
    await wait(() => handler.dictionaryPopupCount === 2, 'nested popup');
    handler.navigateDictionaryNextEntry();
    await wait(async () => {
      const selected = await gsmHachidoriBridge.invoke('selection');
      return selected.depth === 1 && selected.index === 1;
    }, 'nested entry routing');
    await gsmHachidoriBridge.control('command', { command:'close' });
    await wait(() => handler.dictionaryPopupCount === 1, 'return to parent popup');
    assert((await gsmHachidoriBridge.invoke('selection')).depth === 0, 'Parent selection must survive a child close');
    window.dispatchEvent(new Event('blur'));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert(handler.dictionaryPopupVisible, 'Blur must not close controller popup');
    handler.cancelSelection();
    await wait(() => !handler.dictionaryPopupVisible, 'cancel');
    // Cancel while a real content-script lookup is in flight.
    const late = document.querySelectorAll('.text-box')[2];
    handler.triggerDictionaryLookup({ targetChar: late, centerX: 150, centerY: 100 });
    await new Promise(resolve => setTimeout(resolve, 30));
    handler.cancelSelection();
    await new Promise(resolve => setTimeout(resolve, 400));
    assert(!handler.dictionaryPopupVisible, 'Late lookup must not reopen a canceled popup');
    // Enable just the current entry while other entries' Anki checks remain pending.
    // There is no popup lifecycle event or controller input to repair the default.
    for (const mode of ['playing', 'no-result']) {
      await gsmHachidoriBridge.invoke('status', { focusScenario: mode });
      handler.triggerDictionaryLookup({ targetChar: document.querySelector('.text-box'), centerX: 95, centerY: 100 });
      await wait(() => handler.dictionaryPopupVisible, 'focus scenario popup: ' + mode);
      await wait(() => root().querySelector('.gsm-controller-selected[data-action="add"]:not(:disabled)'), 'first entry ready');
      handler.navigateDictionaryNextEntry();
      await wait(async () => (await gsmHachidoriBridge.invoke('selection')).index === 1, 'pending entry selected');
      const audio = () => root().querySelectorAll('.gsm-hoshidicts-audio-button')[1];
      await gsmHachidoriBridge.control('command', { command: 'playAudio' });
      await wait(() => mode === 'playing' ? audio()?.getAttribute('aria-busy') === 'true'
        : audio()?.dataset.state === 'error', 'audio scenario: ' + mode);
      await wait(() => audio()?.classList.contains('gsm-controller-selected'), 'provisional audio default');
      await wait(() => root().querySelectorAll('.gsm-hoshidicts-mine-button:disabled').length === 2, 'pending entry checks');
      await new Promise(resolve => setTimeout(resolve, 100));
      await gsmHachidoriBridge.invoke('status', { releaseFirst: true });
      const mine = () => root().querySelectorAll('.gsm-hoshidicts-mine-button')[1];
      await wait(() => !mine().disabled, 'current entry ready');
      assert(mine().classList.contains('gsm-controller-selected'), 'Mining must be selected as soon as it is ready: ' + mode);
      assert(root().querySelector('.gsm-hoshidicts-mine-button:disabled'), 'Other entries must still be checking Anki');
      if (mode === 'playing') assert(audio().getAttribute('aria-busy') === 'true', 'Audio must still be playing');
      await gsmHachidoriBridge.invoke('status', { finishFocus: true });
      await wait(() => !root().querySelector('.gsm-hoshidicts-mine-button:disabled')
        && audio().getAttribute('aria-busy') === 'false', 'focus scenario completed');
      handler.cancelSelection();
      await wait(() => !handler.dictionaryPopupVisible, 'focus scenario closed');
    }
    handler.triggerDictionaryLookup({ targetChar: document.querySelector('.text-box'), centerX: 95, centerY: 100 });
    await wait(() => handler.dictionaryPopupVisible, 'final popup');
    await wait(() => root().querySelector('.gsm-controller-selected[data-action="add"]:not(:disabled)'), 'final action availability');
    await wait(() => root().querySelector('.gsm-jiten-bar:not([hidden])'), 'final grading bar');
    window.fixtureHandler = handler;
    return { mining: mined, grading: window.lastGrade.rating, calls: (await calls()).map(call => call.type) };
  })()`);
  assert.equal(result.mining, 1);
  console.log('Hachidori Electron smoke passed:', JSON.stringify(result));
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await win.capturePage().then(image => fs.writeFileSync(path.join(root, 'smoke.png'), image.toPNG()));
  console.log('Screenshot:', path.join(root, 'smoke.png'));
  await win.webContents.executeJavaScript('window.fixtureHandler.destroy();');
  win.destroy(); clearTimeout(timeout); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
