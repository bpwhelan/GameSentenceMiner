import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, existsSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

// The optional Qt dialogs must match the desktop even when PyPI has a
// different build of the same version. Normal desktop starts never open it.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'build', 'desktop-qt');
await fs.mkdir(output, {recursive: true});
const staging = await fs.mkdtemp(path.join(output, 'build-'));
try {
  const venv = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const result = spawnSync(existsSync(venv) ? venv : 'python', [
    '-m', 'pip', 'wheel', '--disable-pip-version-check', '--no-deps', '--wheel-dir', staging, '.',
  ], {cwd: root, stdio: 'inherit', windowsHide: true});
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error('Could not build the Qt dialog package');
  const wheels = (await fs.readdir(staging)).filter(name => name.endsWith('.whl'));
  if (wheels.length !== 1) throw Error('Expected one Qt dialog package');
  const [fileName] = wheels;
  const wheel = path.join(staging, fileName);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(wheel)) digest.update(chunk);
  const sha256 = digest.digest('hex');
  const directory = path.join(output, sha256);
  await fs.mkdir(directory, {recursive: true});
  await fs.rename(wheel, path.join(directory, fileName));
  const manifest = path.join(staging, 'qt-host.json');
  await fs.writeFile(manifest, JSON.stringify({backendWheel: {fileName, sha256}}));
  await fs.rename(manifest, path.join(output, 'qt-host.json'));
} finally {
  await fs.rm(staging, {recursive: true, force: true});
}
