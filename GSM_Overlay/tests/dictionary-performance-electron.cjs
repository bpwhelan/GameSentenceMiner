const {app, BrowserWindow, session} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {exposeHachidoriPopupRoot} = require('./helpers/hachidori-popup-dom.cjs');
const directory = process.argv[2], reader = process.argv[3];
app.setPath('userData', path.join(directory, reader));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => {console.error('Dictionary benchmark timed out'); app.exit(1);}, 240000);

// Time a delivered mouse move through a real rendered definition. Alternate words so
// the previous popup cannot satisfy the check. Include the rest of the glossary too.
async function benchmarkHover(ses, {expectedDefinitions = 72, collapsed = false} = {}) {
  const words = ['食べる', '読む', '歩く', '今日', '日本語', '辞書', '勉強', '漢字'];
  const fixture = path.join(directory, 'GSM_Overlay', 'index.html');
  fs.mkdirSync(path.dirname(fixture), {recursive: true});
  fs.writeFileSync(fixture, `<!doctype html><html data-gsm-preload-dictionary-popup><meta charset="utf-8">
    <style>body {margin:20px; display:flex; justify-content:space-between; font:24px sans-serif}</style>
    ${words.map(word => `<span class="text-box">${word}</span>`).join(' ')}</html>`);
  const win = new BrowserWindow({show: false, width: 1280, height: 800, webPreferences: {session: ses, backgroundThrottling: false}});
  try {
    const contents = win.webContents;
    await win.loadFile(fixture);
    const points = await contents.executeJavaScript(`(() => {
      window.addEventListener('mousemove', () => {
        window.hoverTime = performance.timeOrigin + performance.now();
      }, true);
      return Array.from(document.querySelectorAll('span'), el => {
        const r = el.getBoundingClientRect();
        return {x: Math.round(r.left + 5), y: Math.round(r.top + r.height / 2)};
      });
    })()`);
    const move = i => contents.sendInputEvent({type: 'mouseMove', ...points[i], modifiers: ['shift']});
    let frame;
    for (let attempt = 0; attempt < 100; ++attempt) {
      move(words.length - 1);
      await new Promise(resolve => setTimeout(resolve, 50));
      if (reader === 'yomitan') frame = contents.mainFrame.frames.find(child => child.url.endsWith('/popup.html'));
      else if (await exposeHachidoriPopupRoot(contents)) frame = contents.mainFrame;
      if (frame) break;
    }
    assert.ok(frame, `${reader} popup unavailable`);
    const first = [], complete = [];
    for (let round = 0; round < 4; ++round) for (const [i, word] of words.entries()) {
      await frame.executeJavaScript(`(() => {
        const root = ${reader === 'yomitan' ? 'document' : "document.querySelector('hachidori-host').shadowRoot"};
        const selector = ${JSON.stringify(reader === 'yomitan' ? '.gloss-list' : '.gsm-hoshidicts-glossary-content')};
        const prefix = ${JSON.stringify(word + ' ')};
        window.definitionTimes = new Promise((resolve, reject) => {
          let firstAt;
          const observer = new MutationObserver(() => {
            const glossaries = Array.from(root.querySelectorAll(selector));
            let matches = 0;
            for (const glossary of glossaries) {
              if (glossary.textContent.includes(prefix)) ++matches;
            }
            if (!matches) return;
            const now = performance.timeOrigin + performance.now();
            firstAt ??= now;
            if (matches !== ${expectedDefinitions}) return;
            observer.disconnect(); clearTimeout(timer); resolve([firstAt, now]);
          });
          const timer = setTimeout(() => {
            observer.disconnect();
            reject(Error('Incomplete glossary for ' + prefix + ' (' + root.querySelectorAll(selector).length + ' nodes)'));
          }, 4000);
          observer.observe(root, {subtree: true, childList: true, characterData: true});
        });
      })()`);
      move(i);
      const [firstAt, completeAt] = await frame.executeJavaScript('window.definitionTimes');
      const start = await contents.executeJavaScript('window.hoverTime');
      assert.ok(firstAt >= start);
      if (round > 0) { first.push(firstAt - start); complete.push(completeAt - start); }
    }
    const summary = values => {
      values.sort((a, b) => a - b);
      return {count: values.length, medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.ceil(values.length * .95) - 1]};
    };
    if (collapsed) {
      assert.equal(await frame.executeJavaScript(`(() => {
        const rows = document.querySelectorAll('.definition-item-inner.collapsible.collapsed');
        if (rows.length !== ${expectedDefinitions}) return false;
        rows[0].querySelector('.expansion-button').click();
        return !rows[0].classList.contains('collapsed') && rows[1].classList.contains('collapsed');
      })()`), true, 'long definitions should collapse and expand individually');
    }
    return {firstDefinition: summary(first), allDefinitions: summary(complete)};
  } finally {
    win.destroy();
  }
}
app.whenReady().then(async () => {
  const ses = session.fromPartition(`persist:benchmark-${reader}`);
  ses.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_details, callback) => callback({cancel: true}));
  const extension = await ses.extensions.loadExtension(path.resolve(__dirname, '..', reader), {allowFileAccess: true});
  if (reader === 'hachidori') await require('../shared_dictionary_engine.cjs').ensureHachidoriEngine(BrowserWindow, ses, extension.id);
  const page = new BrowserWindow({show: false, webPreferences: {session: ses, backgroundThrottling: false}});
  await page.loadURL(`chrome-extension://${extension.id}/${reader === 'yomitan' ? 'templates-display.html' : 'settings.html'}`);
  const archives = JSON.parse(fs.readFileSync(path.join(directory, 'fixtures.json'), 'utf8')).map(file => fs.readFileSync(file).toString('base64'));
  await page.webContents.executeJavaScript(`(async () => {
    const archives = ${JSON.stringify(archives)};
    if (${reader === 'yomitan'}) {
      const {API} = await import('./js/comm/api.js');
      const {WebExtension} = await import('./js/extension/web-extension.js');
      const {DictionaryDatabase} = await import('./js/dictionary/dictionary-database.js');
      const {DictionaryImporter} = await import('./js/dictionary/dictionary-importer.js');
      const {DictionaryImporterMediaLoader} = await import('./js/dictionary/dictionary-importer-media-loader.js');
      const {DictionaryController} = await import('./js/pages/settings/dictionary-controller.js');
      const database = new DictionaryDatabase(); await database.prepare();
      const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
      for (const archive of archives) {
        const {errors} = await importer.importDictionary(database, Uint8Array.from(atob(archive), c => c.charCodeAt(0)).buffer, {prefixWildcardsSupported: false});
        if (errors.length) throw Error(errors.map(e => e.message).join('; '));
      }
      database.close();
      const api = new API(new WebExtension()); const options = await api.optionsGetFull();
      const profile = options.profiles[options.profileCurrent].options;
      profile.general.showGuide = false; profile.general.enable = true; profile.audio.enabled = false;
      profile.dictionaries = archives.map((_, i) => DictionaryController.createDefaultDictionarySettings('GSM benchmark ' + i, true, ''));
      await api.setAllSettings(options, 'gsm-benchmark'); await api.triggerDatabaseUpdated('dictionary', 'import');
      window.lookup = text => api.termsFind(text, {}, {current: true});
      window.setView = async (mode, collapsible) => {
        profile.general.resultOutputMode = mode;
        profile.general.maxResults = 32;
        for (const dictionary of profile.dictionaries) dictionary.definitionsCollapsible = collapsible;
        await api.setAllSettings(options, 'gsm-benchmark-view');
      };
      window.checkInvalidation = async () => {
        const saved = profile.dictionaries;
        profile.dictionaries = saved.map(dictionary => ({...dictionary, enabled: false}));
        await api.setAllSettings(options, 'gsm-benchmark-disable');
        if ((await lookup('食べた')).dictionaryEntries.length) throw Error('Disabled dictionaries remained cached');
        profile.dictionaries = saved;
        await api.setAllSettings(options, 'gsm-benchmark-enable');
        if (!(await lookup('食べた')).dictionaryEntries.length) throw Error('Reenabled dictionaries remained empty');
        await database.prepare();
        for (const dictionary of saved) await database.deleteDictionary(dictionary.name, 1000, () => {});
        database.close();
        await api.triggerDatabaseUpdated('dictionary', 'delete');
        if ((await lookup('食べた')).dictionaryEntries.length) throw Error('Deleted dictionaries remained cached');
      };
    } else {
      let sequence = 0;
      const request = (type, fields = {}) => chrome.runtime.sendMessage({target:'hoshidicts-offscreen', type, requestId: 'benchmark-' + ++sequence, ...fields});
      for (let attempt = 0; attempt < 300; ++attempt) {
        const status = await request('hd_status');
        if (status.ready && !status.loading) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      for (const archive of archives) {
        const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(archive), c => c.charCodeAt(0))]));
        const result = await request('hd_import', {blobUrl, fileName: 'fixture.zip'}); URL.revokeObjectURL(blobUrl);
        if (!result.ok) throw Error(JSON.stringify(result));
      }
      window.lookup = text => request('hd_lookup', {text, options: {}});
      window.checkInvalidation = async () => {
        const state = (await chrome.storage.local.get('dictionaryState')).dictionaryState;
        const disabled = await request('hd_apply_state', {baseRevision: state.revision,
          dictionaries: state.dictionaries.map(dictionary => ({...dictionary, enabled: false}))});
        if (!disabled.ok || (await lookup('食べた')).results.length) throw Error('Disabled dictionaries remained cached');
        const current = (await chrome.storage.local.get('dictionaryState')).dictionaryState;
        const enabled = await request('hd_apply_state', {baseRevision: current.revision, dictionaries: state.dictionaries});
        if (!enabled.ok || !(await lookup('食べた')).results.length) throw Error('Reenabled dictionaries remained empty');
        const reloaded = await request('hd_reload');
        if (!reloaded.ok || !(await lookup('食べた')).results.length) throw Error('Reloaded dictionary lookup failed');
      };
    }
  })()`);
  const result = await page.webContents.executeJavaScript(`(async () => {
    const words = ['食べた', '読んだ', '歩いた', '今日', '日本語', '辞書', '勉強', '漢字', '未知の言葉'];
    const samples = {firstPass: [], repeated: []}; let found = 0;
    for (let round = 0; round < 13; ++round) for (const word of words) {
      const start = performance.now(), reply = await lookup(word);
      samples[round === 0 ? 'firstPass' : 'repeated'].push(performance.now() - start);
      found += Number((reply.dictionaryEntries || reply.results || []).length > 0);
    }
    const summary = values => { values.sort((a,b) => a-b); return {count: values.length, medianMs: values[Math.floor(values.length/2)], p95Ms: values[Math.ceil(values.length*.95)-1]}; };
    return {reader: ${JSON.stringify(reader)}, firstPass: summary(samples.firstPass), repeated: summary(samples.repeated), found};
  })()`);
  assert.ok(result.found >= 8 * 13, JSON.stringify(result));
  result.warmHover = await benchmarkHover(ses);
  if (reader === 'yomitan') {
    await page.webContents.executeJavaScript("setView('split', 'not-collapsible')");
    result.warmSplitHover = await benchmarkHover(ses, {expectedDefinitions: 32});
    await page.webContents.executeJavaScript("setView('group', 'collapsed')");
    result.warmCollapsedHover = await benchmarkHover(ses, {collapsed: true});
  }
  await page.webContents.executeJavaScript('checkInvalidation()');
  result.invalidation = 'passed';
  fs.writeFileSync(path.join(directory, `${reader}.json`), JSON.stringify(result, null, 2));
  clearTimeout(timeout); app.exit(0);
}).catch(error => {console.error(error); app.exit(1);});
