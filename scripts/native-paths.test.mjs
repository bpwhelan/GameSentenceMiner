import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {localBuildProfile, nativeTargetDirectory, pruneAgentRuntimeArchives, pruneDesktopRuns} from './native-paths.mjs';

async function fixture(t, configured = true) {
  // Cargo uses the physical working directory, including when macOS TMPDIR is under /var.
  const projectRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'gsm cargo paths-'));
  t.after(() => fs.rm(projectRoot, {recursive: true, force: true}));
  await fs.mkdir(path.join(projectRoot, 'src-tauri/src'), {recursive: true});
  await fs.writeFile(path.join(projectRoot, 'src-tauri/src/main.rs'), 'fn main() {}');
  await fs.writeFile(path.join(projectRoot, 'src-tauri/Cargo.toml'), '[package]\nname = "path-fixture"\nversion = "0.1.0"\nedition = "2021"\n');
  if (configured) {
    await fs.mkdir(path.join(projectRoot, '.cargo'));
    await fs.writeFile(path.join(projectRoot, '.cargo/config.toml'), '[build]\ntarget-dir = "src-tauri/target/native-dev"\n');
  }
  const env = {...process.env};
  delete env.CARGO_TARGET_DIR;
  delete env.CARGO_BUILD_TARGET_DIR;
  return {projectRoot, env};
}

test('finds the configured Cargo output instead of an older default directory', async t => {
  const options = await fixture(t);
  await fs.mkdir(path.join(options.projectRoot, 'src-tauri/target/release/bundle/nsis'), {recursive: true});
  await fs.writeFile(path.join(options.projectRoot, 'src-tauri/target/release/bundle/nsis/old.exe'), 'stale');
  assert.equal(await nativeTargetDirectory(options), path.join(options.projectRoot, 'src-tauri/target/native-dev'));
});

test('honors absolute and relative CARGO_TARGET_DIR overrides', async t => {
  const options = await fixture(t);
  for (const override of [path.join(options.projectRoot, 'custom output'), 'relative output']) {
    assert.equal(await nativeTargetDirectory({...options, env: {...options.env, CARGO_TARGET_DIR: override}}), path.resolve(options.projectRoot, override));
  }
});

test('uses Cargo default output when no override is configured', async t => {
  const options = await fixture(t, false);
  assert.equal(await nativeTargetDirectory(options), path.join(options.projectRoot, 'src-tauri/target'));
});

test('resolves the audio helper target using its own manifest and the Cargo override', async t => {
  const options = await fixture(t, false);
  const helper = path.join(options.projectRoot, 'native', 'windows-audio-capture');
  await fs.mkdir(path.dirname(helper), {recursive: true});
  await fs.rename(path.join(options.projectRoot, 'src-tauri'), helper);
  const manifest = path.join(helper, 'Cargo.toml');
  assert.equal(await nativeTargetDirectory({...options, manifest}), path.join(helper, 'target'));
  const override = path.join(options.projectRoot, 'shared output');
  assert.equal(await nativeTargetDirectory({...options, manifest, env: {...options.env, CARGO_TARGET_DIR: override}}), override);
});

test('local builds keep using the last successful profile unless explicitly overridden', async t => {
  const {projectRoot} = await fixture(t);
  const pointer = path.join(projectRoot, 'launch.json');
  assert.equal(localBuildProfile([], pointer), 'debug');
  await fs.writeFile(pointer, JSON.stringify({executable: 'previous-build'}));
  assert.equal(localBuildProfile([], pointer), 'debug');
  assert.equal(localBuildProfile(['--release'], pointer), 'release');
  await fs.writeFile(pointer, JSON.stringify({profile: 'release'}));
  assert.equal(localBuildProfile([], pointer), 'release');
  assert.equal(localBuildProfile(['--debug'], pointer), 'debug');
  assert.throws(() => localBuildProfile(['--release', '--debug'], pointer));
});

test('pruneDesktopRuns preserves active, stable helper source, and recent fallback while removing older snapshots', async t => {
  const {projectRoot} = await fixture(t, false);
  const runsDir = path.join(projectRoot, 'desktop-runs');
  await fs.mkdir(runsDir, {recursive: true});
  const makeSnap = async (hex, ageMs) => {
    const name = `win32-x64-${hex}`;
    const dir = path.join(runsDir, name);
    await fs.mkdir(dir, {recursive: true});
    await fs.writeFile(path.join(dir, 'gsm-desktop.exe'), 'bin');
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(dir, when, when);
    return {name, dir};
  };
  const oldest = await makeSnap('11111111111111111111', 50_000);
  const older = await makeSnap('22222222222222222222', 40_000);
  const currentSource = await makeSnap('33333333333333333333', 30_000);
  const fallback = await makeSnap('44444444444444444444', 20_000);
  const active = await makeSnap('55555555555555555555', 10_000);

  await fs.writeFile(
    path.join(runsDir, 'win32-x64.json'),
    JSON.stringify({executable: path.join(active.dir, 'gsm-desktop.exe')}),
  );
  await fs.mkdir(path.join(runsDir, 'win32-x64-current'), {recursive: true});
  await fs.writeFile(path.join(runsDir, 'win32-x64-current', 'build-source.txt'), currentSource.dir);

  const {removed} = await pruneDesktopRuns(runsDir, {keepRecent: 1, platform: 'win32', arch: 'x64'});
  assert.deepEqual(removed.sort(), [oldest.name, older.name].sort());
  for (const name of [currentSource.name, fallback.name, active.name, 'win32-x64-current']) {
    assert.ok((await fs.stat(path.join(runsDir, name))).isDirectory());
  }
});

test('pruneAgentRuntimeArchives removes older runtime zips and keeps the active one', async t => {
  const {projectRoot} = await fixture(t, false);
  const runtimeDir = path.join(projectRoot, 'runtime');
  await fs.mkdir(runtimeDir, {recursive: true});
  await fs.writeFile(path.join(runtimeDir, 'gsm-agent-runtime-win32-x64-old.zip'), 'old');
  await fs.writeFile(path.join(runtimeDir, 'gsm-agent-runtime-win32-x64-new.zip'), 'new');
  await fs.writeFile(path.join(runtimeDir, 'agent-runtime.json'), '{}');

  await pruneAgentRuntimeArchives(runtimeDir, 'gsm-agent-runtime-win32-x64-new.zip');
  const remaining = (await fs.readdir(runtimeDir)).sort();
  assert.deepEqual(remaining, ['agent-runtime.json', 'gsm-agent-runtime-win32-x64-new.zip']);
});
