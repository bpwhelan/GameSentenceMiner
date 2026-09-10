// Run with Electron, not Node. Uses a fresh disposable profile and a synthetic
// extension; DNS is disabled. A loopback server exercises real Chromium I/O.
const { app, session, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const moduleRoot = process.env.GSM_JITEN_TEST_ASAR || path.join(__dirname, '..');
const { JitenParseCache, DEFAULT_JITEN_PARSE_URL } = require(path.join(moduleRoot, 'jiten_cache'));
const { installJitenSessionBroker } = require(path.join(moduleRoot, 'jiten_session'));

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-jiten-smoke-'));
app.setPath('userData', path.join(directory, 'profile'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
app.commandLine.appendSwitch('disable-background-networking');
const timeout = setTimeout(() => { console.error('Electron Jiten smoke test timed out'); app.exit(1); }, 25_000);

app.whenReady().then(async () => {
  const calls = [];
  let writes = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(request.headers['x-api-key'], 'offline-test');
    if (request.url.endsWith('/srs/review')) {
      writes++;
      await new Promise(resolve => setTimeout(resolve, 300));
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url.endsWith('/reader/lookup-vocabulary')) {
      const words = Array.isArray(body.words) ? body.words : [];
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ result: words.map(() => [0]), decks: words.map(() => []) }));
      return;
    }
    const text = Array.isArray(body.text) ? body.text : [];
    calls.push(text);
    response.setHeader('Content-Type', 'application/json');
    const vocabulary = [{ wordId: 1, readingIndex: 0, spelling: '猫', reading: 'ねこ', knownState: [0], studyDeckIds: [] }];
    response.end(JSON.stringify({
      tokens: text.map(value => [{ wordId: 1, readingIndex: 0, start: 0, end: value.length, length: value.length }]),
      vocabulary,
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ses = session.fromPath(path.join(directory, 'session'));
  const broker = new JitenParseCache({ batchDelayMs: 20, minIntervalMs: 0, parseIntervalMs: 0,
    fetch: (url, init) => ses.fetch(`${base}${new URL(url).pathname}`, { ...init, bypassCustomProtocolHandlers: true }),
  });
  const uninstall = installJitenSessionBroker(ses, broker);
  const extensionDirectory = path.join(directory, 'extension');
  fs.mkdirSync(extensionDirectory);
  fs.writeFileSync(path.join(extensionDirectory, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'GSM Jiten offline test', version: '1.0',
    host_permissions: ['https://api.jiten.moe/*'], background: { service_worker: 'worker.js' },
    web_accessible_resources: [{ resources: ['grading.html', 'grading.js'], matches: ['<all_urls>'] }],
  }));
  fs.writeFileSync(path.join(extensionDirectory, 'worker.js'), `
    chrome.runtime.onMessage.addListener((message, _sender, reply) => {
      fetch('${DEFAULT_JITEN_PARSE_URL}', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'ApiKey offline-test' },
        body: JSON.stringify({ text: message.text })
      }).then(async response => reply({ status: response.status, body: await response.json() }))
        .catch(error => reply({ error: error.message }));
      return true;
    });
  `);
  fs.writeFileSync(path.join(extensionDirectory, 'probe.html'), '<!doctype html><title>Offline test</title>');
  const gradingSource = fs.readFileSync(path.join(__dirname, '../yomitan/js/display/gsm-jiten-grading.js'), 'utf8').replace('export class', 'class');
  fs.writeFileSync(path.join(extensionDirectory, 'grading.html'), '<!doctype html><meta charset="utf-8"><script src="grading.js"></script>');
  fs.writeFileSync(path.join(extensionDirectory, 'grading.js'), gradingSource + `
    const grader = new GsmJitenGrading({});
    grader._getCurrentHeadword = () => ({term:'猫', reading:'ねこ'});
    grader._setStatus = (text, tone) => { if(tone === 'success' || tone === 'error') window.top.postMessage({type:'gsm-test-done', tone, text}, '*'); };
    window.addEventListener('message', grader._onMessageBind);
    const button = document.createElement('button');
    button.dataset.kind = 'review'; button.dataset.rating = '3'; button.textContent = 'Good';
    void grader._onButtonClick(button);
  `);
  const extension = await ses.extensions.loadExtension(extensionDirectory, { allowFileAccess: true });
  const window = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  await window.loadURL(`chrome-extension://${extension.id}/probe.html`);
  const [worker, renderer] = await Promise.all([
    window.webContents.executeJavaScript(`new Promise(resolve => chrome.runtime.sendMessage({text: ['猫', '犬']}, resolve))`),
    broker.parse({ apiKey: 'offline-test', text: '猫' }),
  ]);
  assert.equal(worker.status, 200, JSON.stringify(worker));
  assert.equal(worker.body.tokens.length, 2);
  assert.equal(renderer.tokens.length, 1);
  assert.equal(calls.flat().filter(text => text === '猫').length, 1);
  const inPage = await window.webContents.executeJavaScript(`fetch('${DEFAULT_JITEN_PARSE_URL}', {
    method: 'POST', headers: {'Content-Type':'application/json', 'X-Api-Key':'offline-test'},
    body: JSON.stringify({text:['猫','犬']})
  }).then(async response => ({status:response.status, body:await response.json()}))`);
  assert.equal(inPage.status, 200);
  assert.equal(inPage.body.tokens.length, 2);
  assert.equal(calls.flat().length, 2);
  const retryStatus = await window.webContents.executeJavaScript(`(async () => {
    const controller = new AbortController();
    const init = {method:'POST', headers:{'Content-Type':'application/json', Authorization:'ApiKey offline-test', 'X-GSM-Request-Id':crypto.randomUUID()}, body:JSON.stringify({wordId:1, readingIndex:0, rating:3})};
    setTimeout(() => controller.abort(), 150);
    await fetch('https://api.jiten.moe/api/srs/review', {...init, signal:controller.signal}).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 350));
    return (await fetch('https://api.jiten.moe/api/srs/review', init)).status;
  })()`);
  assert.equal(retryStatus, 200);
  assert.equal(writes, 1);
  // Use the actual custom GSM/Yomitan sender, overlay reply handler, and main
  // IPC handlers. The popup is an extension iframe inside a Node-enabled page.
  const mainSource = fs.readFileSync(path.join(moduleRoot, 'main.js'), 'utf8');
  const recordDiagnostic = require(path.join(moduleRoot, 'diagnostics')).createOverlayDiagnostics(directory);
  const parseSource = mainSource.slice(mainSource.indexOf("ipcMain.handle('gsm-jiten-parse'"), mainSource.indexOf("ipcMain.handle('gsm-jiten-parse-frame'"));
  new Function('ipcMain', 'jitenParseCache', 'JITEN_DEFAULT_PARSE_URL', 'recordOverlayDiagnostic', parseSource)(ipcMain, broker, DEFAULT_JITEN_PARSE_URL, recordDiagnostic);
  ipcMain.on('gsm-jiten-grade-stage', (event, stage) => {
    recordDiagnostic(`grade-${stage}`);
    event.returnValue = true;
  });
  const ipcSource = mainSource.slice(mainSource.indexOf("ipcMain.handle('gsm-jiten-review'"), mainSource.indexOf('// Fetch the list of active goals'));
  new Function('ipcMain', 'jitenParseCache', 'JITEN_DEFAULT_PARSE_URL', ipcSource)(ipcMain, broker, DEFAULT_JITEN_PARSE_URL);
  const overlayHtml = fs.readFileSync(path.join(moduleRoot, 'index.html'), 'utf8');
  const handlerStart = overlayHtml.indexOf('  async function handleJitenGradeRequest(');
  const handlerSource = overlayHtml.slice(handlerStart, overlayHtml.indexOf("  window.addEventListener('message'", handlerStart));
  const resolverStart = overlayHtml.indexOf('  async function resolveJitenWordRef(');
  const resolverSource = overlayHtml.slice(resolverStart, overlayHtml.indexOf('  // After a grade, optimistically recolor', resolverStart));
  const gradingWindow = new BrowserWindow({ show: false, webPreferences: { session: ses, nodeIntegration: true, contextIsolation: false } });
  const hostPath = path.join(directory, 'grading-host.html');
  fs.writeFileSync(hostPath, '<!doctype html><body></body>');
  await gradingWindow.loadFile(hostPath);
  const gradeResult = await gradingWindow.webContents.executeJavaScript(`
    const ipcRenderer = require('electron').ipcRenderer;
    const getJitenGradingApiKey = () => 'offline-test';
    const jitenWordRefMemo = new Map();
    const jitenWordRefMemoKey = (term, reading) => String(term || '') + '\\u0001' + String(reading || '');
    ${resolverSource}
    const JITEN_GRADING_PARSE_URL = '${DEFAULT_JITEN_PARSE_URL}';
    const applyOptimisticHighlightState = () => {};
    ${handlerSource}
    new Promise(resolve => {
      window.addEventListener('message', event => {
        if(event.data.type === 'gsm-jiten-grade') void handleJitenGradeRequest(event.data, event.source);
        if(event.data.type === 'gsm-test-done') resolve({ tone: event.data.tone, text: event.data.text });
      });
      const frame = document.createElement('iframe');
      frame.src = 'chrome-extension://${extension.id}/grading.html'; document.body.append(frame);
    });
  `);
  assert.equal(gradeResult.tone, 'success');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(writes, 2, 'custom popup duplicate delivery must produce one additional write');
  assert.equal(gradingWindow.isDestroyed(), false);
  assert.ok(fs.readFileSync(path.join(directory, 'overlay-diagnostics.log'), 'utf8').includes('grade-highlighted'));
  gradingWindow.destroy();
  console.log(JSON.stringify({ ok: true, serviceWorkerIntercepted: true, rendererIntercepted: true, chromiumLoopbackTransport: true, upstreamParagraphs: calls.flat().length, batches: calls.length }));
  broker.dispose();
  uninstall();
  window.destroy();
  ses.extensions.removeExtension(extension.id);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  clearTimeout(timeout);
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
