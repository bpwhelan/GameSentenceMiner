import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {localBuildProfile, nativeTargetDirectory} from './native-paths.mjs';

async function fixture(t, configured = true) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm cargo paths-'));
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
