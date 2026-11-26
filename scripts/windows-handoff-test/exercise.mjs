import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {execFileSync, spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {electronUpdateMetadata} from '../electron-update-metadata.mjs';

if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.platform !== 'win32') {
  throw Error('This exercise needs an isolated, disposable Windows runner.');
}
const {RUNNER_TEMP, APPDATA, USERPROFILE, GSM_E2E_INSTALLER: installer, GSM_E2E_VERSION: version,
  GSM_E2E_ELECTRON: electron} = process.env;
const fixture = path.join(RUNNER_TEMP, 'gsm-handoff');
const {_electron} = createRequire(path.join(fixture, 'tools/package.json'))('playwright-core');
const stayOnElectron = process.argv.includes('--stay-on-electron');
const active = stayOnElectron ? path.join(APPDATA, 'GameSentenceMiner') : path.join(fixture, 'ゲーム data');
const pointer = path.join(USERPROFILE, '.config/GameSentenceMiner/data_dir.json');
if (!stayOnElectron) {
  await fs.mkdir(path.dirname(pointer), {recursive: true});
  await fs.writeFile(pointer, JSON.stringify({version: 2, dataDir: active}), {flag: 'wx'});
}
await fs.mkdir(path.join(active, 'electron'), {recursive: true});
const prefs = {pullPreReleases: true, handoffFixture: 'retain'};
await fs.writeFile(path.join(active, 'electron/config.json'), JSON.stringify(prefs));
const backup = path.join(active, 'backup/electron-handoff');
const databasePath = path.join(active, 'gsm.db');
const lineId = 'a925a826-6ce5-437a-954e-7e13c761f7d4';
const text = 'この文章は移行後も読める。';
const dictionary = path.join(APPDATA, 'gsm_overlay/User Data/fixture-marker');
await fs.mkdir(path.dirname(dictionary), {recursive: true});
await fs.writeFile(dictionary, 'original profile');

async function exited(child) {
  const [code, signal] = await once(child, 'exit');
  return {code, signal};
}
function consent(choice, installerPid = 0) {
  return exited(spawn('pwsh', ['-NoProfile', '-File', path.join(import.meta.dirname, 'consent.ps1'), choice, String(installerPid)],
    {stdio: 'inherit', windowsHide: true})).then(({code}) => assert.equal(code, 0));
}
const declined = await Promise.all([
  exited(spawn(installer, ['/S'], {windowsHide: true})),
  consent('No'),
]);
assert.notEqual(declined[0].code, 0);
assert.equal(await fs.stat(backup).catch(() => null), null);
await fs.access(electron);
await fs.writeFile(databasePath, 'damaged fixture');
const failureProcess = spawn(installer, ['/S'], {windowsHide: true});
const failedSetup = exited(failureProcess);
await consent('Yes', failureProcess.pid);
await consent('OK', failureProcess.pid);
assert.notEqual((await failedSetup).code, 0, 'Corrupt data must stop installation');
assert.equal(await fs.stat(path.join(process.env.LOCALAPPDATA, 'GSM/gsm-desktop.exe')).catch(() => null), null);
assert.deepEqual(await fs.readdir(backup), []);
assert.equal(await fs.readFile(databasePath, 'utf8'), 'damaged fixture');
// Replace only the known synthetic file in this disposable profile.
await fs.unlink(databasePath);
const db = new DatabaseSync(databasePath);
db.exec('PRAGMA journal_mode=WAL');
db.exec(await fs.readFile(new URL('../../native/gsm-db/migrations/001_core.sql', import.meta.url), 'utf8'));
db.prepare('INSERT INTO game_lines(id, game_name, line_text, timestamp) VALUES(?, ?, ?, ?)')
  .run(lineId, '移行テスト', text, Date.now() / 1000);

