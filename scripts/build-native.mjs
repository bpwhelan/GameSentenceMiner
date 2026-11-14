import childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

export function buildNative(root = repositoryRoot, platform = process.platform) {
  // npm does not activate the checkout's virtual environment. A bare "python"
  // can resolve to an unrelated application's Python, even when .venv exists.
  const venvPython = path.join(root, '.venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const python = existsSync(venvPython) ? venvPython : 'python';
  console.log(`Building native Python modules with ${python}`);
  const result = childProcess.spawnSync(
    python,
    ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', '-e', '.'],
    { cwd: root, stdio: 'inherit', windowsHide: true }
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = buildNative();
}
