import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';

if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.platform !== 'win32') {
  throw Error('This exercise needs an isolated, disposable Windows runner.');
}
const {RUNNER_TEMP, APPDATA, USERPROFILE, GSM_E2E_INSTALLER: installer, GSM_E2E_VERSION: version,
  GSM_E2E_ELECTRON: electron} = process.env;
const fixture = path.join(RUNNER_TEMP, 'gsm-handoff');
const {_electron} = createRequire(path.join(fixture, 'tools/package.json'))('playwright-core');
const active = path.join(fixture, 'ゲーム data');
const pointer = path.join(USERPROFILE, '.config/GameSentenceMiner/data_dir.json');
await fs.mkdir(path.dirname(pointer), {recursive: true});
await fs.writeFile(pointer, JSON.stringify({version: 2, dataDir: active}), {flag: 'wx'});
await fs.mkdir(path.join(active, 'electron'), {recursive: true});
const prefs = {pullPreReleases: true, handoffFixture: 'retain'};
await fs.writeFile(path.join(active, 'electron/config.json'), JSON.stringify(prefs));
const backup = path.join(active, 'backup/electron-handoff');
const db = new DatabaseSync(path.join(active, 'gsm.db'));
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE handoff_fixture(value TEXT); INSERT INTO handoff_fixture VALUES('committed WAL row')");
const dictionary = path.join(APPDATA, 'gsm_overlay/User Data/fixture-marker');
await fs.mkdir(path.dirname(dictionary), {recursive: true});
await fs.writeFile(dictionary, 'original profile');

async function exited(child) {
  const [code, signal] = await once(child, 'exit');
  return {code, signal};
}
function consent(choice) {
  return exited(spawn('pwsh', ['-NoProfile', '-File', path.join(import.meta.dirname, 'consent.ps1'), choice],
    {stdio: 'inherit', windowsHide: true})).then(({code}) => assert.equal(code, 0));
}
const declined = await Promise.all([
  exited(spawn(installer, ['/S'], {windowsHide: true})),
  consent('No'),
]);
assert.notEqual(declined[0].code, 0);
assert.equal(await fs.stat(backup).catch(() => null), null);
await fs.access(electron);

const bytes = await fs.readFile(installer);
const filename = path.basename(installer);
const sha512 = createHash('sha512').update(bytes).digest('base64');
const metadata = {version, path: filename, sha512, files: [{url: filename, sha512, size: bytes.length}],
  releaseDate: new Date().toISOString()};
const requests = new Set();
const server = createServer((req, res) => {
  const resource = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1));
  requests.add(resource);
  if (['latest.yml', 'beta.yml'].includes(resource)) {
    res.end(JSON.stringify(metadata));
  } else if (resource === filename) {
    res.writeHead(200, {'content-length': bytes.length});
    createReadStream(installer).pipe(res);
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
try {
  const app = await _electron.launch({executablePath: electron, args: [], timeout: 90000});
  const appClosed = once(app.process(), 'exit');
  // The shipping client hardcodes GitHub in setFeedURL on every check. Redirect only
  // that provider in this process. Preserve the signed application files on disk.
  const installedVersion = await app.evaluate(({app}, url => url).catch(() => {}));
} finally {
  server.close();
}