const filename = 'GameSentenceMiner-Setup-' + version + '.exe';
const published = path.join(fixture, filename);
await fs.copyFile(installer, published);
const metadata = await electronUpdateMetadata(version, [published]);
const bytes = await fs.readFile(published);
let corruptDownload = true;
const requests = new Set();
const server = createServer((req, res) => {
  const resource = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1));
  requests.add(resource);
  if (['latest.yml', 'beta.yml'].includes(resource)) {
    res.end(JSON.stringify(metadata));
  } else if (resource === filename) {
    res.writeHead(200, {'content-length': bytes.length});
    res.write(Buffer.from([corruptDownload ? bytes[0] ^ 255 : bytes[0]]));
    res.end(bytes.subarray(1));
  } else {
    res.writeHead(404).end();
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const feed = 'http://127.0.0.1:' + server.address().port;
async function waitFor(label, check, timeout = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await check();
    if (value) return value;
    await delay(500);
  }
  throw Error('Timed out waiting for ' + label);
}
async function exerciseInstalledClient() {
  const app = await _electron.launch({executablePath: electron, args: [], timeout: 90000});
  const appClosed = once(app.process(), 'exit');
  console.log('Opened the installed Electron client');
  // The shipping client hardcodes GitHub in setFeedURL on every check. Redirect only
  // that provider in this process. Preserve the signed application files on disk.
  const installedVersion = await app.evaluate(({app}, url) => {
    const req = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const updater = req('electron-updater').autoUpdater;
    const setFeed = updater.setFeedURL.bind(updater);
    updater.setFeedURL = () => setFeed({provider: 'generic', url});
    updater.setFeedURL();
    return app.getVersion();
  }, feed);
  assert.equal(installedVersion, '2026.10.2');
  const hub = await waitFor('Electron Hub', () => app.windows().find(w => /renderer[\\/]index\.html/i.test(w.url())));
  await hub.waitForFunction(() => typeof window.ipcRenderer?.invoke === 'function');
  console.log('Requesting the update through the Electron Hub');
  const rejected = await hub.evaluate(async v => {
    try {
      await window.ipcRenderer.invoke('settings.installAppUpdate', v);
      return '';
    } catch (error) {
      return String(error);
    }
  }, version);
  assert.match(rejected, /checksum|sha512/i);
  assert.deepEqual(await fs.readdir(backup), []);
  corruptDownload = false;
  requests.clear();
  // Same command as the Install button. The installed manager checks the version,
  // verifies the downloaded bytes, closes its services and hands off to NSIS.
  await hub.evaluate(v => {
    window.handoffError = '';
    void window.ipcRenderer.invoke('settings.installAppUpdate', v)
      .catch(error => { window.handoffError = String(error); });
  }, version);
  await waitFor('Electron download from loopback', async () => {
    const error = await hub.evaluate(() => window.handoffError).catch(() => '');
    if (error) throw Error(error);
    return requests.has(filename);
  });
  await Promise.all([appClosed, consent(stayOnElectron ? 'No' : 'Yes')]);
  assert(requests.has('beta.yml') || requests.has('latest.yml'));
  if (stayOnElectron) {
    await waitFor('original Electron application to reopen', () => {
      const pid = execFileSync('pwsh', ['-NoProfile', '-Command', `
        Get-Process GameSentenceMiner -ErrorAction SilentlyContinue |
          Where-Object { $_.Path -eq $env:GSM_E2E_ELECTRON -and $_.MainWindowHandle -ne 0 } |
          Select-Object -First 1 -ExpandProperty Id
        exit 0
      `], {encoding: 'utf8', windowsHide: true}).trim();
      return Number(pid) > 0 && Number(pid) !== app.process().pid;
    });
    assert.deepEqual(await fs.readdir(backup), []);
    assert.equal(await fs.stat(path.join(process.env.LOCALAPPDATA, 'GSM/gsm-desktop.exe')).catch(() => null), null);
    assert.equal(db.prepare('SELECT line_text FROM game_lines WHERE id=?').get(lineId).line_text, text);
    console.log('Verified declining the downloaded update reopened the installed Electron client on its default profile.');
    return;
  }
  console.log('Electron closed and the user accepted installation');
  const ready = await waitFor('Tauri desktop gateway and intake', async () => {
    const status = await fetch('http://127.0.0.1:7275/get_status', {signal: AbortSignal.timeout(1500)})
      .then(r => r.json()).catch(() => null);
    return status?.ready && status.text_runtime?.owner === 'desktop' && status;
  });
  assert.equal(ready.transport_runtime.transport.state, 'running');
  const nativeProcess = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-Command', `
    $socket = Get-NetTCPConnection -State Listen -LocalPort 7275 | Select-Object -First 1
    $exe = (Get-Process -Id $socket.OwningProcess).Path
    $registration = Get-ItemProperty 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/GSM'
    @{ executable = $exe; version = $registration.DisplayVersion
       registered = Join-Path ($registration.InstallLocation.Trim('"')) $registration.MainBinaryName } | ConvertTo-Json
  `], {encoding: 'utf8', windowsHide: true}));
  assert.equal(nativeProcess.version, version);
  assert.equal(nativeProcess.executable.toLowerCase(), nativeProcess.registered.toLowerCase());
  const snapshots = await fs.readdir(backup);
  assert.equal(snapshots.length, 1);
  const saved = path.join(backup, snapshots[0]);
  const snapshot = JSON.parse(await fs.readFile(path.join(saved, 'snapshot.json')));
  assert.equal(snapshot.sourceVersion, installedVersion);
  assert.equal(snapshot.targetVersion, version);
  assert.equal(snapshot.dataDir, active);
  const savedDB = new DatabaseSync(path.join(saved, 'gsm.db'), {readOnly: true});
  for (const database of [savedDB, db]) {
    assert.equal(database.prepare('SELECT line_text FROM game_lines WHERE id=?').get(lineId).line_text, text);
    assert.equal(database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  }
  savedDB.close();
  for (const root of [saved, active]) {
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'electron/config.json'))).handoffFixture, 'retain');
  }
  assert.equal(JSON.parse(await fs.readFile(pointer)).dataDir, active);
  assert.equal(await fs.readFile(dictionary, 'utf8'), 'original profile');
  await fs.access(electron);
  console.log('Verified installed Electron', installedVersion, '→ Tauri', version, 'with desktop-owned intake and gateway.');
  console.log('Verified consent, cancellation, original installation, committed WAL, relocated settings and profile sentinel.');
}
try {
  await exerciseInstalledClient();
} finally {
  db.close();
  server.close();
}
