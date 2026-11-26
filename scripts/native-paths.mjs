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

// Keep immutable dev launch snapshots bounded so repeated local rebuilds never
// fill the drive while preserving the active launch record, the Windows stable
// launcher's helper source, and one recent fallback.
export async function pruneDesktopRuns(
  directory = launchDirectory,
  {keepNames = [], keepRecent = 1, platform = process.platform, arch = process.arch} = {},
) {
  const fsp = fs.promises;
  const entries = await fsp.readdir(directory, {withFileTypes: true}).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const prefix = `${platform}-${arch}-`;
  const snapshotPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[0-9a-f]{20}$`);
  const preserved = new Set(keepNames.filter(Boolean));

  const pointerPath = path.join(directory, `${platform}-${arch}.json`);
  try {
    const record = JSON.parse(await fsp.readFile(pointerPath, 'utf8'));
    if (typeof record?.executable === 'string') {
      preserved.add(path.basename(path.dirname(record.executable)));
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  const currentMarker = path.join(directory, `${prefix}current`, 'build-source.txt');
  try {
    const source = (await fsp.readFile(currentMarker, 'utf8')).trim();
    if (source) preserved.add(path.basename(source));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !snapshotPattern.test(entry.name) || preserved.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    const stat = await fsp.stat(fullPath).catch(() => null);
    if (stat) candidates.push({name: entry.name, fullPath, mtimeMs: stat.mtimeMs});
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const removed = [];
  const kept = [...preserved];
  for (const candidate of candidates.slice(0, Math.max(0, keepRecent))) kept.push(candidate.name);
  for (const candidate of candidates.slice(Math.max(0, keepRecent))) {
    try {
      await fsp.rm(candidate.fullPath, {recursive: true, force: true});
      removed.push(candidate.name);
    } catch (error) {
      // A running instance or detached helper may still hold a lock on Windows.
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error;
      kept.push(candidate.name);
    }
  }
  return {removed, kept};
}

export async function pruneAgentRuntimeArchives(directory, keepBasename) {
  const fsp = fs.promises;
  const entries = await fsp.readdir(directory, {withFileTypes: true}).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === keepBasename) continue;
    if (!/^gsm-agent-runtime-.*\.zip$/i.test(entry.name)) continue;
    try {
      await fsp.rm(path.join(directory, entry.name), {force: true});
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    }
  }
}
