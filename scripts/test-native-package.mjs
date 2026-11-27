import {existsSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {nativeTargetDirectory} from './native-paths.mjs';

const root = path.resolve(import.meta.dirname, '..');
const releaseDir = path.join(await nativeTargetDirectory(), 'release');

// Keep application resources outside the checkout so its dependencies cannot fill
// gaps in a package. macOS also needs the shipped Info.plist and Frameworks layout.
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-packaged-check-'));
let executable;
let app;
if (process.platform === 'darwin') {
  const config = JSON.parse(await fs.readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const name = `${config.productName}.app`;
  const bundle = path.join(fixture, name);
  execFileSync('/usr/bin/ditto', [path.join(releaseDir, 'bundle/macos', name), bundle]);
  const contents = path.join(bundle, 'Contents');
  const binary = execFileSync('/usr/bin/plutil', [
    '-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(contents, 'Info.plist'),
  ], {encoding: 'utf8'}).trim();
  executable = path.join(contents, 'MacOS', binary);
  app = path.join(contents, 'Resources', 'app');
} else {
  const binary = process.platform === 'win32' ? 'gsm-desktop.exe' : 'gsm-desktop';
  executable = path.join(fixture, binary);
  await fs.copyFile(path.join(releaseDir, binary), executable);
  if (process.platform === 'win32') {
    for (const entry of await fs.readdir(releaseDir)) {
      if (entry.endsWith('.dll')) await fs.copyFile(path.join(releaseDir, entry), path.join(fixture, entry));
    }
  } else {
    await fs.chmod(executable, 0o755);
  }
  app = path.join(fixture, 'app');
  await fs.cp(path.join(root, 'build/native-desktop/app'), app, {recursive: true});
}
await fs.access(path.join(app, 'dist/renderer/index.html'));
for (const forbidden of ['runtime', 'node_modules', 'desktop-runtime', 'dist/main', 'dist/shared']) {
  if (existsSync(path.join(app, forbidden))) {
    throw Error(`Forbidden Node/JS runtime directory found in staged app: ${forbidden}`);
  }
}

const requested = process.argv.slice(2);
const scenarios = requested.includes('--all') ? [] : requested.length ? requested :
  ['windows', 'workspace', 'settings', 'yomitan', 'hachidori', 'overlay'];
const env = {
  ...process.env,
  GSM_NATIVE_TEST_EXECUTABLE: executable,
  GSM_SMOKE_APP_DIR: app,
  PATH: process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') : '/usr/bin:/bin',
};
for (const name of [
  'GSM_NODE_EXECUTABLE', 'GSM_NATIVE_DEPS', 'GSM_TEST_SERVICE', 'ELECTRON_RUN_AS_NODE', 'NODE_PATH',
  'GSM_SMOKE_RENDERER_DIR', 'VITE_DEV_SERVER_URL', 'GSM_INPUT_SERVER_URL',
]) {
  delete env[name];
}
if (process.platform === 'darwin') delete env.DYLD_LIBRARY_PATH;
console.log('Testing packaged application outside the checkout:', fixture);
execFileSync(process.execPath, [path.join(root, 'scripts/check-native-desktop.mjs'), ...scenarios], {
  cwd: app, env, stdio: 'inherit', windowsHide: true,
});
