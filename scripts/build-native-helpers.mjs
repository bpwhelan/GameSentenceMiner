// Build native helper executables without rebuilding the desktop or renderer.
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {nativeTargetDirectory, pruneAgentRuntimeArchives, root} from './native-paths.mjs';
import {packageAgentRuntime} from './package-agent-runtime.mjs';

export async function buildNativeHelpers(profile) {
  const inputTarget = await nativeTargetDirectory({manifest: 'GSM_Overlay/input_server/Cargo.toml'});
  const agentTarget = await nativeTargetDirectory({manifest: 'native/gsm-agent/Cargo.toml'});
  const agentFlags = profile === 'release' ? ['--release'] : [];
  for (const args of [
    ['build', '--locked', '--release', '--manifest-path', 'GSM_Overlay/input_server/Cargo.toml', '--target-dir', inputTarget],
    ['build', '--locked', ...agentFlags, '--manifest-path', 'native/gsm-agent/Cargo.toml', '--bin', 'gsm-agent-host', '--target-dir', agentTarget],
  ]) {
    await new Promise((resolve, reject) => {
      const child = spawn('cargo', args, {cwd: root, stdio: 'inherit', windowsHide: true});
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(Error(`Native helper build failed (${code})`)));
    });
  }

  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const agentName = process.platform === 'win32' ? 'gsm-agent-host.exe' : 'gsm-agent-host';
  const runtimeOutput = path.join(agentTarget, 'runtime');
  const {manifest, archive} = await packageAgentRuntime({
    executable: path.join(agentTarget, profile, agentName),
    output: runtimeOutput,
    version,
  });
  await pruneAgentRuntimeArchives(runtimeOutput, path.basename(archive));
  return {
    manifest: JSON.stringify(manifest, null, 2) + '\n',
    runtimeDirectory: runtimeOutput,
  };
}

// Tauri's watch-mode launcher uses the target directory directly.
if (import.meta.main) {
  const target = path.join(await nativeTargetDirectory(), 'debug');
  const {manifest, runtimeDirectory} = await buildNativeHelpers('debug');
  await fs.mkdir(target, {recursive: true});
  await fs.writeFile(path.join(target, 'agent-runtime.json'), manifest);
  await fs.writeFile(path.join(target, 'agent-runtime-dir.txt'), `${runtimeDirectory}\n`);
}
