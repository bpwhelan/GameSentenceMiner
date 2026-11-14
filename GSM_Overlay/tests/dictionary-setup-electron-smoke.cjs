// Real Yomitan importer, in an isolated profile, with fixture downloads only.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const archiver = require('archiver');
const { createDictionarySetup } = require('../dictionary_setup');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-dictionary-setup-'));
app.setPath('userData', path.join(root, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => { console.error('Dictionary setup smoke test timed out'); app.exit(1); }, 90000);

async function zip(language, title) {
  const archive = archiver('zip');
  const chunks = [];
  const done = new Promise((resolve, reject) => { archive.on('data', chunk => chunks.push(chunk)); archive.on('end', () => resolve(Buffer.concat(chunks))); archive.on('error', reject); });
  archive.append(JSON.stringify({ title, revision: 'test-1', format: 3, sourceLanguage: language, targetLanguage: 'en' }), { name: 'index.json' });
  archive.append(JSON.stringify([[language === 'ja' ? '猫' : '你好', '', '', '', 0, ['fixture definition'], -1, '']]), { name: 'term_bank_1.json' });
  await archive.finalize();
  return done;
}

app.whenReady().then(async () => {
  let failDownload = true;
  let downloads = 0;
  const fixtures = { ja: await zip('ja', 'Jitendex.org [2000-01-01]'), zh: await zip('zh', 'CC-CEDICT'), nb: await zip('nb', 'Norwegian-English') };
  const server = require('node:http').createServer((request, response) => {
    downloads++;
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (failDownload) { response.writeHead(503); response.end('failure fixture'); return; }
    response.setHeader('Content-Type', 'application/zip');
    response.end(fixtures[request.url.includes('jitendex') ? 'ja' : request.url.includes('norwegian') ? 'nb' : 'zh']);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (/jitendex-yomitan.zip|CC-CEDICT.zip|wty-nb-en.zip/.test(details.url) && details.url.startsWith('https:')) {
      callback({ redirectURL: `http://127.0.0.1:${port}/${details.url.includes('jitendex') ? 'jitendex' : details.url.includes('wty-nb-en') ? 'norwegian' : 'cedict'}` });
    } else callback({ cancel: !details.url.startsWith(`http://127.0.0.1:${port}/`) });
  });
  const extension = await session.defaultSession.extensions.loadExtension(path.resolve(__dirname, '../yomitan'), { allowFileAccess: true });
  const userSettings = new BrowserWindow({ show: false });
  await userSettings.loadURL(`chrome-extension://${extension.id}/settings.html`);
  await userSettings.webContents.executeJavaScript(`new Promise(resolve => {
    const ready = () => document.documentElement.dataset.loaded === 'true' ? resolve() : setTimeout(ready, 20);
    ready();
  })`);
  let reply, id = 0;
  let handle = createDictionarySetup({ BrowserWindow, getReader: () => 'yomitan', getExtension: () => extension,
    openSettings: () => {}, selectReader: () => {}, send: value => { reply = value; } });
  const request = async (action, language = 'ja') => {
    await handle({ type: 'dictionary-setup', request_id: String(++id), deadline: Date.now() + 20000, data: { action, language } });
    assert.equal(reply.success, true, reply.error);
    return reply.status;
  };
  const settled = async (language = 'ja') => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await request('status', language);
      if (!result.busy) return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`import did not settle: ${JSON.stringify(await request('status', language))}; downloads=${downloads}`);
  };
  assert.deepEqual((await request('status')).installed, []);
  await request('install');
  assert.match((await settled()).error, /503/);
  failDownload = false;
  await request('install');
  const first = await settled();
  // Settings is allowed to stay open during setup; its async reconciliation
  // must not undo the newly enabled dictionary after the import returns.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual((await request('status')).installed, ['Jitendex.org [2000-01-01]']);
  assert.equal(first.error, undefined);
  assert.deepEqual(first.installed, ['Jitendex.org [2000-01-01]']);
  const previousDownloads = downloads;
  await request('install');
  assert.deepEqual((await settled()).installed, first.installed);
  assert.equal(downloads, previousDownloads, 'retry enables the existing dictionary without another download');
  assert.deepEqual((await request('status', 'zh')).installed, [], 'a Japanese dictionary must not satisfy Chinese setup');
  await request('install', 'zh');
  const chinese = await settled('zh');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual((await request('status', 'zh')).installed, ['CC-CEDICT']);
  assert.deepEqual(chinese.installed, ['CC-CEDICT'], JSON.stringify(chinese));
  const page = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/templates-display.html'));
  const details = await page.webContents.executeJavaScript(`(async () => {
    const {API} = await import('./js/comm/api.js');
    const {WebExtension} = await import('./js/extension/web-extension.js');
    const api = new API(new WebExtension());
    return { dictionaries: await api.getDictionaryInfo(), options: await api.optionsGetFull() };
  })()`);
  assert.equal(details.dictionaries.length, 2, 'changing learning language preserves existing dictionaries');
  assert.equal(details.options.profiles[details.options.profileCurrent].options.general.language, 'zh');
  await request('install', 'no');
  assert.deepEqual((await settled('no')).installed, ['Norwegian-English'], 'catalogue language aliases work even when the archive has a different title');
  assert.deepEqual((await request('status', 'no')).installed, ['Norwegian-English']);
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  const hachidori = await session.defaultSession.extensions.loadExtension(path.resolve(__dirname, '../hachidori'), { allowFileAccess: true });
  const engine = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await engine.loadURL(`chrome-extension://${hachidori.id}/gsm/engine-host.html`);
  if (await engine.webContents.executeJavaScript('GsmHachidoriEngineHost')) engine.destroy();
  else await engine.loadURL(`chrome-extension://${hachidori.id}/offscreen.html`);
  handle = createDictionarySetup({ BrowserWindow, getReader: () => 'hachidori', getExtension: () => hachidori,
    openSettings: () => {}, selectReader: () => {}, send: value => { reply = value; } });
  assert.deepEqual((await request('status')).installed, []);
  await request('install');
  const hachidoriInstalled = await settled();
  // Hachidori deliberately rejects a redirect to our local fixture server.
  // Preserve its trust checks and verify that this is surfaced as a failure.
  assert.match(hachidoriInstalled.error, /unexpected final URL/);
  assert.deepEqual(hachidoriInstalled.installed, []);
  const hPage = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/settings.html'));
  const imported = await hPage.webContents.executeJavaScript(`(async () => {
    const blobUrl = URL.createObjectURL(new Blob([new Uint8Array(${JSON.stringify([...fixtures.ja])})]));
    try { return await chrome.runtime.sendMessage({target:'hoshidicts-offscreen',type:'hd_import',requestId:'gsm-onboarding-fixture',blobUrl,fileName:'fixture.zip'}); }
    finally { URL.revokeObjectURL(blobUrl); }
  })()`);
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.deepEqual((await request('status')).installed, ['Jitendex.org [2000-01-01]'], 'Hachidori reports existing enabled dictionaries without starting a download');
  const disabled = await hPage.webContents.executeJavaScript(`(async () => {
    const {state} = await chrome.runtime.sendMessage({target:'hoshidicts-worker',type:'hd_state_read'});
    return chrome.runtime.sendMessage({target:'hoshidicts-offscreen',type:'hd_apply_state',requestId:'gsm-disable-fixture',
      baseRevision:state.revision,dictionaries:state.dictionaries.map(item=>({...item,enabled:false})),profileId:'ja'});
  })()`);
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  assert.deepEqual((await request('status')).installed, []);
  assert.deepEqual((await request('status', 'ko')).installed, []);
  assert.equal((await request('status', 'ko')).recommended, null);
  const beforeHachidoriInstall = downloads;
  await request('install');
  assert.deepEqual((await settled()).installed, ['Jitendex.org [2000-01-01]']);
  assert.equal(downloads, beforeHachidoriInstall, 'Hachidori reuses its installed starter dictionary');
  console.log('PASS: real dictionary import, failure/retry, enabled settings, idempotence, language selection, and existing dictionary preservation');
  clearTimeout(timeout); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
