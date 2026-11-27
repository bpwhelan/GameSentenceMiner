import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {nativeTargetDirectory} from './native-paths.mjs';

const root=path.resolve(import.meta.dirname,'..');
const target=await nativeTargetDirectory();
const releaseDir=path.join(target,'release');
const builtExecutable=path.join(releaseDir,process.platform==='win32'?'gsm-desktop.exe':'gsm-desktop');
await fs.access(builtExecutable);

// Outside the checkout: a missing packaged dependency must not resolve from
// the developer's checkout. The executable and resources are release builds.
const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'gsm-packaged-check-'));
const executable=path.join(fixture,path.basename(builtExecutable));
await fs.copyFile(builtExecutable,executable);
if(process.platform==='win32') {
  for(const entry of await fs.readdir(releaseDir)) {
    if(entry.endsWith('.dll')) await fs.copyFile(path.join(releaseDir,entry),path.join(fixture,entry));
  }
} else {
  await fs.chmod(executable,0o755);
}
const app=path.join(fixture,'app');
await fs.cp(path.join(root,'build/native-desktop/app'),app,{recursive:true});
for(const forbidden of ['runtime','node_modules','desktop-runtime','dist/main','dist/shared']) {
  if(await fs.access(path.join(app,forbidden)).then(()=>true,()=>false)) {
    throw Error(`Forbidden Node/JS runtime directory found in staged app: ${forbidden}`);
  }
}
await fs.mkdir(path.join(app,'native/gsm-overlay/tests/fixtures'),{recursive:true});
await fs.copyFile(path.join(root,'native/gsm-overlay/tests/fixtures/dialogue.png'),path.join(app,'native/gsm-overlay/tests/fixtures/dialogue.png'));

const requested = process.argv.slice(2);
const scenarios = requested.includes('--all') ? [] : requested.length ? requested :
  ['windows', 'workspace', 'settings', 'yomitan', 'hachidori', 'overlay'];
const env = {
  ...process.env,
  GSM_NATIVE_TEST_EXECUTABLE: executable,
  GSM_SMOKE_APP_DIR: app,
  GSM_SMOKE_PARENT: fixture,
  PATH: process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') : '/usr/bin:/bin',
};
for (const name of ['GSM_NODE_EXECUTABLE', 'GSM_NATIVE_DEPS', 'GSM_TEST_SERVICE', 'ELECTRON_RUN_AS_NODE', 'NODE_PATH']) {
  delete env[name];
}
console.log('Testing packaged application outside the checkout:', fixture);
execFileSync(process.execPath, [path.join(root, 'scripts/check-native-desktop.mjs'), ...scenarios], {
  cwd: app, env, stdio: 'inherit', windowsHide: true,
});
