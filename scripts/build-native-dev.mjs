import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {buildNativeHelpers} from './build-native-helpers.mjs';
import {root, launchDirectory, launchPointer, localBuildProfile, nativeTargetDirectory} from './native-paths.mjs';

// Run a copy so Windows can rebuild the Rust executable while GSM is open.
// The next graceful restart selects this completed build, never a partial one.
const profile = localBuildProfile(process.argv.slice(2));
const target = await nativeTargetDirectory();
const runtimeMetadata = await buildNativeHelpers(profile);
const flags = profile === 'release' ? ['--release', '--features', 'local-build'] : [];
await new Promise((resolve, reject) => {
  const child = spawn('cargo', ['build', '--locked', ...flags, '--manifest-path', 'src-tauri/Cargo.toml', '--target-dir', target], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(Error(`Native desktop build failed (${code})`)));
});
const basename = process.platform === 'win32' ? 'gsm-desktop.exe' : 'gsm-desktop';
const desktop = await fs.readFile(path.join(target, profile, basename));
const inputName = process.platform === 'win32' ? 'gsm_overlay_server.exe' : 'gsm_overlay_server';
const inputServer = await fs.readFile(path.join(root, 'GSM_Overlay/input_server/target/release', inputName));
const hash = crypto.createHash('sha256').update(desktop).update(runtimeMetadata).update(inputServer).digest('hex').slice(0, 20);
const directory = path.join(launchDirectory, `${process.platform}-${process.arch}-${hash}`);
const executable = path.join(directory, basename);
await fs.mkdir(launchDirectory, {recursive: true});
const staging = await fs.mkdtemp(path.join(launchDirectory, '.staging-'));
try {
  await fs.writeFile(path.join(staging, basename), desktop, {mode: 0o755});
  await fs.writeFile(path.join(staging, inputName), inputServer, {mode: 0o755});
  await fs.writeFile(path.join(staging, 'agent-runtime.json'), runtimeMetadata);
  try { await fs.rename(staging, directory); }
  catch (error) {
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
    // An identical build may already be staged, including from a concurrent build.
    for (const name of [basename, inputName, 'agent-runtime.json']) {
      if (!(await fs.stat(path.join(directory, name))).isFile()) throw error;
    }
  }
} finally {
  await fs.rm(staging, {recursive: true, force: true});
}
const temporary = `${launchPointer}.${process.pid}.tmp`;
await fs.writeFile(temporary, JSON.stringify({executable, hash, profile}));
await fs.rename(temporary, launchPointer);
console.log(`Native desktop (${profile}) is ready for the next launch.`);
