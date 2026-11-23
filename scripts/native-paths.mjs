import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {parseArgs, promisify} from 'node:util';

export const root = path.resolve(import.meta.dirname, '..');
export const launchDirectory = path.join(root, 'src-tauri', 'target', 'desktop-runs');
export const launchPointer = path.join(launchDirectory, `${process.platform}-${process.arch}.json`);

export function localBuildProfile(args, pointer = launchPointer) {
  const {values} = parseArgs({args, options: {release: {type: 'boolean'}, debug: {type: 'boolean'}}});
  if (values.release && values.debug) throw Error('Choose either --release or --debug.');
  if (values.release) return 'release';
  if (values.debug) return 'debug';
  // Existing launch records predate profile selection and always point to debug.
  try {
    return JSON.parse(fs.readFileSync(pointer, 'utf8'))?.profile === 'release' ? 'release' : 'debug';
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return 'debug';
    throw error;
  }
}

// Cargo owns output-directory resolution, including .cargo/config.toml and
// environment overrides. Builders, collectors and package checks must agree.
export async function nativeTargetDirectory({projectRoot = root, manifest = 'src-tauri/Cargo.toml', env = process.env} = {}) {
  const {stdout} = await promisify(execFile)('cargo', [
    'metadata', '--no-deps', '--format-version', '1',
    '--manifest-path', path.resolve(projectRoot, manifest),
  ], {cwd: projectRoot, env, windowsHide: true, maxBuffer: 8 * 1024 * 1024});
  const target = JSON.parse(stdout).target_directory;
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw Error('Cargo did not report an absolute target directory');
  return path.normalize(target);
}

export function nativeExecutable() {
  if (process.env.GSM_NATIVE_TEST_EXECUTABLE) return path.resolve(process.env.GSM_NATIVE_TEST_EXECUTABLE);
  const record = JSON.parse(fs.readFileSync(launchPointer, 'utf8'));
  const filename = fs.realpathSync(record.executable);
  const relative = path.relative(fs.realpathSync(launchDirectory), filename);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(filename).isFile()) {
    throw Error('The native launch record is invalid. Run npm run build:tauri again.');
  }
  return filename;
}
